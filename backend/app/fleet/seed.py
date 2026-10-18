"""Deterministic seed of the SIMULATED infrastructure (runs once on an empty database).

- One PROPOSED station (capacity HOSPITAL_STATION_CAPACITY) per imported hospital;
  a few spatially spread ones are enabled for the simulation and labelled DEMO.
- The existing Vistula depot (data/landing_stations.geojson, id st-depot) is kept,
  plus planned depots from app/fleet/planning.py (p-median over simulated demand).
- Drones per depot; demo restaurant partners (fictional agreements) with proposed pads.
- HOSPITAL_DRONES_PER_STATION simulated drones at every hospital station (`ensure_hospital_drones`,
  also run at every start), so medical orders use the hospital's own drone.

`sync_pois` runs at every start: new hospitals get a PROPOSED station; existing
simulated records are never deleted or overwritten by a POI re-import.
"""

from __future__ import annotations

import json
import math
import re

import numpy as np

from app.airspace.evaluation import FlightContext
from app.config import (
    DATA_DIR,
    DATA_FILES,
    DEMO_HOSPITAL_STATIONS_ENABLED,
    DEMO_RESTAURANT_PARTNERS,
    DEPOT_CAPACITY_STANDARD,
    DEPOT_TARGET_COUNT,
    DRONES_PER_HIGH_DEMAND_DEPOT,
    DRONES_PER_STANDARD_DEPOT,
    HOSPITAL_DRONES_PER_STATION,
    HOSPITAL_STATION_CAPACITY,
    MAP_CENTER,
    PAD_CAPACITY_DEFAULT,
)
from app.fleet.db import FleetDB, now_iso
from app.fleet.planning import candidate_sites, demand_points, plan_depots
from app.fleet.pois import Pois
from app.routing.grid import lonlat_to_xy
from app.routing.planner import RoutePlanner
from app.services.drone_profiles import DroneProfileRegistry

VISTULA_DEPOT_ID = "st-depot"
DEMO_HOSPITAL_NOTE = ("DEMO: enabled for the simulation only. The real hospital has not agreed to host drones and "
                      "no landing infrastructure is assumed.")
DEMO_PARTNER_NOTE = ("DEMO partner (fictional subscription). Pad = the mapped restaurant point, review required: "
                     "surface, clearance, ownership and permissions are not verified.")
HOSPITAL_DRONE_NOTE = ("SIMULATION: hospital-based drones for medical orders picked up here. The real hospital has "
                       "not agreed to host drones and no landing infrastructure is assumed.")
PLANNER_SOURCE = "SkyRoute depot planner (greedy p-median over simulated demand)"


def station_id(osm_id: str) -> str:
    return "hs-" + re.sub(r"[^a-z0-9]+", "-", osm_id.lower()).strip("-")


def pad_id(restaurant_id: str) -> str:
    return "pad-" + re.sub(r"[^a-z0-9]+", "-", restaurant_id.lower()).strip("-")


def _insert_facility(c, **f) -> None:
    now = now_iso()
    f.setdefault("occupied", 0)
    f.setdefault("reserved", 0)
    f.setdefault("operational_status", "OPEN")
    f.setdefault("created_at", now)
    f.setdefault("updated_at", now)
    cols = ", ".join(f)
    c.execute(f"INSERT INTO facilities ({cols}) VALUES ({', '.join('?' * len(f))})", tuple(f.values()))


def sync_pois(db: FleetDB, pois: Pois, capacity: int = HOSPITAL_STATION_CAPACITY) -> int:
    """Adds a PROPOSED station for every hospital without one. Returns the number added."""
    with db.tx() as c:  # profile ids were briefly stored as "_DRONE_0x"; the registry uses "DEMO_DRONE_0x"
        c.execute("UPDATE drones SET profile_id = 'DEMO' || profile_id WHERE profile_id LIKE '\\_DRONE\\_%' ESCAPE '\\'")
    existing = {r["ref_id"] for r in db.query("SELECT ref_id FROM facilities WHERE kind = 'HOSPITAL_STATION'")}
    added = 0
    with db.tx() as c:
        for h in pois.hospitals.items:
            if h.id in existing:
                continue
            _insert_facility(c, id=station_id(h.props["osmId"]), kind="HOSPITAL_STATION", ref_id=h.id,
                             name=f"Proposed drone station – {h.name or 'unnamed hospital'}",
                             latitude=h.latitude, longitude=h.longitude, district=h.district, capacity=capacity,
                             verification="PROPOSED", landing_method="UNKNOWN (site survey required)",
                             data_source="SkyRoute simulation (hospital location: OpenStreetMap)")
            added += 1
    return added


def ensure_hospital_drones(db: FleetDB, profiles: DroneProfileRegistry,
                           per_station: int = HOSPITAL_DRONES_PER_STATION) -> int:
    """Gives every hospital station without drones `per_station` simulated drones and enables it for the
    simulation. Runs at every start; stations that already host drones, or that an admin DISABLED, are left
    alone. Returns the number of drones added."""
    if per_station <= 0:
        return 0
    ids = profiles.ids
    pid = "DEMO_DRONE_02" if "DEMO_DRONE_02" in ids else (ids[0] if ids else "UNKNOWN")  # medical cargo box
    prof = profiles.get(pid)
    added = 0
    with db.tx() as c:
        n = c.execute("SELECT COUNT(*) AS n FROM drones WHERE id LIKE '%-hdrone-%'").fetchone()["n"]
        stations = c.execute(
            "SELECT * FROM facilities f WHERE f.kind = 'HOSPITAL_STATION' AND f.verification != 'DISABLED' "
            "AND NOT EXISTS (SELECT 1 FROM drones d WHERE d.home_depot_id = f.id) ORDER BY f.id").fetchall()
        for f in stations:
            # The drones get their own docks on top of the station's landing spaces for visiting drones.
            occupied = f["occupied"] + per_station
            capacity = f["capacity"] + per_station
            c.execute("UPDATE facilities SET verification = 'SIMULATION_ENABLED', capacity = ?, occupied = ?, "
                      "notes = ?, updated_at = ? WHERE id = ?", (capacity, occupied, HOSPITAL_DRONE_NOTE, now_iso(), f["id"]))
            for _ in range(per_station):
                n += 1
                c.execute("INSERT INTO drones (id, name, profile_id, status, home_depot_id, current_facility_id, "
                          "battery_pct, max_range_m, current_order_id, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
                          (f"{f['id']}-hdrone-{n}", f"SR-H{n:03d}", pid, "AVAILABLE", f["id"], f["id"], 100.0,
                           (prof.max_range_km if prof else 10.0) * 1000, None, now_iso()))
                added += 1
    return added


def _vistula_depot() -> dict | None:
    path = DATA_DIR / DATA_FILES["stations"]
    if not path.is_file():
        return None
    for f in json.loads(path.read_text(encoding="utf-8"))["features"]:
        p = f["properties"]
        if p["id"] == VISTULA_DEPOT_ID or p.get("station_type") == "DEPOT":
            lon, lat = f["geometry"]["coordinates"]
            return {"id": p["id"], "name": p["name"], "lat": lat, "lon": lon, "capacity": int(p.get("capacity", 6))}
    return None


def _spread(points: list, k: int, start_xy: tuple[float, float]) -> list:
    """Deterministic farthest-point sampling (spatially spread demo selection)."""
    if not points:
        return []
    xy = np.array([lonlat_to_xy(p.longitude, p.latitude) for p in points])
    first = int(np.argmin(np.hypot(xy[:, 0] - start_xy[0], xy[:, 1] - start_xy[1])))
    chosen = [first]
    d = np.hypot(xy[:, 0] - xy[first, 0], xy[:, 1] - xy[first, 1])
    while len(chosen) < min(k, len(points)):
        j = int(np.argmax(d))
        chosen.append(j)
        d = np.minimum(d, np.hypot(xy[:, 0] - xy[j, 0], xy[:, 1] - xy[j, 1]))
    return [points[i] for i in chosen]


def seed(db: FleetDB, pois: Pois, planner: RoutePlanner, profiles: DroneProfileRegistry,
         demo_hospitals: int = DEMO_HOSPITAL_STATIONS_ENABLED, partners: int = DEMO_RESTAURANT_PARTNERS,
         hospital_drones: int = HOSPITAL_DRONES_PER_STATION) -> dict:
    if db.meta("seeded_at"):
        added = sync_pois(db, pois)
        return {"seeded": False, "hospitalStationsAdded": added,
                "hospitalDronesAdded": ensure_hospital_drones(db, profiles, hospital_drones)}
    sync_pois(db, pois)
    centre = lonlat_to_xy(MAP_CENTER[1], MAP_CENTER[0])

    # Demo hospital stations: named hospitals with a mapped campus, spread over the city.
    named = sorted((h for h in pois.hospitals.items if h.name and h.props.get("completeness", {}).get("hasFootprint")),
                   key=lambda h: h.id)
    demo_hospitals = _spread(named, demo_hospitals, centre)

    # Depots: keep the existing Vistula depot, plan the rest.
    fixed = []
    vistula = _vistula_depot()
    if vistula:
        fixed.append((vistula["id"], vistula["lon"], vistula["lat"]))
    state = planner.airspace.refresh()
    from datetime import datetime, timezone
    ctx = FlightContext(altitude_agl_m=80, at=datetime.now(timezone.utc))
    evals = state.evaluations(ctx)
    obstacle_cells = np.concatenate([state.cells[i] for i, e in enumerate(evals) if e.is_obstacle]) \
        if any(e.is_obstacle for e in evals) else np.array([], dtype=np.int64)
    demand = demand_points(pois, planner.coverage)
    candidates = candidate_sites(planner.coverage, planner.grid, obstacle_cells)
    plan = plan_depots(demand, candidates, fixed, DEPOT_TARGET_COUNT, planner.coverage)

    profile_ids = sorted(profiles.ids, reverse=True)  # delivery profile first when present
    drone_no = 0
    with db.tx() as c:
        for h in demo_hospitals:
            c.execute("UPDATE facilities SET verification = 'SIMULATION_ENABLED', notes = ?, updated_at = ? "
                      "WHERE kind = 'HOSPITAL_STATION' AND ref_id = ?", (DEMO_HOSPITAL_NOTE, now_iso(), h.id))
        n_planned = 0
        for s in plan.sites:
            if s.fixed:
                fid, name, cap, dtype = vistula["id"], vistula["name"], vistula["capacity"], "STANDARD"
                source = "Existing SkyRoute sample station (data/landing_stations.geojson), preserved"
            else:
                n_planned += 1
                fid = f"depot-{n_planned:02d}"
                name = f"Proposed depot {n_planned:02d} – {s.district or 'Warsaw'}"
                cap, dtype, source = s.capacity, s.depot_type, PLANNER_SOURCE
            n_drones = min(cap, DRONES_PER_HIGH_DEMAND_DEPOT if dtype == "HIGH_DEMAND" else DRONES_PER_STANDARD_DEPOT)
            _insert_facility(c, id=fid, kind="DEPOT", ref_id=None, name=name, latitude=s.latitude,
                             longitude=s.longitude, district=s.district, capacity=cap, occupied=n_drones,
                             verification="SIMULATION_ENABLED", depot_type=dtype, landing_method="DEPOT_DOCKS_SIMULATED",
                             data_source=source, demand_score=s.demand,
                             notes="SIMULATED planning site; physical and legal suitability not verified.")
            for _ in range(n_drones):
                drone_no += 1
                pid = profile_ids[drone_no % len(profile_ids)] if profile_ids else "UNKNOWN"
                prof = profiles.get(pid)
                c.execute("INSERT INTO drones (id, name, profile_id, status, home_depot_id, current_facility_id, "
                          "battery_pct, max_range_m, current_order_id, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
                          (f"drone-{drone_no:03d}", f"SR-{drone_no:03d}", pid, "AVAILABLE", fid, fid, 100.0,
                           (prof.max_range_km if prof else 10.0) * 1000, None, now_iso()))

        # Demo restaurant partners: the nearest named restaurant with an address to each busiest depot.
        chosen: set[str] = set()
        busiest = sorted(plan.sites, key=lambda s: -s.demand)
        restaurants = [r for r in pois.restaurants.items if r.name and r.props.get("address")]
        for s in busiest:
            if len(chosen) >= partners or not restaurants:
                break
            sx, sy = lonlat_to_xy(s.longitude, s.latitude)
            best = min((r for r in restaurants if r.id not in chosen),
                       key=lambda r: math.hypot(*(np.subtract(lonlat_to_xy(r.longitude, r.latitude), (sx, sy)))),
                       default=None)
            if best is None:
                break
            chosen.add(best.id)
            c.execute("INSERT INTO subscriptions (restaurant_id, status, demo, updated_at) VALUES (?, 'ACTIVE', 1, ?)",
                      (best.id, now_iso()))
            _insert_facility(c, id=pad_id(best.id), kind="RESTAURANT_PAD", ref_id=best.id,
                             name=f"Proposed pickup pad – {best.name}", latitude=best.latitude,
                             longitude=best.longitude, district=best.district, capacity=PAD_CAPACITY_DEFAULT,
                             verification="SIMULATION_ENABLED", landing_method="GROUND_PAD_PROPOSED",
                             data_source="SkyRoute simulation (restaurant location: OpenStreetMap)",
                             notes=DEMO_PARTNER_NOTE)
        info = {"seededAt": now_iso(), "planCoveredPct": plan.covered_pct, "planMeanDistanceM": plan.mean_distance_m,
                "planCandidates": plan.candidates, "planDemandTotal": plan.demand_total,
                "assumptions": plan.assumptions, "depots": len(plan.sites), "drones": drone_no,
                "demoHospitalStations": len(demo_hospitals), "demoPartners": len(chosen)}
        c.execute("INSERT INTO meta (key, value) VALUES ('seeded_at', ?)", (info["seededAt"],))
        c.execute("INSERT INTO meta (key, value) VALUES ('plan', ?)", (json.dumps(info),))
    info["hospitalDronesAdded"] = ensure_hospital_drones(db, profiles, hospital_drones)
    return {"seeded": True, **info}


