"""Fleet simulation: facilities and capacity, subscriptions, pads, drones, orders, assignment.

Capacity rule (per facility): available = capacity - occupied - reserved, never
negative; the database CHECKs enforce occupied + reserved <= capacity, and every
reservation is a conditional UPDATE inside one transaction.

Parking rules for a delivery (home depot H, optional pickup facility P, optional
destination facility D):
  assign       drone RESERVED; P and D: reserved += 1 (atomic with the drone)
  depart       drone IN_FLIGHT; H: occupied -= 1, reserved += 1 (its return space stays held)
  at pickup    drone LOADING; P: reserved -> occupied
  leave pickup drone DELIVERING; P: occupied -= 1
  delivered    D: reserved -> occupied (if landing at a facility)
  return       drone RETURNING; D: occupied -= 1
  home         drone CHARGING; H: reserved -> occupied; battery reduced by the distance flown
Nothing here commands a real drone.
"""

from __future__ import annotations

import json
import math
import uuid
from datetime import datetime, timezone
from typing import Any

from app.airspace.evaluation import FlightContext, evaluate
from app.airspace.status import VERIFICATION_TEXT, SourceState, airspace_status
from app.config import (
    ASSIGNMENT_CANDIDATES,
    DRONE_MIN_BATTERY_PCT,
    DRONE_RANGE_RESERVE_PCT,
    PAD_MAX_DISTANCE_FROM_FACILITY_M,
)
from app.fleet import planning
from app.fleet.db import FleetDB, now_iso
from app.fleet.models import (
    DISPATCH_ENABLED,
    AssignmentCandidate,
    AssignmentResult,
    DepotCreate,
    Drone,
    DroneStatus,
    Facility,
    FacilityKind,
    FacilityPatch,
    MEDICAL_ORDER_TYPES,
    Hospital,
    NearestHospital,
    Order,
    OrderCreate,
    OrderStatus,
    PadCheck,
    PadCreate,
    Page,
    Restaurant,
    RouteLeg,
    SubscriptionStatus,
    Verification,
)
from app.fleet.pois import Pois
from app.fleet.seed import pad_id
from app.routing.costs import FlightMode, RouteObjective
from app.routing.grid import lonlat_to_xy
from app.routing.planner import RoutePlanner
from app.schemas.planning import Coordinate, RouteStatus, WeatherInfo
from app.services.drone_profiles import DroneProfileRegistry

BUSY = {DroneStatus.RESERVED, DroneStatus.LOADING, DroneStatus.IN_FLIGHT, DroneStatus.DELIVERING, DroneStatus.RETURNING}
ACTIVE_ORDERS = {OrderStatus.ASSIGNED, OrderStatus.TO_PICKUP, OrderStatus.LOADING, OrderStatus.IN_DELIVERY,
                 OrderStatus.DELIVERED, OrderStatus.RETURNING}
NEXT_STATUS = {
    OrderStatus.ASSIGNED: OrderStatus.TO_PICKUP,
    OrderStatus.TO_PICKUP: OrderStatus.LOADING,
    OrderStatus.LOADING: OrderStatus.IN_DELIVERY,
    OrderStatus.IN_DELIVERY: OrderStatus.DELIVERED,
    OrderStatus.DELIVERED: OrderStatus.RETURNING,
    OrderStatus.RETURNING: OrderStatus.COMPLETED,
}
ENABLED_SQL = "('SIMULATION_ENABLED', 'VERIFIED_BY_OPERATOR')"
NOT_VERIFIABLE = [
    "surface stability", "adequate landing clearance", "people and obstacles at the site",
    "property owner permission", "local operational requirements", "technical suitability for the aircraft",
]


class FleetError(Exception):
    status_code = 400


class NotFound(FleetError):
    status_code = 404


class Conflict(FleetError):
    status_code = 409


class Invalid(FleetError):
    status_code = 422


def _dist_m(lat1, lon1, lat2, lon2) -> float:
    x1, y1 = lonlat_to_xy(lon1, lat1)
    x2, y2 = lonlat_to_xy(lon2, lat2)
    return math.hypot(x2 - x1, y2 - y1)


class FleetService:
    def __init__(self, db: FleetDB, pois: Pois, planner: RoutePlanner, profiles: DroneProfileRegistry):
        self.db = db
        self.pois = pois
        self.planner = planner
        self.profiles = profiles

    # --- facilities ----------------------------------------------------------------
    def _drone_counts(self) -> dict[str, tuple[int, int]]:
        rows = self.db.query("SELECT home_depot_id AS id, COUNT(*) AS n, SUM(status = 'AVAILABLE') AS a "
                             "FROM drones GROUP BY home_depot_id")
        return {r["id"]: (r["n"], r["a"] or 0) for r in rows}

    def _facility(self, r, counts: dict | None = None) -> Facility:
        n, a = (counts or {}).get(r["id"], (0, 0))
        verification = Verification(r["verification"])
        return Facility(
            id=r["id"], kind=r["kind"], ref_id=r["ref_id"], name=r["name"], latitude=r["latitude"],
            longitude=r["longitude"], district=r["district"], capacity=r["capacity"], occupied=r["occupied"],
            reserved=r["reserved"], available=max(0, r["capacity"] - r["occupied"] - r["reserved"]),
            verification=verification, operational_status=r["operational_status"],
            dispatch_enabled=verification in DISPATCH_ENABLED and r["operational_status"] == "OPEN",
            depot_type=r["depot_type"], landing_method=r["landing_method"], data_source=r["data_source"],
            demand_score=r["demand_score"], notes=r["notes"], assigned_drones=n, available_drones=a,
            updated_at=r["updated_at"],
        )

    def facilities(self, kind: FacilityKind | None = None, district: str | None = None) -> list[Facility]:
        sql, params = "SELECT * FROM facilities WHERE 1=1", []
        if kind:
            sql += " AND kind = ?"
            params.append(kind.value)
        if district:
            sql += " AND district = ?"
            params.append(district)
        counts = self._drone_counts()
        return [self._facility(r, counts) for r in self.db.query(sql + " ORDER BY id", params)]

    def facility(self, fid: str) -> Facility:
        r = self.db.one("SELECT * FROM facilities WHERE id = ?", (fid,))
        if r is None:
            raise NotFound(f"Facility '{fid}' not found.")
        return self._facility(r, self._drone_counts())

    def _facility_by_ref(self, kind: str, ref: str):
        return self.db.one("SELECT * FROM facilities WHERE kind = ? AND ref_id = ?", (kind, ref))

    # --- hospitals -----------------------------------------------------------------
    def _hospital(self, p, station) -> Hospital:
        pr = p.props
        return Hospital(id=p.id, osm_id=pr["osmId"], name=p.name, address=pr.get("address"), district=p.district,
                        latitude=p.latitude, longitude=p.longitude, website=pr.get("website"), phone=pr.get("phone"),
                        footprint=pr.get("footprint"), completeness=pr.get("completeness", {}),
                        merged_osm_ids=pr.get("mergedOsmIds", []), source=pr.get("source", "OpenStreetMap"),
                        imported_at=pr.get("importedAt"), station=station)

    def hospitals(self, bbox=None, district=None, offset=0, limit=500) -> Page[Hospital]:
        layer = self.pois.hospitals
        items = layer.query(bbox, district)
        counts = self._drone_counts()
        stations = {r["ref_id"]: self._facility(r, counts)
                    for r in self.db.query("SELECT * FROM facilities WHERE kind = 'HOSPITAL_STATION'")}
        page = items[offset: offset + limit]
        return Page[Hospital](total=len(items), offset=offset, limit=limit,
                              items=[self._hospital(p, stations.get(p.id)) for p in page],
                              source=layer.metadata.get("source"),
                              completeness_note=layer.metadata.get("completenessNote") or layer.message)

    def hospital(self, hid: str) -> Hospital:
        p = self.pois.hospitals.get(hid)
        if p is None:
            raise NotFound(f"Hospital '{hid}' not found.")
        r = self._facility_by_ref("HOSPITAL_STATION", hid)
        return self._hospital(p, self._facility(r, self._drone_counts()) if r else None)

    def nearest_hospital(self, lat: float, lon: float, altitude_m: int = 80) -> NearestHospital:
        """Closest mapped hospital (straight line) to a delivery address whose pickup point is
        inside Warsaw and not inside a blocked zone / planning constraint."""
        cov = self.planner.coverage
        counts = self._drone_counts()
        stations = {r["ref_id"]: self._facility(r, counts)
                    for r in self.db.query("SELECT * FROM facilities WHERE kind = 'HOSPITAL_STATION'")}
        best = None
        for p in sorted(self.pois.hospitals.query(None, None), key=lambda p: _dist_m(lat, lon, p.latitude, p.longitude)):
            st = stations.get(p.id)
            use_station = st is not None and st.dispatch_enabled
            plat, plon = (st.latitude, st.longitude) if use_station else (p.latitude, p.longitude)
            if not cov.contains(plon, plat) or self.check_point(plat, plon, altitude_m=altitude_m).obstacle_zones:
                continue
            best = (p, st, use_station, plat, plon)
            break
        if best is None:
            raise NotFound("No hospital with a reachable pickup point was found in Warsaw.")
        p, st, use_station, plat, plon = best
        note = (f"Pickup at the hospital's enabled drone station ({st.name})." if use_station else
                "Pickup at the hospital's mapped location (no enabled drone station there; simulated pickup).")
        return NearestHospital(hospital=self._hospital(p, st), distance_m=round(_dist_m(lat, lon, p.latitude, p.longitude), 1),
                               pickup=Coordinate(latitude=plat, longitude=plon),
                               pickup_facility_id=st.id if use_station else None, note=note)

    # --- restaurants & subscriptions --------------------------------------------------
    def _subscriptions(self) -> dict[str, Any]:
        return {r["restaurant_id"]: r for r in self.db.query("SELECT * FROM subscriptions")}

    def _restaurant(self, p, sub, pad) -> Restaurant:
        pr = p.props
        return Restaurant(id=p.id, osm_id=pr["osmId"], name=p.name, address=pr.get("address"), district=p.district,
                          latitude=p.latitude, longitude=p.longitude, cuisine=pr.get("cuisine"),
                          source=pr.get("source", "OpenStreetMap"), imported_at=pr.get("importedAt"),
                          subscription=SubscriptionStatus(sub["status"]) if sub else SubscriptionStatus.NOT_SUBSCRIBED,
                          demo_partner=bool(sub and sub["demo"]), pad=pad)

    def restaurants(self, bbox=None, district=None, subscription: SubscriptionStatus | None = None,
                    subscribed_only: bool = False, offset=0, limit=500) -> Page[Restaurant]:
        layer = self.pois.restaurants
        subs = self._subscriptions()
        ids = None
        if subscribed_only:
            ids = {k for k, v in subs.items() if v["status"] in ("ACTIVE", "TRIAL")}
        elif subscription and subscription != SubscriptionStatus.NOT_SUBSCRIBED:
            ids = {k for k, v in subs.items() if v["status"] == subscription.value}
        items = layer.query(bbox, district, ids)
        if subscription == SubscriptionStatus.NOT_SUBSCRIBED:
            items = [p for p in items if p.id not in subs or subs[p.id]["status"] == "NOT_SUBSCRIBED"]
        counts = self._drone_counts()
        pads = {r["ref_id"]: self._facility(r, counts)
                for r in self.db.query("SELECT * FROM facilities WHERE kind = 'RESTAURANT_PAD'")}
        page = items[offset: offset + limit]
        return Page[Restaurant](total=len(items), offset=offset, limit=limit,
                                items=[self._restaurant(p, subs.get(p.id), pads.get(p.id)) for p in page],
                                source=layer.metadata.get("source"),
                                completeness_note=layer.metadata.get("completenessNote") or layer.message)

    def restaurant(self, rid: str) -> Restaurant:
        p = self.pois.restaurants.get(rid)
        if p is None:
            raise NotFound(f"Restaurant '{rid}' not found.")
        pad = self._facility_by_ref("RESTAURANT_PAD", rid)
        return self._restaurant(p, self._subscriptions().get(rid), self._facility(pad, self._drone_counts()) if pad else None)

    def set_subscription(self, rid: str, status: SubscriptionStatus) -> Restaurant:
        """ACTIVE creates a PROPOSED pad (review required) if none exists; pad approval stays separate.
        SUSPENDED / NOT_SUBSCRIBED disable the pad for dispatch."""
        p = self.pois.restaurants.get(rid)
        if p is None:
            raise NotFound(f"Restaurant '{rid}' not found.")
        with self.db.tx() as c:
            c.execute("INSERT INTO subscriptions (restaurant_id, status, demo, updated_at) VALUES (?, ?, 0, ?) "
                      "ON CONFLICT(restaurant_id) DO UPDATE SET status = excluded.status, updated_at = excluded.updated_at",
                      (rid, status.value, now_iso()))
            pad = c.execute("SELECT * FROM facilities WHERE kind = 'RESTAURANT_PAD' AND ref_id = ?", (rid,)).fetchone()
            if status == SubscriptionStatus.ACTIVE and pad is None:
                self._insert_pad(c, p, p.latitude, p.longitude, 1, "GROUND_PAD_PROPOSED", Verification.REVIEW_REQUIRED)
            elif status in (SubscriptionStatus.SUSPENDED, SubscriptionStatus.NOT_SUBSCRIBED) and pad is not None:
                if pad["occupied"] or pad["reserved"]:
                    raise Conflict("The pad has drones parked or inbound; finish those orders first.")
                c.execute("UPDATE facilities SET verification = 'DISABLED', updated_at = ? WHERE id = ?",
                          (now_iso(), pad["id"]))
        return self.restaurant(rid)

    # --- pads ----------------------------------------------------------------------------
    def check_point(self, lat: float, lon: float, facility_lat: float | None = None,
                    facility_lon: float | None = None, altitude_m: int = 80) -> PadCheck:
        cov = self.planner.coverage
        inside = cov.contains(lon, lat)
        dist = _dist_m(lat, lon, facility_lat, facility_lon) if facility_lat is not None else None
        state = self.planner.airspace.refresh()
        from shapely.geometry import Point
        ctx = FlightContext(altitude_agl_m=altitude_m, at=datetime.now(timezone.utc))
        zones = [state.zones[i].name for i in state.zones_touching(Point(lonlat_to_xy(lon, lat)))
                 if evaluate(state.zones[i], ctx, endpoint=True).is_obstacle]
        g = self.planner.grid
        cell = g.cell_of(*lonlat_to_xy(lon, lat))
        on_building = known = None
        if cell is not None:
            unknown = bool(g.unknown_height[cell]) if g.unknown_height is not None else False
            on_building = unknown or bool(g.building_height[cell] > 0)
            known = None if not on_building else not unknown
        issues = []
        if not inside:
            issues.append("Outside the official Warsaw boundary.")
        if dist is not None and dist > PAD_MAX_DISTANCE_FROM_FACILITY_M:
            issues.append(f"{dist:.0f} m from the facility (limit {PAD_MAX_DISTANCE_FROM_FACILITY_M:.0f} m).")
        if zones:
            issues.append("Inside loaded blocked airspace: " + ", ".join(zones) + ".")
        if on_building:
            issues.append("On a mapped building footprint: a rooftop landing needs a structural and access survey"
                          + ("" if known else " (building height unknown)") + ".")
        if cell is None:
            issues.append("No building/terrain data at this point.")
        blocking = (not inside) or bool(zones) or (dist is not None and dist > PAD_MAX_DISTANCE_FROM_FACILITY_M)
        return PadCheck(inside_warsaw=inside, distance_from_facility_m=round(dist, 1) if dist is not None else None,
                        within_max_distance=dist is None or dist <= PAD_MAX_DISTANCE_FROM_FACILITY_M,
                        obstacle_zones=zones, on_mapped_building=on_building, building_height_known=known,
                        ok_for_simulation=not blocking, issues=issues, not_verifiable_from_map_data=NOT_VERIFIABLE)

    def _insert_pad(self, c, rest, lat, lon, capacity, method, verification: Verification) -> str:
        fid = pad_id(rest.id)
        now = now_iso()
        c.execute("INSERT INTO facilities (id, kind, ref_id, name, latitude, longitude, district, capacity, occupied, "
                  "reserved, verification, operational_status, depot_type, landing_method, data_source, demand_score, "
                  "notes, created_at, updated_at) VALUES (?, 'RESTAURANT_PAD', ?, ?, ?, ?, ?, ?, 0, 0, ?, 'OPEN', NULL, "
                  "?, ?, NULL, ?, ?, ?)",
                  (fid, rest.id, f"Proposed pickup pad – {rest.name or 'unnamed restaurant'}", lat, lon,
                   self.planner.coverage.district_of(lon, lat), capacity, verification.value, method,
                   "SkyRoute simulation (restaurant location: OpenStreetMap)",
                   "Proposed pad; not a legally authorized landing site.", now, now))
        return fid

    def create_pad(self, req: PadCreate) -> Facility:
        rest = self.pois.restaurants.get(req.restaurant_id)
        if rest is None:
            raise NotFound(f"Restaurant '{req.restaurant_id}' not found.")
        sub = self._subscriptions().get(rest.id)
        if not sub or sub["status"] not in ("ACTIVE", "TRIAL"):
            raise Conflict("Only a subscribed (ACTIVE or TRIAL) restaurant can have a proposed pad.")
        if self._facility_by_ref("RESTAURANT_PAD", rest.id):
            raise Conflict("This restaurant already has a pad; PATCH it instead.")
        lat, lon = (req.location.latitude, req.location.longitude) if req.location else (rest.latitude, rest.longitude)
        check = self.check_point(lat, lon, rest.latitude, rest.longitude)
        if not check.ok_for_simulation:
            raise Invalid("Pad location rejected: " + " ".join(check.issues))
        with self.db.tx() as c:
            fid = self._insert_pad(c, rest, lat, lon, req.capacity, req.landing_method, Verification.REVIEW_REQUIRED)
        return self.facility(fid)

    # --- depots ----------------------------------------------------------------------------
    def create_depot(self, req: DepotCreate) -> Facility:
        lat, lon = req.location.latitude, req.location.longitude
        check = self.check_point(lat, lon)
        if not check.ok_for_simulation:
            raise Invalid("Depot location rejected: " + " ".join(check.issues))
        for d in self.facilities(FacilityKind.DEPOT):
            if _dist_m(lat, lon, d.latitude, d.longitude) < 300:
                raise Conflict(f"Depot '{d.name}' already occupies this location (within 300 m).")
        n = 1 + len(self.db.query("SELECT id FROM facilities WHERE kind = 'DEPOT' AND id LIKE 'depot-%'"))
        fid = f"depot-{n:02d}"
        while self.db.one("SELECT 1 FROM facilities WHERE id = ?", (fid,)):
            n += 1
            fid = f"depot-{n:02d}"
        now = now_iso()
        with self.db.tx() as c:
            c.execute("INSERT INTO facilities (id, kind, ref_id, name, latitude, longitude, district, capacity, occupied, "
                      "reserved, verification, operational_status, depot_type, landing_method, data_source, demand_score, "
                      "notes, created_at, updated_at) VALUES (?, 'DEPOT', NULL, ?, ?, ?, ?, ?, 0, 0, ?, 'OPEN', ?, "
                      "'DEPOT_DOCKS_SIMULATED', 'Operator-added simulated depot', NULL, ?, ?, ?)",
                      (fid, req.name, lat, lon, self.planner.coverage.district_of(lon, lat), req.capacity,
                       req.verification.value, req.depot_type.value, req.notes, now, now))
        return self.facility(fid)

    def patch_facility(self, fid: str, req: FacilityPatch, kind: FacilityKind | None = None) -> Facility:
        r = self.db.one("SELECT * FROM facilities WHERE id = ?", (fid,))
        if r is None or (kind and r["kind"] != kind.value):
            raise NotFound(f"{kind.value.title() if kind else 'Facility'} '{fid}' not found.")
        sets, params = [], []
        if req.capacity is not None:
            if r["kind"] == "RESTAURANT_PAD" and not 1 <= req.capacity <= 2:
                raise Invalid("Pad capacity must be 1 or 2.")
            if req.capacity < r["occupied"] + r["reserved"]:
                raise Conflict(f"Capacity {req.capacity} is below the {r['occupied']} occupied + {r['reserved']} "
                               "reserved spaces.")
            sets.append("capacity = ?")
            params.append(req.capacity)
        if req.location is not None:
            ref = self.pois.restaurants.get(r["ref_id"]) or self.pois.hospitals.get(r["ref_id"]) if r["ref_id"] else None
            check = self.check_point(req.location.latitude, req.location.longitude,
                                     ref.latitude if ref else None, ref.longitude if ref else None)
            if not check.ok_for_simulation:
                raise Invalid("Location rejected: " + " ".join(check.issues))
            if r["occupied"] or r["reserved"]:
                raise Conflict("Cannot move a facility with drones parked or inbound.")
            sets += ["latitude = ?", "longitude = ?", "district = ?"]
            params += [req.location.latitude, req.location.longitude,
                       self.planner.coverage.district_of(req.location.longitude, req.location.latitude)]
        for field_, col in (("name", "name"), ("notes", "notes")):
            v = getattr(req, field_)
            if v is not None:
                sets.append(f"{col} = ?")
                params.append(v)
        for field_ in ("verification", "operational_status", "depot_type"):
            v = getattr(req, field_)
            if v is not None:
                if field_ == "depot_type" and r["kind"] != "DEPOT":
                    raise Invalid("depotType applies to depots only.")
                sets.append(f"{field_} = ?")
                params.append(v.value)
        if not sets:
            return self.facility(fid)
        with self.db.tx() as c:
            c.execute(f"UPDATE facilities SET {', '.join(sets)}, updated_at = ? WHERE id = ?", (*params, now_iso(), fid))
        return self.facility(fid)

    # --- drones --------------------------------------------------------------------------------
    def _drone(self, r, fac: dict) -> Drone:
        f = fac.get(r["current_facility_id"])
        return Drone(id=r["id"], name=r["name"], drone_profile_id=r["profile_id"], status=r["status"],
                     home_depot_id=r["home_depot_id"], current_facility_id=r["current_facility_id"],
                     battery_percent=round(r["battery_pct"], 1), maximum_range_meters=r["max_range_m"],
                     available=r["status"] == "AVAILABLE", current_order_id=r["current_order_id"],
                     latitude=f["latitude"] if f else None, longitude=f["longitude"] if f else None,
                     last_updated=r["updated_at"])

    def drones(self, status: DroneStatus | None = None, depot_id: str | None = None) -> list[Drone]:
        sql, params = "SELECT * FROM drones WHERE 1=1", []
        if status:
            sql += " AND status = ?"
            params.append(status.value)
        if depot_id:
            sql += " AND home_depot_id = ?"
            params.append(depot_id)
        fac = {r["id"]: r for r in self.db.query("SELECT id, latitude, longitude FROM facilities")}
        return [self._drone(r, fac) for r in self.db.query(sql + " ORDER BY id", params)]

    def drone(self, did: str) -> Drone:
        found = [d for d in self.drones() if d.id == did]
        if not found:
            raise NotFound(f"Drone '{did}' not found.")
        return found[0]

    def finish_charging(self, did: str) -> Drone:
        with self.db.tx() as c:
            n = c.execute("UPDATE drones SET status = 'AVAILABLE', battery_pct = 100, updated_at = ? "
                          "WHERE id = ? AND status = 'CHARGING'", (now_iso(), did)).rowcount
        if n != 1:
            raise Conflict(f"Drone '{did}' is not charging.")
        return self.drone(did)

    # --- summary & demand ----------------------------------------------------------------------
    def summary(self, district: str | None = None) -> dict:
        fac = self.facilities(district=district)
        drones = self.drones()
        if district:
            depots = {f.id for f in fac if f.kind == FacilityKind.DEPOT}
            drones = [d for d in drones if d.home_depot_id in depots]
        subs = self._subscriptions()
        rests = self.pois.restaurants.query(district=district)
        sub_ids = {p.id for p in rests if p.id in subs and subs[p.id]["status"] in ("ACTIVE", "TRIAL")}
        orders = self.db.query("SELECT status, dest_facility_id, pickup_facility_id FROM orders")

        def by_kind(kind):
            fs = [f for f in fac if f.kind == kind and f.dispatch_enabled]
            cap = sum(f.capacity for f in fs)
            occ = sum(f.occupied for f in fs)
            res = sum(f.reserved for f in fs)
            return {"facilities": len(fs), "capacity": cap, "occupied": occ, "reserved": res,
                    "available": sum(f.available for f in fs), "utilization": round((occ + res) / cap, 3) if cap else 0.0}

        status_counts = {s.value: 0 for s in DroneStatus}
        for d in drones:
            status_counts[d.status.value] += 1
        enabled = [f for f in fac if f.dispatch_enabled]
        return {
            "district": district,
            "mappedHospitals": len(self.pois.hospitals.query(district=district)),
            "hospitalStationsEnabled": sum(1 for f in fac if f.kind == FacilityKind.HOSPITAL_STATION and f.dispatch_enabled),
            "hospitalStationsProposed": sum(1 for f in fac if f.kind == FacilityKind.HOSPITAL_STATION),
            "depots": sum(1 for f in fac if f.kind == FacilityKind.DEPOT),
            "depotsEnabled": sum(1 for f in fac if f.kind == FacilityKind.DEPOT and f.dispatch_enabled),
            "depotCapacity": sum(f.capacity for f in fac if f.kind == FacilityKind.DEPOT),
            "drones": len(drones),
            "availableDrones": status_counts["AVAILABLE"],
            "busyDrones": sum(status_counts[s.value] for s in BUSY),
            "chargingDrones": status_counts["CHARGING"],
            "droneStatus": status_counts,
            "mappedRestaurants": len(rests),
            "subscribedRestaurants": len(sub_ids),
            "activePads": sum(1 for f in fac if f.kind == FacilityKind.RESTAURANT_PAD and f.dispatch_enabled),
            "occupiedSpaces": sum(f.occupied for f in enabled),
            "reservedSpaces": sum(f.reserved for f in enabled),
            "availableSpaces": sum(f.available for f in enabled),
            "activeOrders": sum(1 for o in orders if o["status"] in {s.value for s in ACTIVE_ORDERS}),
            "utilization": {k.value: by_kind(k) for k in FacilityKind},
            "notice": "SIMULATION: simulated infrastructure; hospitals and restaurants are real OSM locations only.",
        }

    def availability(self, district: str | None = None) -> list[dict]:
        return [{"id": f.id, "kind": f.kind, "name": f.name, "district": f.district, "capacity": f.capacity,
                 "occupied": f.occupied, "reserved": f.reserved, "available": f.available,
                 "dispatchEnabled": f.dispatch_enabled, "availableDrones": f.available_drones}
                for f in self.facilities(district=district) if f.dispatch_enabled or f.kind == FacilityKind.DEPOT]

    def demand(self, scenario: str = "BASELINE") -> dict:
        if scenario not in planning.SCENARIOS:
            raise Invalid(f"Unknown scenario '{scenario}' (use {', '.join(planning.SCENARIOS)}).")
        boost, peak_factor, label = planning.SCENARIOS[scenario]
        weights = {d: w * boost.get(d, 1.0) for d, w in planning.SIMULATED_DISTRICT_DEMAND.items()}
        subs = {k for k, v in self._subscriptions().items() if v["status"] in ("ACTIVE", "TRIAL")}
        pts = planning.demand_points(self.pois, self.planner.coverage, subs, weights)
        depots = [d for d in self.facilities(FacilityKind.DEPOT) if d.dispatch_enabled]
        if not depots:
            return {"scenario": scenario, "label": label, "depots": [], "assumptions": planning.ASSUMPTIONS}
        import numpy as np
        dxy = np.array([(p.x, p.y) for p in pts])
        w = np.array([p.weight for p in pts])
        sxy = np.array([lonlat_to_xy(d.longitude, d.latitude) for d in depots])
        nearest = np.hypot(dxy[:, None, 0] - sxy[None, :, 0], dxy[:, None, 1] - sxy[None, :, 1]).argmin(axis=1)
        total = float(w.sum())
        peak = planning.PEAK_CONCURRENT_DELIVERIES * peak_factor
        out = []
        for i, d in enumerate(depots):
            share = float(w[nearest == i].sum()) / total if total else 0.0
            out.append({"depotId": d.id, "name": d.name, "district": d.district, "installedCapacity": d.capacity,
                        "drones": d.assigned_drones, "demandShare": round(share, 4),
                        "demandScore": round(share * len(depots), 2), **planning.recommend(share, d.capacity, peak)})
        out.sort(key=lambda x: -x["demandShare"])
        return {"scenario": scenario, "label": label, "peakConcurrentDeliveries": peak, "depots": out,
                "districtWeights": weights, "assumptions": planning.ASSUMPTIONS,
                "notice": "Recommendations are separate from installed capacity and never change it automatically."}

    # --- orders -----------------------------------------------------------------------------------
    def _order(self, r) -> Order:
        legs = [RouteLeg(**leg) for leg in json.loads(r["legs_json"] or "[]")]
        return Order(id=r["id"], order_type=r["order_type"], status=r["status"],
                     pickup=Coordinate(latitude=r["pickup_lat"], longitude=r["pickup_lon"]),
                     destination=Coordinate(latitude=r["dest_lat"], longitude=r["dest_lon"]),
                     pickup_facility_id=r["pickup_facility_id"], destination_facility_id=r["dest_facility_id"],
                     partner_id=r["partner_id"], drone_id=r["drone_id"], drone_profile_id=r["profile_id"],
                     flight_altitude_meters=r["altitude_m"], legs=legs, distance_m=r["distance_m"],
                     estimated_duration_s=r["eta_s"], message=r["message"], verification=r["verification"],
                     created_at=r["created_at"], updated_at=r["updated_at"])

    def orders(self, status: OrderStatus | None = None) -> list[Order]:
        if status:
            rows = self.db.query("SELECT * FROM orders WHERE status = ? ORDER BY created_at DESC, rowid DESC", (status.value,))
        else:
            rows = self.db.query("SELECT * FROM orders ORDER BY created_at DESC, rowid DESC")
        return [self._order(r) for r in rows]

    def order(self, oid: str) -> Order:
        r = self.db.one("SELECT * FROM orders WHERE id = ?", (oid,))
        if r is None:
            raise NotFound(f"Order '{oid}' not found.")
        return self._order(r)

    def create_order(self, req: OrderCreate) -> Order:
        if req.pickup is None:
            if req.order_type not in MEDICAL_ORDER_TYPES:
                raise Invalid("A pickup address is required for food deliveries.")
            near = self.nearest_hospital(req.destination.latitude, req.destination.longitude, req.flight_altitude_meters)
            req = req.model_copy(update={"pickup": near.pickup, "pickup_facility_id": near.pickup_facility_id,
                                         "partner_id": req.partner_id or near.hospital.id})
        cov = self.planner.coverage
        for label, p in (("Pickup", req.pickup), ("Destination", req.destination)):
            if not cov.contains(p.longitude, p.latitude):
                raise Invalid(f"{label} {p.latitude:.5f}, {p.longitude:.5f} is outside the Warsaw boundary.")
        if (req.pickup.latitude, req.pickup.longitude) == (req.destination.latitude, req.destination.longitude):
            raise Invalid("Pickup and destination must differ.")
        for fid in (req.pickup_facility_id, req.destination_facility_id):
            if fid:
                self.facility(fid)  # 404 if unknown
        if req.drone_profile_id and self.profiles.get(req.drone_profile_id) is None:
            raise Invalid(f"Unknown droneProfileId '{req.drone_profile_id}'.")
        oid = "ord-" + uuid.uuid4().hex[:10]
        now = now_iso()
        with self.db.tx() as c:
            c.execute("INSERT INTO orders (id, order_type, status, pickup_lat, pickup_lon, pickup_facility_id, dest_lat, "
                      "dest_lon, dest_facility_id, partner_id, drone_id, profile_id, altitude_m, weather_mode, legs_json, "
                      "distance_m, eta_s, message, verification, created_at, updated_at) "
                      "VALUES (?, ?, 'CREATED', ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, '[]', NULL, NULL, ?, NULL, ?, ?)",
                      (oid, req.order_type.value, req.pickup.latitude, req.pickup.longitude, req.pickup_facility_id,
                       req.destination.latitude, req.destination.longitude, req.destination_facility_id,
                       req.partner_id, req.drone_profile_id, req.flight_altitude_meters, req.weather_mode.value,
                       "Order created; no drone assigned yet.", now, now))
        return self.order(oid)

    def _set_order(self, c, oid: str, **fields) -> None:
        sets = ", ".join(f"{k} = ?" for k in fields)
        c.execute(f"UPDATE orders SET {sets}, updated_at = ? WHERE id = ?", (*fields.values(), now_iso(), oid))

    def _leg(self, name: str, a: tuple[float, float], b: tuple[float, float], profile, weather: WeatherInfo,
             altitude: int, at: datetime):
        """a/b are (lon, lat). Uses the shared planner (zones, buildings, weather)."""
        if a == b:
            return {"leg": name, "status": "OK", "distance_m": 0.0, "eta_s": 0.0, "geometry": None,
                    "message": "Already at this point."}, True
        r = self.planner.plan(a, b, FlightMode.NORMAL, altitude, profile, weather, at, RouteObjective.FASTEST)
        ok = r.status == RouteStatus.OK
        return {"leg": name, "status": r.status.value, "distance_m": r.distance_m, "eta_s": r.eta_s,
                "geometry": {"type": "LineString", "coordinates": r.path_lonlat} if ok else None,
                "message": r.message}, ok

    def _facility_full_message(self, row) -> str:
        alts = [f for f in self.facilities(FacilityKind(row["kind"]))
                if f.id != row["id"] and f.dispatch_enabled and f.available > 0]
        alts.sort(key=lambda f: _dist_m(row["latitude"], row["longitude"], f.latitude, f.longitude))
        hint = f" Nearest enabled alternative with space: {alts[0].name} ({alts[0].id})." if alts else ""
        return f"'{row['name']}' has no free landing space ({row['occupied']} occupied, {row['reserved']} reserved).{hint}"

    def assign(self, oid: str, weather: WeatherInfo, at: datetime | None = None) -> AssignmentResult:
        o = self.db.one("SELECT * FROM orders WHERE id = ?", (oid,))
        if o is None:
            raise NotFound(f"Order '{oid}' not found.")
        if o["status"] not in (OrderStatus.CREATED.value, OrderStatus.NO_DRONE_AVAILABLE.value, OrderStatus.FAILED.value):
            raise Conflict(f"Order {oid} is {o['status']}; only CREATED/NO_DRONE_AVAILABLE/FAILED orders can be assigned.")
        at = at or datetime.now(timezone.utc)
        pickup = (o["pickup_lon"], o["pickup_lat"])
        dest = (o["dest_lon"], o["dest_lat"])
        state = self.planner.airspace.refresh()
        st = SourceState(airspace_status(state, self.planner.coverage, at).source_state)
        verification = VERIFICATION_TEXT[st]

        def fail(status: OrderStatus, msg: str, candidates) -> AssignmentResult:
            with self.db.tx() as c:
                self._set_order(c, oid, status=status.value, message=msg, verification=verification)
            return AssignmentResult(order=self.order(oid), assigned=False, candidates=candidates, message=msg)

        # Required landing facilities must be enabled, open and have space before any routing.
        landing = [fid for fid in (o["pickup_facility_id"], o["dest_facility_id"]) if fid]
        pickup_fid = o["pickup_facility_id"]
        home_drones = self.db.query("SELECT status FROM drones WHERE home_depot_id = ?", (pickup_fid,)) if pickup_fid else []
        for fid in landing:
            f = self.db.one("SELECT * FROM facilities WHERE id = ?", (fid,))
            if f["kind"] == "DEPOT":
                continue  # depots receive drones through their own home reservations
            if fid == pickup_fid and any(d["status"] == "AVAILABLE" for d in home_drones):
                continue  # the pickup facility's own drone starts there: no landing space needed
            if f["verification"] not in ("SIMULATION_ENABLED", "VERIFIED_BY_OPERATOR") or f["operational_status"] != "OPEN":
                return fail(OrderStatus.FAILED, f"'{f['name']}' is not enabled for the simulation or is closed "
                                                f"({f['verification']}, {f['operational_status']}).", [])
            if f["occupied"] + f["reserved"] >= f["capacity"]:
                if fid == pickup_fid and home_drones:
                    return fail(OrderStatus.NO_DRONE_AVAILABLE,
                                f"All {len(home_drones)} drones at '{f['name']}' are busy and it has no free landing "
                                "space for a drone from a depot. Try again when one returns.", [])
                return fail(OrderStatus.FAILED, self._facility_full_message(f), [])

        rows = self.db.query(
            f"SELECT d.*, f.latitude AS lat, f.longitude AS lon FROM drones d JOIN facilities f ON f.id = d.home_depot_id "
            f"WHERE d.status = 'AVAILABLE' AND f.verification IN {ENABLED_SQL} AND f.operational_status = 'OPEN' "
            # Depot drones serve any order; a hospital's drones serve only orders picked up at that hospital.
            f"AND (f.kind = 'DEPOT' OR f.id = ?)"
            + (" AND d.profile_id = ?" if o["profile_id"] else ""),
            (pickup_fid or "", o["profile_id"]) if o["profile_id"] else (pickup_fid or "",))
        candidates: list[AssignmentCandidate] = []
        if not rows:
            return fail(OrderStatus.NO_DRONE_AVAILABLE, "No available drone at any enabled, open depot.", candidates)
        # Shortlist: the nearest depots (straight line) – then compare by ROUTED time.
        by_depot: dict[str, list] = {}
        for r in rows:
            by_depot.setdefault(r["home_depot_id"], []).append(r)
        depots = sorted(by_depot, key=lambda d: _dist_m(by_depot[d][0]["lat"], by_depot[d][0]["lon"], pickup[1], pickup[0]))
        shortlisted = []
        for d in depots[:ASSIGNMENT_CANDIDATES]:
            seen_profiles = set()
            for r in sorted(by_depot[d], key=lambda r: -r["battery_pct"]):
                if r["profile_id"] in seen_profiles:
                    continue
                seen_profiles.add(r["profile_id"])
                if r["battery_pct"] < DRONE_MIN_BATTERY_PCT:
                    candidates.append(AssignmentCandidate(drone_id=r["id"], depot_id=d, eligible=False,
                                                          reason=f"Battery {r['battery_pct']:.0f}% below {DRONE_MIN_BATTERY_PCT:.0f}%."))
                    continue
                shortlisted.append(r)

        altitude = o["altitude_m"]
        evaluated = []
        delivery_cache: dict[str, tuple] = {}
        for r in shortlisted:
            prof = self.profiles.get(r["profile_id"])
            if prof is None:
                candidates.append(AssignmentCandidate(drone_id=r["id"], depot_id=r["home_depot_id"], eligible=False,
                                                      reason=f"Unknown profile {r['profile_id']}."))
                continue
            home = (r["lon"], r["lat"])
            to_pickup, ok1 = self._leg("TO_PICKUP", home, pickup, prof, weather, altitude, at)
            if prof.id not in delivery_cache:
                delivery_cache[prof.id] = self._leg("DELIVERY", pickup, dest, prof, weather, altitude, at)
            delivery, ok2 = delivery_cache[prof.id]
            back, ok3 = self._leg("RETURN", dest, home, prof, weather, altitude, at)
            if not (ok1 and ok2 and ok3):
                bad = next(leg for leg, ok in ((to_pickup, ok1), (delivery, ok2), (back, ok3)) if not ok)
                candidates.append(AssignmentCandidate(drone_id=r["id"], depot_id=r["home_depot_id"], eligible=False,
                                                      reason=f"{bad['leg']} leg: {bad['status']} – {bad['message']}"))
                continue
            total_m = to_pickup["distance_m"] + delivery["distance_m"] + back["distance_m"]
            usable = r["max_range_m"] * r["battery_pct"] / 100 * (1 - DRONE_RANGE_RESERVE_PCT / 100)
            if total_m > usable:
                candidates.append(AssignmentCandidate(
                    drone_id=r["id"], depot_id=r["home_depot_id"], eligible=False, total_distance_m=round(total_m, 1),
                    reason=f"Needs {total_m / 1000:.1f} km incl. return; usable range {usable / 1000:.1f} km "
                           f"(battery {r['battery_pct']:.0f}%, {DRONE_RANGE_RESERVE_PCT:.0f}% reserve)."))
                continue
            pickup_eta = to_pickup["eta_s"]
            total_eta = pickup_eta + delivery["eta_s"]
            candidates.append(AssignmentCandidate(drone_id=r["id"], depot_id=r["home_depot_id"], eligible=True,
                                                  reason="Eligible.", pickup_eta_s=round(pickup_eta, 1),
                                                  total_eta_s=round(total_eta, 1), total_distance_m=round(total_m, 1)))
            evaluated.append((total_eta, r, [to_pickup, delivery, back], total_m))

        evaluated.sort(key=lambda e: e[0])
        for total_eta, r, legs, total_m in evaluated:
            try:
                with self.db.tx() as c:
                    if c.execute("UPDATE drones SET status = 'RESERVED', current_order_id = ?, updated_at = ? "
                                 "WHERE id = ? AND status = 'AVAILABLE'", (oid, now_iso(), r["id"])).rowcount != 1:
                        raise _Taken()
                    for fid in landing:
                        if fid == r["home_depot_id"]:
                            continue  # the drone is already based here
                        if c.execute("SELECT kind FROM facilities WHERE id = ?", (fid,)).fetchone()["kind"] == "DEPOT":
                            continue
                        n = c.execute(f"UPDATE facilities SET reserved = reserved + 1, updated_at = ? WHERE id = ? "
                                      f"AND occupied + reserved < capacity AND operational_status = 'OPEN' "
                                      f"AND verification IN {ENABLED_SQL}", (now_iso(), fid)).rowcount
                        if n != 1:
                            raise _Full(fid)
                    msg = (f"Drone {r['name']} reserved at {r['home_depot_id']}: pickup in ~{legs[0]['eta_s'] / 60:.1f} min, "
                           f"delivery ~{total_eta / 60:.1f} min after dispatch.")
                    if not o["dest_facility_id"]:
                        msg += " Destination is not a station: landing suitability there is unknown (simulated drop-off)."
                    self._set_order(c, oid, status=OrderStatus.ASSIGNED.value, drone_id=r["id"], profile_id=r["profile_id"],
                                    legs_json=json.dumps(legs), distance_m=round(total_m, 1), eta_s=round(total_eta, 1),
                                    message=msg, verification=verification)
                return AssignmentResult(order=self.order(oid), assigned=True, candidates=candidates, message=msg)
            except _Taken:
                for cand in candidates:
                    if cand.drone_id == r["id"]:
                        cand.eligible, cand.reason = False, "Taken by a concurrent order."
                continue
            except _Full as full:
                row = self.db.one("SELECT * FROM facilities WHERE id = ?", (full.fid,))
                return fail(OrderStatus.FAILED, self._facility_full_message(row), candidates)
        return fail(OrderStatus.NO_DRONE_AVAILABLE, self._no_drone_message(candidates), candidates)

    @staticmethod
    def _no_drone_message(candidates: list[AssignmentCandidate]) -> str:
        """One readable sentence instead of one line per checked drone."""
        bad = [c for c in candidates if not c.eligible]
        if not bad:
            return "No eligible drone: no candidates."
        ranged = [c for c in bad if c.total_distance_m is not None]
        parts = []
        if ranged:
            best = min(ranged, key=lambda c: c.total_distance_m)
            parts.append(f"out of range for {len(ranged)} drone{'s' if len(ranged) != 1 else ''} checked; the closest "
                         f"needs {best.total_distance_m / 1000:.1f} km incl. return ({best.reason.split('; ', 1)[-1]})")
        other = sorted({c.reason for c in bad if c.total_distance_m is None})
        parts.extend(other[:2])
        if len(other) > 2:
            parts.append(f"{len(other) - 2} other reason(s)")
        return "No eligible drone: " + "; ".join(parts) + ". Try a pickup closer to a depot."

    def advance(self, oid: str) -> Order:
        """One simulated step of the delivery, updating drone state and parking occupancy."""
        with self.db.tx() as c:
            o = c.execute("SELECT * FROM orders WHERE id = ?", (oid,)).fetchone()
            if o is None:
                raise NotFound(f"Order '{oid}' not found.")
            status = OrderStatus(o["status"])
            if status not in NEXT_STATUS:
                raise Conflict(f"Order {oid} is {status.value}; nothing to advance.")
            nxt = NEXT_STATUS[status]
            d = c.execute("SELECT * FROM drones WHERE id = ?", (o["drone_id"],)).fetchone()
            home, pick, dst = d["home_depot_id"], o["pickup_facility_id"], o["dest_facility_id"]

            def fac(fid, **delta):
                if not fid or c.execute("SELECT kind FROM facilities WHERE id = ?", (fid,)).fetchone()["kind"] == "DEPOT" \
                        and fid != home:
                    return
                sets = ", ".join(f"{k} = {k} + ?" for k in delta)
                c.execute(f"UPDATE facilities SET {sets}, updated_at = ? WHERE id = ?", (*delta.values(), now_iso(), fid))

            def drone(status_, facility):
                c.execute("UPDATE drones SET status = ?, current_facility_id = ?, updated_at = ? WHERE id = ?",
                          (status_, facility, now_iso(), d["id"]))

            if nxt == OrderStatus.TO_PICKUP:
                fac(home, occupied=-1, reserved=1)  # departs; its return space stays held
                drone("IN_FLIGHT", None)
            elif nxt == OrderStatus.LOADING:
                if pick and pick != home:
                    fac(pick, reserved=-1, occupied=1)
                drone("LOADING", pick)
            elif nxt == OrderStatus.IN_DELIVERY:
                if pick and pick != home:
                    fac(pick, occupied=-1)
                drone("DELIVERING", None)
            elif nxt == OrderStatus.DELIVERED:
                if dst and dst != home:
                    fac(dst, reserved=-1, occupied=1)
                drone("DELIVERING", dst)
            elif nxt == OrderStatus.RETURNING:
                if dst and dst != home:
                    fac(dst, occupied=-1)
                drone("RETURNING", None)
            elif nxt == OrderStatus.COMPLETED:
                fac(home, reserved=-1, occupied=1)
                used = 100 * (o["distance_m"] or 0) / d["max_range_m"]
                c.execute("UPDATE drones SET status = 'CHARGING', current_facility_id = ?, current_order_id = NULL, "
                          "battery_pct = MAX(0, battery_pct - ?), updated_at = ? WHERE id = ?",
                          (home, used, now_iso(), d["id"]))
            legs = json.loads(o["legs_json"] or "[]")
            self._set_order(c, oid, status=nxt.value, legs_json=json.dumps(legs),
                            message=f"Simulated step: {status.value} → {nxt.value}.")
        return self.order(oid)

    def cancel(self, oid: str) -> Order:
        with self.db.tx() as c:
            o = c.execute("SELECT * FROM orders WHERE id = ?", (oid,)).fetchone()
            if o is None:
                raise NotFound(f"Order '{oid}' not found.")
            if o["status"] == OrderStatus.ASSIGNED.value:
                c.execute("UPDATE drones SET status = 'AVAILABLE', current_order_id = NULL, updated_at = ? WHERE id = ?",
                          (now_iso(), o["drone_id"]))
                for fid in (o["pickup_facility_id"], o["dest_facility_id"]):
                    if fid and c.execute("SELECT kind FROM facilities WHERE id = ?", (fid,)).fetchone()["kind"] != "DEPOT":
                        c.execute("UPDATE facilities SET reserved = reserved - 1, updated_at = ? WHERE id = ?",
                                  (now_iso(), fid))
            elif o["status"] not in (OrderStatus.CREATED.value, OrderStatus.NO_DRONE_AVAILABLE.value, OrderStatus.FAILED.value):
                raise Conflict(f"Order {oid} is {o['status']}: a drone is already flying; advance it to completion.")
            self._set_order(c, oid, status=OrderStatus.CANCELLED.value, message="Cancelled; reservations released.")
        return self.order(oid)


class _Taken(Exception):
    pass


class _Full(Exception):
    def __init__(self, fid: str):
        self.fid = fid
