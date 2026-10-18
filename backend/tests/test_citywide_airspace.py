"""Citywide airspace: loading, evaluation, diagnostics and avoidance across all of Warsaw.

Uses the real city grid and boundary with the SYNTHETIC zones in tests/citywide_zones.py.
"""

import json
import os

import pytest
from shapely.geometry import LineString, Polygon, box, shape

from app.airspace.diagnostics import diagnostics
from app.airspace.evaluation import FlightContext
from app.airspace.factory import make_provider
from app.airspace.models import SourceType
from app.airspace.providers import (
    AirspaceDataset,
    AirspaceLoadError,
    CompositeProvider,
    GeoJsonZoneFileProvider,
    dedupe_zones,
)
from app.airspace.repository import AirspaceRepository, build_state
from app.dependencies import get_airspace, get_coverage, get_planner
from app.routing.costs import FlightMode
from app.routing.planner import RoutePlanner, RouteStatus
from tests.citywide_zones import AIRPORT_FIXTURES, CITYWIDE_ZONES, feature_collection
from tests.conftest import CALM, NOW, PROFILE, StaticProvider, zone

ZONES = CITYWIDE_ZONES + AIRPORT_FIXTURES
GEOM = {z.id: shape(z.geojson_geometry) for z in ZONES}


@pytest.fixture(scope="module")
def city(client):
    """A planner on the real citywide grid and boundary, loaded with the synthetic citywide zones."""
    base = client.app.state.planner
    return RoutePlanner(base.grid, AirspaceRepository(StaticProvider(ZONES), base.grid), base.coverage)


@pytest.fixture
def api(client, overrides, city):
    overrides[get_planner] = lambda: city
    overrides[get_airspace] = lambda: city.airspace
    overrides[get_coverage] = lambda: city.coverage
    return client


def centroid(city, name):
    c = next(d for d in city.coverage.districts if d.name == name).geom.centroid
    return {"latitude": round(c.y, 6), "longitude": round(c.x, 6)}


def zones(api, **params):
    r = api.get("/api/v1/zones", params={"at": NOW.isoformat(), **params})
    assert r.status_code == 200, r.text
    return {z["id"]: z for z in r.json()["zones"]}


def diag(api, **params):
    r = api.get("/api/v1/zones/diagnostics", params={"at": NOW.isoformat(), **params})
    assert r.status_code == 200, r.text
    return r.json()


def route(api, a, b, altitude=80, objective="CORRIDORS"):
    r = api.post("/api/v1/routes/calculate", json={
        "start": a, "destination": b, "mode": "NORMAL", "flightAltitudeMeters": altitude,
        "droneProfileId": "DEMO_DRONE_01", "weatherMode": "SAMPLE", "routeObjective": objective,
        "departureTime": NOW.isoformat(),
    })
    assert r.status_code == 200, r.text
    return r.json()


# --- loading across the whole city -------------------------------------------------

def test_zones_endpoint_returns_every_zone_citywide(api):
    body = api.get("/api/v1/zones", params={"at": NOW.isoformat()}).json()
    assert {z["id"] for z in body["zones"]} == {z.id for z in ZONES}
    assert body["totalZones"] == len(ZONES) and body["bbox"] is None


@pytest.mark.parametrize("district, zone_id", [
    ("Białołęka", "TEST-P-NORTH"),  # north
    ("Ursynów", "TEST-RM-SOUTH"),  # south
    ("Wesoła", "TEST-U-EAST"),  # east
    ("Bemowo", "TEST-R-WEST"),  # west
])
def test_zones_in_every_part_of_warsaw_are_counted_per_district(api, district, zone_id):
    d = next(x for x in diag(api)["districts"] if x["name"] == district)
    assert zone_id in d["zoneIds"]
    assert d["zoneCount"] >= 1


def test_zone_with_centroid_outside_warsaw_overlapping_the_city_is_included(api, city):
    g = GEOM["TEST-P-BOUNDARY"]
    assert not city.coverage.geom.covers(g.centroid) and city.coverage.geom.intersects(g)
    ursynow = next(x for x in diag(api)["districts"] if x["name"] == "Ursynów")
    assert "TEST-P-BOUNDARY" in ursynow["zoneIds"]
    # A bbox on the city side of the boundary returns it although its centre lies outside the bbox.
    hit = zones(api, bbox="21.070,52.098,21.090,52.110")
    assert "TEST-P-BOUNDARY" in hit


def test_zone_entirely_outside_warsaw_is_reported_not_counted(api):
    d = diag(api)
    assert "TEST-R-OUTSIDE" in d["zonesOutsideCity"]
    assert all("TEST-R-OUTSIDE" not in x["zoneIds"] for x in d["districts"])
    assert any("coordinate order" in w for w in d["warnings"])


def test_bbox_filter_uses_geometry_intersection(api):
    assert set(zones(api, bbox="21.20,52.23,21.23,52.245")) == {"TEST-U-EAST"}
    assert zones(api, bbox="21.150,52.300,21.160,52.310") == {}  # nothing there: empty, not an error


@pytest.mark.parametrize("bbox", ["1,2,3", "a,b,c,d", "21.1,52.2,21.0,52.3", "21,52,22,95", "52.2,200,52.3,201"])
def test_bbox_validation(api, bbox):
    assert api.get("/api/v1/zones", params={"bbox": bbox}).status_code == 422


def test_geojson_output_keeps_lon_lat_order_multipolygons_and_holes(api):
    r = api.get("/api/v1/zones", params={"format": "geojson", "at": NOW.isoformat()})
    assert r.headers["content-type"].startswith("application/geo+json")
    fc = r.json()
    assert fc["type"] == "FeatureCollection" and fc["metadata"]["airspaceStatus"]["sourceState"] == "SYNTHETIC"
    by_id = {f["id"]: f for f in fc["features"]}
    assert by_id["TEST-R-WEST"]["geometry"]["type"] == "MultiPolygon"
    assert len(by_id["TEST-R-WEST"]["geometry"]["coordinates"]) == 2
    ring = by_id["TEST-RL-RING"]["geometry"]
    assert ring["type"] == "Polygon" and len(ring["coordinates"]) == 2  # outer ring + hole
    lon, lat = by_id["TEST-P-NORTH"]["geometry"]["coordinates"][0][0]
    assert 20.8 < lon < 21.3 and 52.0 < lat < 52.4  # [lon, lat], WGS84
    assert by_id["TEST-P-NORTH"]["properties"]["evaluation"]["displayClass"] == "RED"


# --- parsing ----------------------------------------------------------------------------

def test_file_round_trip_preserves_polygons_multipolygons_and_holes(tmp_path):
    path = tmp_path / "zones.geojson"
    path.write_text(json.dumps(feature_collection(CITYWIDE_ZONES, None, "fixture")), encoding="utf-8")
    ds = GeoJsonZoneFileProvider(path).load()
    got = {z.id: shape(z.geojson_geometry) for z in ds.zones}
    assert set(got) == {z.id for z in CITYWIDE_ZONES}
    assert got["TEST-R-WEST"].geom_type == "MultiPolygon" and len(got["TEST-R-WEST"].geoms) == 2
    assert len(got["TEST-RL-RING"].interiors) == 1
    assert got["TEST-RL-RING"].area == pytest.approx(GEOM["TEST-RL-RING"].area, rel=1e-6)


def test_swapped_lat_lon_is_detected_as_outside_warsaw(client, city):
    good = GEOM["TEST-P-NORTH"]
    swapped = Polygon([(y, x) for x, y in good.exterior.coords])  # [lat, lon] written by mistake
    state = build_state(StaticProvider([zone("TEST-SWAPPED", swapped)]).load(), city.grid)
    d = diagnostics(state, FlightContext(80, NOW), city.coverage, None)
    assert d.zones_outside_city == ["TEST-SWAPPED"]
    assert all(x.zone_count == 0 for x in d.districts)
    assert any("longitude, latitude" in w for w in d.warnings)


# --- evaluation -------------------------------------------------------------------------

def test_altitude_aware_classification(api):
    low = zones(api, altitudeM=40)["TEST-RH-LOW"]["evaluation"]
    high = zones(api, altitudeM=80)["TEST-RH-LOW"]["evaluation"]
    assert low["isObstacle"] and low["displayClass"] == "RED"
    assert not high["isObstacle"] and high["status"] == "NOT_APPLICABLE_ALTITUDE"
    assert diag(api, altitudeM=40)["totals"]["obstacles"] == diag(api, altitudeM=80)["totals"]["obstacles"] + 1


def test_time_aware_classification(api):
    before = zones(api)["TEST-RL-TEMP"]["evaluation"]
    during = api.get("/api/v1/zones", params={"at": "2026-11-10T10:00:00Z"}).json()
    during = next(z for z in during["zones"] if z["id"] == "TEST-RL-TEMP")["evaluation"]
    assert before["status"] == "NOT_ACTIVE_TIME" and not before["isObstacle"]
    assert during["isObstacle"]


def test_airport_fixture_altitude_rules(api):
    """Airport-related fixtures: restricted only above 40 m AGL (EPWA) / below 150 m AMSL (EPBC)."""
    assert zones(api, altitudeM=20)["TEST-AIRPORT-EPWA"]["evaluation"]["status"] == "NOT_APPLICABLE_ALTITUDE"
    assert zones(api, altitudeM=80)["TEST-AIRPORT-EPWA"]["evaluation"]["isObstacle"]
    assert zones(api, altitudeM=80)["TEST-AIRPORT-EPBC"]["evaluation"]["isObstacle"]
    # 120 m AGL over terrain >= 75 m AMSL is above the 150 m AMSL ceiling (+10 m margin).
    assert zones(api, altitudeM=120)["TEST-AIRPORT-EPBC"]["evaluation"]["status"] == "NOT_APPLICABLE_ALTITUDE"


def test_route_avoids_airport_fixtures_when_they_apply(api):
    a, b = {"latitude": 52.1550, "longitude": 20.9650}, {"latitude": 52.1900, "longitude": 20.9700}
    assert LineString([(a["longitude"], a["latitude"]), (b["longitude"], b["latitude"])]).intersects(GEOM["TEST-AIRPORT-EPWA"])
    r = route(api, a, b, altitude=80)
    assert r["status"] == "OK"
    assert not shape(r["geometry"]).intersects(GEOM["TEST-AIRPORT-EPWA"])


# --- routing: the map's obstacles are the router's obstacles -------------------------------

@pytest.mark.parametrize("a, b, crossed", [
    ("Białołęka", "Śródmieście", "TEST-P-NORTH"),
    ("Ursynów", "Wawer", "TEST-RM-SOUTH"),
    ("Praga-Południe", "Rembertów", "TEST-T-EAST-MID"),
    ("Włochy", "Mokotów", "TEST-RL-RING"),
])
def test_cross_district_routes_avoid_every_blocked_zone(api, city, a, b, crossed):
    start, dest = centroid(city, a), centroid(city, b)
    r = route(api, start, dest)
    assert r["status"] == "OK", r["message"]
    assert r["start"] == start and r["destination"] == dest  # user points preserved
    assert any(c["zoneId"] == crossed and c["relation"] == "DIRECT_LINE_BLOCKED" for c in r["zoneConflicts"])
    line = shape(r["geometry"])
    shown = zones(api)
    for zid, z in shown.items():
        if z["evaluation"]["isObstacle"]:
            assert not line.intersects(GEOM[zid]), f"route crosses {zid}"


def test_router_follows_the_map_evaluation_for_altitude(api):
    """TEST-RH-LOW (0-60 m AGL): inactive on the map at 80 m, so the shortest route may cross it;
    shown as an obstacle at 40 m, so the route must go around it."""
    a, b = {"latitude": 52.2030, "longitude": 21.0434}, {"latitude": 52.2176, "longitude": 21.0434}
    z = GEOM["TEST-RH-LOW"]
    high = route(api, a, b, altitude=80, objective="SHORTEST")
    assert high["status"] == "OK" and shape(high["geometry"]).intersects(z)
    assert zones(api, altitudeM=40)["TEST-RH-LOW"]["evaluation"]["isObstacle"]
    low = route(api, a, b, altitude=40, objective="SHORTEST")
    assert low["status"] == "OK", low["message"]
    assert not shape(low["geometry"]).intersects(z)


def test_no_route_when_start_is_enclosed_by_a_blocked_ring(client, city):
    outer, hole = box(21.200, 52.215, 21.220, 52.227), box(21.205, 52.218, 21.215, 52.224)
    ring = zone("TEST-RING-ENCLOSURE", Polygon(outer.exterior.coords, [hole.exterior.coords]))
    planner = RoutePlanner(city.grid, AirspaceRepository(StaticProvider([ring]), city.grid), city.coverage)
    r = planner.plan((21.210, 52.221), (21.150, 52.260), FlightMode.NORMAL, 80, PROFILE, CALM, NOW)
    assert r.status == RouteStatus.NO_ROUTE


# --- missing / incomplete data -------------------------------------------------------------

def _dataset(zones_, extent, source_type=SourceType.SYNTHETIC):
    return AirspaceDataset(provider="t", source_type=source_type, label="t", source_timestamp=None, disclaimer="",
                           zones=zones_, version="x", loaded_at=NOW, extent=extent, extent_label=None)


def test_dataset_that_misses_warsaw_is_reported_unavailable(city):
    state = build_state(_dataset([], box(19.0, 50.0, 19.1, 50.1)), city.grid)
    d = diagnostics(state, FlightContext(80, NOW), city.coverage, None)
    assert d.completeness.status == "NONE"
    assert {x.status for x in d.districts} == {"UNAVAILABLE"}
    assert all("UNKNOWN" in x.note for x in d.districts)


def test_zero_zones_in_a_covered_district_is_not_an_error(city):
    state = build_state(_dataset([], None, SourceType.PERMITTED_SNAPSHOT), city.grid)
    d = diagnostics(state, FlightContext(80, NOW), city.coverage, None)
    assert d.completeness.status == "COMPLETE"
    assert {x.status for x in d.districts} == {"OFFICIAL_SNAPSHOT"}  # never "VERIFIED"
    assert all(x.zone_count == 0 and "not a data error" in x.note for x in d.districts)


def test_real__dataset_is_flagged_partial(client):
    """Regression for the root cause: the bundled  zones only cover central Warsaw."""
    d = client.get("/api/v1/zones/diagnostics").json()
    assert d["completeness"]["status"] == "PARTIAL" and d["completeness"]["cityAreaCoveredPct"] < 10
    statuses = {x["name"]: x["status"] for x in d["districts"]}
    assert len(statuses) == 18
    assert statuses["Ursynów"] == statuses["Białołęka"] == "UNAVAILABLE"
    assert "VERIFIED" not in statuses.values()
    status = client.get("/api/v1/zones").json()["airspaceStatus"]
    assert status["sourceState"] == "SYNTHETIC" and status["officialCoveragePct"] == 0


def test_route_outside_the_dataset_extent_is_flagged(client):
    r = client.post("/api/v1/routes/calculate", json={
        "start": {"latitude": 52.2460, "longitude": 20.9041}, "destination": {"latitude": 52.2934, "longitude": 20.9261},
        "mode": "NORMAL", "flightAltitudeMeters": 80, "droneProfileId": "DEMO_DRONE_01", "weatherMode": "SAMPLE",
    }).json()
    assert r["status"] == "OK"
    assert r["coverage"]["airspaceOutsideExtentM"] > 1000
    assert "PARTIAL AIRSPACE DATA" in r["planningVerificationStatus"]


def test_missing_official_file_is_an_explicit_error():
    with pytest.raises(AirspaceLoadError, match="SKYROUTE_AIRSPACE_FILE"):
        make_provider("ed269", None)


# --- duplicates ------------------------------------------------------------------------------

def test_identical_duplicates_are_dropped_and_conflicts_rejected():
    a = zone("TEST-DUP", box(21.0, 52.2, 21.01, 52.21))
    kept, dropped = dedupe_zones([a, a.model_copy(), zone("TEST-OTHER", box(21.1, 52.2, 21.11, 52.21))], "t")
    assert [z.id for z in kept] == ["TEST-DUP", "TEST-OTHER"] and dropped == 1
    with pytest.raises(AirspaceLoadError, match="different content"):
        dedupe_zones([a, a.model_copy(update={"upper_altitude": 50.0})], "t")


def test_duplicate_feature_in_one_file_is_dropped(tmp_path):
    fc = feature_collection([CITYWIDE_ZONES[0], CITYWIDE_ZONES[0]], None, "dup")
    (tmp_path / "z.geojson").write_text(json.dumps(fc), encoding="utf-8")
    ds = GeoJsonZoneFileProvider(tmp_path / "z.geojson").load()
    assert len(ds.zones) == 1 and ds.duplicates_removed == 1


def test_composite_provider_merges_files_without_duplicates(tmp_path):
    a, b = tmp_path / "permanent.geojson", tmp_path / "temporary.geojson"
    a.write_text(json.dumps(feature_collection(CITYWIDE_ZONES[:3], None, "permanent")), encoding="utf-8")
    b.write_text(json.dumps(feature_collection(CITYWIDE_ZONES[2:5], None, "temporary")), encoding="utf-8")
    provider = make_provider("geojson", f"{a}{os.pathsep}{b}")
    assert isinstance(provider, CompositeProvider)
    ds = provider.load()
    assert [z.id for z in ds.zones] == [z.id for z in CITYWIDE_ZONES[:5]]
    assert ds.duplicates_removed == 1
    assert not provider.has_changed(ds)
    b.write_text(json.dumps(feature_collection(CITYWIDE_ZONES[2:6], None, "temporary")), encoding="utf-8")
    assert provider.has_changed(ds)
