"""Simulated delivery infrastructure: POI import/dedup, seeding, capacity, pads, orders, assignment."""

import importlib.util
import json
import sqlite3
import threading
from datetime import datetime, timezone

import pytest
from shapely.geometry import LineString, Point, Polygon, box, shape

from app.airspace.repository import AirspaceRepository
from app.config import ADMIN_TOKEN, BOUNDARY_DISTRICTS_FILE, POI_DIR, REPO_ROOT
from app.fleet.db import FleetDB
from app.fleet.models import (
    DepotCreate,
    DroneStatus,
    FacilityKind,
    FacilityPatch,
    OrderCreate,
    OrderStatus,
    OrderType,
    PadCreate,
    SubscriptionStatus,
    Verification,
)
from app.fleet.pois import Poi, PoiLayer, Pois, load_layer
from app.fleet.seed import VISTULA_DEPOT_ID, pad_id, seed, station_id
from app.fleet.service import Conflict, FleetService, Invalid
from app.routing.planner import RoutePlanner
from app.schemas.planning import Coordinate
from app.services.weather import _weather as sample_weather
from tests.conftest import StaticProvider, zone

API = "/api/v1"
ADMIN = {"X-Admin-Token": ADMIN_TOKEN}
WEATHER = sample_weather(80).model_copy(update={"wind_speed_kmh": 0.0, "wind_gust_kmh": None, "samples": []})


def C(lat, lon):
    return Coordinate(latitude=lat, longitude=lon)


def poi(pid, name, lat, lon, district, **extra):
    props = {"id": pid, "osmId": pid.removeprefix("osm:"), "name": name, "latitude": lat, "longitude": lon,
             "district": district, "address": extra.pop("address", "ul. Testowa 1, Warszawa"),
             "completeness": {"hasName": bool(name), "hasAddress": True, "hasFootprint": True, "hasContact": False},
             "source": "OpenStreetMap (test fixture)", "importedAt": "2026-10-18T00:00:00+00:00", **extra}
    return Poi(pid, name, lat, lon, district, props)


HOSPITALS = [
    poi("osm:way/1", "Szpital Testowy Centrum", 52.2250, 21.0010, "Śródmieście"),
    poi("osm:way/2", "Szpital Testowy Mokotów", 52.1950, 21.0300, "Mokotów"),
    poi("osm:way/3", "Szpital Testowy Praga", 52.2520, 21.0400, "Praga-Północ"),
    poi("osm:node/4", None, 52.2900, 20.9300, "Bielany"),  # unnamed: stays unnamed
]
RESTAURANTS = [
    poi("osm:node/10", "Restauracja Test A", 52.2290, 21.0120, "Śródmieście"),
    poi("osm:node/11", "Restauracja Test B", 52.2100, 20.9800, "Ochota"),
    poi("osm:node/12", "Restauracja Test C", 52.2600, 21.0300, "Praga-Północ"),
]


@pytest.fixture
def pois():
    return Pois(PoiLayer("hospitals", True, list(HOSPITALS)), PoiLayer("restaurants", True, list(RESTAURANTS)))


@pytest.fixture(scope="module")
def city(client):
    return client.app.state.planner


@pytest.fixture
def fleet(tmp_path, pois, city, client):
    db = FleetDB(tmp_path / "fleet.sqlite")
    seed(db, pois, city, client.app.state.profiles, demo_hospitals=2, partners=1)
    svc = FleetService(db, pois, city, client.app.state.profiles)
    yield svc
    db.close()


def enable(fleet, fid):
    return fleet.patch_facility(fid, FacilityPatch(verification=Verification.SIMULATION_ENABLED))


# --- import & deduplication -----------------------------------------------------------

def _fetch_pois():
    spec = importlib.util.spec_from_file_location("fetch_pois", REPO_ROOT / "scripts" / "fetch_pois.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _rec(osm_id, name, geom):
    return {"osm_id": osm_id, "name": name, "tags": {"name": name} if name else {}, "geom": geom,
            "point": geom if geom.geom_type == "Point" else geom.representative_point(), "district": "Wola"}


def test_hospital_campus_buildings_are_one_hospital():
    f = _fetch_pois()
    campus = box(20.960, 52.230, 20.966, 52.234)
    recs = [
        _rec("way/1", "Szpital Wolski", campus),
        _rec("way/2", None, box(20.961, 52.231, 20.962, 52.232)),  # unnamed building of the campus
        _rec("node/3", "Szpital Wolski", Point(20.963, 52.232)),  # node inside the campus
        _rec("node/4", "Państwowy Szpital Wolski", Point(20.9675, 52.2335)),  # name variant, next to it
        _rec("way/5", "Inny Szpital", box(20.990, 52.240, 20.994, 52.243)),  # a different hospital
    ]
    kept = f.dedupe_hospitals(recs)
    assert [k["osm_id"] for k in kept] == ["way/1", "way/5"]
    assert set(kept[0]["merged"]) == {"way/2", "node/3", "node/4"}


def test_restaurant_node_and_building_polygon_are_one_poi():
    f = _fetch_pois()
    recs = [_rec("node/1", "Bar Mleczny", Point(21.0005, 52.2305)),
            _rec("way/2", "Bar Mleczny", box(21.0000, 52.2300, 21.0010, 52.2310)),
            _rec("node/3", "Bar Mleczny", Point(21.0300, 52.2500)),  # same name elsewhere: another branch
            _rec("node/4", None, Point(21.0006, 52.2306))]  # unnamed: never merged by name
    kept = f.dedupe_restaurants(recs)
    assert sorted(k["osm_id"] for k in kept) == ["node/3", "node/4", "way/2"]


def test_imported_hospitals_are_real_records_inside_warsaw():
    layer = load_layer("hospitals")
    assert layer.available and len(layer.items) >= 30
    districts = {f["properties"]["name"] for f in json.loads(BOUNDARY_DISTRICTS_FILE.read_text(encoding="utf-8"))["features"]}
    assert {h.district for h in layer.items} <= districts
    assert len({h.district for h in layer.items}) >= 10  # spread over the city (OSM coverage, see metadata)
    assert len({h.id for h in layer.items}) == len(layer.items)
    assert all(h.name is None or h.name.strip() for h in layer.items)  # never invented
    assert "not guaranteed" in layer.metadata["completenessNote"]
    assert layer.metadata["afterDeduplication"] <= layer.metadata["insideWarsaw"]


def test_import_failure_leaves_the_existing_file(monkeypatch, tmp_path):
    f = _fetch_pois()
    monkeypatch.setattr(f, "POI_DIR", tmp_path)
    (tmp_path / "hospitals.geojson").write_text("KEEP", encoding="utf-8")

    def boom(*a, **k):
        raise f.FetchError("Overpass down")

    monkeypatch.setattr(f, "tiled_query", boom)
    assert f.main(["hospitals"]) == 1
    assert (tmp_path / "hospitals.geojson").read_text(encoding="utf-8") == "KEEP"


def test_missing_poi_file_is_reported_not_fatal(tmp_path):
    layer = load_layer("restaurants", tmp_path)
    assert not layer.available and "fetch_pois" in layer.message and layer.items == []


# --- seeded infrastructure ----------------------------------------------------------------

def test_every_hospital_gets_a_proposed_station_with_capacity_2(fleet):
    stations = fleet.facilities(FacilityKind.HOSPITAL_STATION)
    assert {s.ref_id for s in stations} == {h.id for h in HOSPITALS}
    assert all(s.capacity == 2 and s.occupied == 0 and s.available == 2 for s in stations)
    unnamed = next(s for s in stations if s.ref_id == "osm:node/4")
    assert "unnamed hospital" in unnamed.name
    enabled = [s for s in stations if s.dispatch_enabled]
    assert enabled and all("DEMO" in s.notes for s in enabled)
    assert any(s.verification == Verification.PROPOSED and not s.dispatch_enabled for s in stations) or len(HOSPITALS) <= 6


def test_vistula_depot_is_preserved_and_not_duplicated(fleet):
    v = fleet.facility(VISTULA_DEPOT_ID)
    assert v.kind == FacilityKind.DEPOT and (v.latitude, v.longitude) == (52.2352, 21.0385)
    assert "preserved" in v.data_source
    with pytest.raises(Conflict, match="already occupies"):
        fleet.create_depot(DepotCreate(name="Duplicate Vistula", location=C(52.2360, 21.0390), capacity=6))


def test_depot_network_capacities(fleet):
    depots = fleet.facilities(FacilityKind.DEPOT)
    assert 8 <= len(depots) <= 12
    assert {d.capacity for d in depots if d.depot_type == "STANDARD"} == {6}
    assert {d.capacity for d in depots if d.depot_type == "HIGH_DEMAND"} == {12}
    planned = [d for d in depots if d.id != VISTULA_DEPOT_ID]
    assert all("SIMULATED" in (d.notes or "") for d in planned)
    # a central depot can be made larger by an operator; never below what is in use
    d = planned[0]
    assert fleet.patch_facility(d.id, FacilityPatch(capacity=12)).capacity == 12
    with pytest.raises(Conflict):
        fleet.patch_facility(d.id, FacilityPatch(capacity=d.occupied - 1))


def test_capacity_invariants_are_enforced_by_the_database(fleet):
    with pytest.raises(sqlite3.IntegrityError):
        with fleet.db.tx() as c:
            c.execute("UPDATE facilities SET reserved = capacity - occupied + 1 WHERE id = ?", (VISTULA_DEPOT_ID,))
    with pytest.raises(sqlite3.IntegrityError):
        with fleet.db.tx() as c:
            c.execute("UPDATE facilities SET occupied = -1 WHERE id = ?", (VISTULA_DEPOT_ID,))


# --- subscriptions & pads ---------------------------------------------------------------------

def unsubscribed(fleet):
    return [r for r in fleet.restaurants().items if r.subscription == SubscriptionStatus.NOT_SUBSCRIBED]


def test_subscription_activation_creates_a_proposed_pad_needing_review(fleet):
    rid = unsubscribed(fleet)[0].id
    r = fleet.set_subscription(rid, SubscriptionStatus.ACTIVE)
    assert r.subscription == SubscriptionStatus.ACTIVE and not r.demo_partner
    assert r.pad.capacity == 1 and r.pad.verification == Verification.REVIEW_REQUIRED and not r.pad.dispatch_enabled
    assert enable(fleet, r.pad.id).dispatch_enabled  # explicit operator step, separate from the subscription
    suspended = fleet.set_subscription(rid, SubscriptionStatus.SUSPENDED)
    assert suspended.pad.verification == Verification.DISABLED


def test_only_designated_restaurants_are_subscribed(fleet):
    page = fleet.restaurants()
    subscribed = [r for r in page.items if r.subscription != SubscriptionStatus.NOT_SUBSCRIBED]
    assert len(subscribed) == 1 and subscribed[0].demo_partner and subscribed[0].pad.dispatch_enabled
    assert "DEMO partner" in subscribed[0].pad.notes
    assert len(unsubscribed(fleet)) == len(page.items) - 1


def test_pad_validation(fleet):
    r = unsubscribed(fleet)[0]
    with pytest.raises(Conflict, match="subscribed"):
        fleet.create_pad(PadCreate(restaurant_id=r.id))
    fleet.set_subscription(r.id, SubscriptionStatus.TRIAL)  # TRIAL: no automatic pad
    with pytest.raises(Invalid, match="from the facility"):
        fleet.create_pad(PadCreate(restaurant_id=r.id, location=C(r.latitude + 0.01, r.longitude)))
    with pytest.raises(Invalid, match="Outside the official Warsaw"):
        fleet.create_pad(PadCreate(restaurant_id=r.id, location=C(52.05, 21.0)))
    with pytest.raises(ValueError):
        PadCreate(restaurant_id=r.id, capacity=3)
    pad = fleet.create_pad(PadCreate(restaurant_id=r.id, location=C(r.latitude + 0.0002, r.longitude), capacity=2))
    assert pad.capacity == 2 and pad.verification == Verification.REVIEW_REQUIRED and not pad.dispatch_enabled
    assert (pad.latitude, pad.longitude) == (r.latitude + 0.0002, r.longitude)  # exact coordinates saved
    check = fleet.check_point(pad.latitude, pad.longitude, r.latitude, r.longitude)
    assert 15 < check.distance_from_facility_m < 30 and "property owner permission" in check.not_verifiable_from_map_data
    with pytest.raises(Invalid):
        fleet.patch_facility(pad.id, FacilityPatch(capacity=3))


def test_pad_inside_blocked_zone_is_rejected(fleet, city):
    blocker = zone("TEST-PAD-ZONE", box(20.979, 52.209, 20.981, 52.211))
    fleet.planner = RoutePlanner(city.grid, AirspaceRepository(StaticProvider([blocker]), city.grid), city.coverage)
    check = fleet.check_point(52.2100, 20.9800, 52.2100, 20.9800)
    assert not check.ok_for_simulation and check.obstacle_zones == ["TEST-PAD-ZONE"]


# --- orders & assignment ---------------------------------------------------------------------------

def order(fleet, pickup=(52.2405, 20.9650), dest=(52.2250, 21.0010), **kw):
    return fleet.create_order(OrderCreate(order_type=kw.pop("order_type", OrderType.FOOD_DELIVERY),
                                          pickup=C(*pickup), destination=C(*dest), **kw))


def test_order_keeps_the_users_points_and_routes_dynamically(fleet):
    o = order(fleet, pickup=(52.2405, 20.9650), dest=(52.2110, 21.0450))
    assert (o.pickup.latitude, o.pickup.longitude) == (52.2405, 20.9650)
    res = fleet.assign(o.id, WEATHER)
    assert res.assigned, res.message
    legs = {leg.leg: leg for leg in res.order.legs}
    assert legs["DELIVERY"].geometry["coordinates"][0] == [20.9650, 52.2405]
    assert legs["DELIVERY"].geometry["coordinates"][-1] == [21.0450, 52.2110]
    assert res.order.verification.startswith("UNVERIFIED SIMULATION")


def test_assignment_ranks_by_routed_time(fleet):
    res = fleet.assign(order(fleet).id, WEATHER)
    eligible = sorted((c for c in res.candidates if c.eligible), key=lambda c: c.total_eta_s)
    assert res.assigned and res.order.drone_id == eligible[0].drone_id


def test_full_lifecycle_updates_drone_and_parking(fleet):
    dest_station = station_id("way/1")
    enable(fleet, dest_station)
    pad = pad_id(next(r.id for r in fleet.restaurants().items if r.pad and r.pad.dispatch_enabled))
    p = fleet.facility(pad)
    o = order(fleet, pickup=(p.latitude, p.longitude), dest=(52.2250, 21.0010), pickup_facility_id=pad,
              destination_facility_id=dest_station, order_type=OrderType.MEDICAL_SUPPLIES)
    res = fleet.assign(o.id, WEATHER)
    assert res.assigned, res.message
    drone = fleet.drone(res.order.drone_id)
    home0 = fleet.facility(drone.home_depot_id)
    assert drone.status == DroneStatus.RESERVED
    assert fleet.facility(pad).reserved == 1 and fleet.facility(dest_station).reserved == 1

    steps = {}
    for _ in range(6):
        o2 = fleet.advance(o.id)
        steps[o2.status] = (fleet.drone(drone.id).status, fleet.facility(drone.home_depot_id),
                            fleet.facility(pad), fleet.facility(dest_station))
    h, *_ = steps[OrderStatus.TO_PICKUP][1:]
    assert steps[OrderStatus.TO_PICKUP][0] == DroneStatus.IN_FLIGHT
    assert (h.occupied, h.reserved) == (home0.occupied - 1, home0.reserved + 1)  # return space held
    assert steps[OrderStatus.LOADING][2].occupied == 1 and steps[OrderStatus.LOADING][2].reserved == 0
    assert steps[OrderStatus.IN_DELIVERY][2].occupied == 0
    assert steps[OrderStatus.DELIVERED][3].occupied == 1 and steps[OrderStatus.DELIVERED][3].reserved == 0
    assert steps[OrderStatus.RETURNING][3].occupied == 0
    status, home, *_ = steps[OrderStatus.COMPLETED]
    assert status == DroneStatus.CHARGING and (home.occupied, home.reserved) == (home0.occupied, home0.reserved)
    assert fleet.drone(drone.id).battery_percent < 100
    with pytest.raises(Conflict):
        fleet.advance(o.id)
    assert fleet.finish_charging(drone.id).status == DroneStatus.AVAILABLE


def test_no_available_drone(fleet):
    with fleet.db.tx() as c:
        c.execute("UPDATE drones SET status = 'MAINTENANCE'")
    res = fleet.assign(order(fleet).id, WEATHER)
    assert not res.assigned and res.order.status == OrderStatus.NO_DRONE_AVAILABLE


def test_full_destination_station_fails_with_alternative(fleet):
    a, b = station_id("way/1"), station_id("way/2")
    enable(fleet, a)
    enable(fleet, b)
    with fleet.db.tx() as c:
        c.execute("UPDATE facilities SET occupied = capacity WHERE id = ?", (a,))
    res = fleet.assign(order(fleet, destination_facility_id=a).id, WEATHER)
    assert not res.assigned and res.order.status == OrderStatus.FAILED
    assert "no free landing space" in res.message and "alternative" in res.message


def test_closed_destination_station_fails(fleet):
    a = station_id("way/1")
    enable(fleet, a)
    fleet.patch_facility(a, FacilityPatch(operational_status="CLOSED"))
    res = fleet.assign(order(fleet, destination_facility_id=a).id, WEATHER)
    assert not res.assigned and "closed" in res.message.lower()


def test_proposed_station_is_not_used_for_dispatch(fleet):
    proposed = next(s for s in fleet.facilities(FacilityKind.HOSPITAL_STATION) if not s.dispatch_enabled)
    res = fleet.assign(order(fleet, destination_facility_id=proposed.id).id, WEATHER)
    assert not res.assigned and "not enabled" in res.message


def test_insufficient_battery_or_range(fleet):
    with fleet.db.tx() as c:
        c.execute("UPDATE drones SET battery_pct = 30")
    far = order(fleet, pickup=(52.3300, 21.0100), dest=(52.1200, 21.0400))  # ~24 km + legs
    res = fleet.assign(far.id, WEATHER)
    assert not res.assigned and res.order.status == OrderStatus.NO_DRONE_AVAILABLE
    assert any("usable range" in c.reason for c in res.candidates)
    with fleet.db.tx() as c:
        c.execute("UPDATE drones SET battery_pct = 10")
    res = fleet.assign(order(fleet).id, WEATHER)
    assert not res.assigned and any("Battery" in c.reason for c in res.candidates)


@pytest.mark.parametrize("kind", [OrderType.BLOOD_DELIVERY, OrderType.AED_DELIVERY, OrderType.MEDICAL_SUPPLIES])
def test_medical_order_without_pickup_starts_at_the_nearest_hospital(fleet, kind):
    dest = C(52.1990, 21.0280)  # close to "Szpital Testowy Mokotów"
    near = fleet.nearest_hospital(dest.latitude, dest.longitude)
    assert near.hospital.name == "Szpital Testowy Mokotów" and near.distance_m < 600
    o = fleet.create_order(OrderCreate(order_type=kind, destination=dest))
    assert (o.pickup.latitude, o.pickup.longitude) == (near.pickup.latitude, near.pickup.longitude)
    assert o.partner_id == near.hospital.id
    assert (o.destination.latitude, o.destination.longitude) == (dest.latitude, dest.longitude)


def test_food_order_needs_a_pickup_address(fleet):
    with pytest.raises(Invalid, match="pickup address is required"):
        fleet.create_order(OrderCreate(order_type=OrderType.FOOD_DELIVERY, destination=C(52.2, 21.0)))


def test_no_drone_message_is_one_summary_not_a_line_per_drone(fleet):
    with fleet.db.tx() as c:
        c.execute("UPDATE drones SET battery_pct = 30")
    res = fleet.assign(order(fleet, pickup=(52.3300, 21.0100), dest=(52.1200, 21.0400)).id, WEATHER)
    assert not res.assigned
    assert res.message.count("Needs") == 0 and res.message.count("needs") == 1
    assert "drones checked" in res.message or "drone checked" in res.message
    assert len([c for c in res.candidates if not c.eligible]) >= 2  # the details stay in the candidate list


def test_api_nearest_hospital(client):
    r = client.get("/api/v1/hospitals/nearest", params={"latitude": 52.2297, "longitude": 21.0122})
    assert r.status_code == 200, r.text
    assert r.json()["hospital"]["name"] and r.json()["distanceM"] >= 0


def test_concurrent_orders_compete_for_a_single_drone(fleet):
    probe = fleet.assign(order(fleet).id, WEATHER)  # the drone the assigner would pick for this trip
    keep = probe.order.drone_id
    fleet.cancel(probe.order.id)
    with fleet.db.tx() as c:
        c.execute("UPDATE drones SET status = 'OFFLINE' WHERE id != ?", (keep,))
    o1, o2 = order(fleet), order(fleet)
    results = {}
    barrier = threading.Barrier(2)

    def run(oid):
        barrier.wait()
        results[oid] = fleet.assign(oid, WEATHER)

    threads = [threading.Thread(target=run, args=(o.id,)) for o in (o1, o2)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assigned = [r for r in results.values() if r.assigned]
    assert len(assigned) == 1 and assigned[0].order.drone_id == keep
    loser = next(r for r in results.values() if not r.assigned)
    assert loser.order.status == OrderStatus.NO_DRONE_AVAILABLE
    assert fleet.drone(keep).status == DroneStatus.RESERVED


def test_cancel_releases_reservations(fleet):
    a = station_id("way/2")
    enable(fleet, a)
    res = fleet.assign(order(fleet, destination_facility_id=a).id, WEATHER)
    assert fleet.facility(a).reserved == 1
    fleet.cancel(res.order.id)
    assert fleet.facility(a).reserved == 0 and fleet.drone(res.order.drone_id).status == DroneStatus.AVAILABLE


def test_delivery_routes_avoid_blocked_zones(fleet, city):
    wall = zone("TEST-FLEET-ZONE", box(21.010, 52.215, 21.013, 52.245))
    fleet.planner = RoutePlanner(city.grid, AirspaceRepository(StaticProvider([wall]), city.grid), city.coverage)
    res = fleet.assign(order(fleet, pickup=(52.2300, 20.9950), dest=(52.2300, 21.0300)).id, WEATHER)
    assert res.assigned, res.message
    g = shape(wall.geojson_geometry)
    for leg in res.order.legs:
        if leg.geometry:
            assert not LineString(leg.geometry["coordinates"]).intersects(g), leg.leg


def test_state_persists_across_restart(tmp_path, pois, city, client):
    path = tmp_path / "persist.sqlite"
    db = FleetDB(path)
    seed(db, pois, city, client.app.state.profiles, demo_hospitals=2, partners=1)
    svc = FleetService(db, pois, city, client.app.state.profiles)
    res = svc.assign(order(svc).id, WEATHER)
    db.close()
    db2 = FleetDB(path)
    assert seed(db2, pois, city, client.app.state.profiles)["seeded"] is False  # no reseed
    svc2 = FleetService(db2, pois, city, client.app.state.profiles)
    assert svc2.order(res.order.id).status == OrderStatus.ASSIGNED
    assert svc2.drone(res.order.drone_id).status == DroneStatus.RESERVED
    db2.close()


def test_demand_recommendations_do_not_change_capacity(fleet):
    before = {d.id: d.capacity for d in fleet.facilities(FacilityKind.DEPOT)}
    base = fleet.demand("BASELINE")
    peak = fleet.demand("CENTRAL_PEAK")
    assert {d.id: d.capacity for d in fleet.facilities(FacilityKind.DEPOT)} == before
    assert peak["peakConcurrentDeliveries"] > base["peakConcurrentDeliveries"]
    central = lambda r: sum(d["expectedPeakDrones"] for d in r["depots"] if d["district"] in ("Śródmieście", "Wola"))  # noqa: E731
    assert central(peak) > central(base)
    assert all(d["level"] in ("LOW", "MEDIUM", "HIGH") for d in peak["depots"])
    with pytest.raises(Invalid):
        fleet.demand("NOPE")


# --- API ------------------------------------------------------------------------------------------------

def test_api_lists_and_admin_protection(client):
    s = client.get(f"{API}/fleet/summary").json()
    assert s["depots"] >= 8 and s["drones"] > 0 and "SIMULATION" in s["notice"]
    h = client.get(f"{API}/hospitals").json()
    assert h["total"] >= 30 and h["items"][0]["station"]["capacity"] == 2
    one = client.get(f"{API}/hospitals/{h['items'][0]['id']}").json()
    assert one["id"] == h["items"][0]["id"]
    depot = client.get(f"{API}/depots").json()[0]
    assert client.patch(f"{API}/depots/{depot['id']}", json={"capacity": 12}).status_code == 401
    assert client.patch(f"{API}/depots/{depot['id']}", json={"capacity": 12}, headers=ADMIN).json()["capacity"] == 12
    assert client.patch(f"{API}/depots/{depot['id']}", json={"capacity": 0}, headers=ADMIN).status_code == 409
    r = client.get(f"{API}/restaurants", params={"limit": 5}).json()
    assert r["limit"] == 5 and len(r["items"]) <= 5


def test_api_order_flow(client):
    o = client.post(f"{API}/orders", json={"orderType": "BLOOD_DELIVERY", "pickup": {"latitude": 52.2405, "longitude": 20.9650},
                                            "destination": {"latitude": 52.2110, "longitude": 21.0450}})
    assert o.status_code == 201
    oid = o.json()["id"]
    a = client.post(f"{API}/orders/{oid}/assign-drone").json()
    assert a["assigned"], a["message"]
    assert client.post(f"{API}/orders/{oid}/advance").json()["status"] == "TO_PICKUP"
    assert client.post(f"{API}/orders", json={"orderType": "FOOD_DELIVERY", "pickup": {"latitude": 52.05, "longitude": 21.0},
                                              "destination": {"latitude": 52.2, "longitude": 21.0}}).status_code == 422
