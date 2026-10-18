"""Citywide coverage, corridor search and district-to-district routing on the
real data (official boundary, citywide OSM raster,  airspace)."""

import gzip
import json

import pytest
from shapely.geometry import LineString, shape

from app.config import ROUTE_MAX_EXPANSIONS, ROUTE_TIME_LIMIT_S
from app.dependencies import get_coverage, get_planner
from app.geo.coverage import load_city_coverage
from app.routing import planner as planner_module
from app.routing.costs import FlightMode
from app.schemas.planning import RouteStatus
from tests.conftest import CALM, EAST, NOW, PROFILE, WEST, lon_box, make_planner, zone

URL = "/api/v1/routes/calculate"

# (district, lat, lon): representative points, verified against the PRG district polygons below.
POINTS = {
    "Śródmieście": (52.2250, 21.0150),
    "Mokotów": (52.1950, 21.0300),
    "Wola": (52.2365, 20.9634),
    "Praga-Południe": (52.2398, 21.0828),
    "Ursynów": (52.1418, 21.0326),
    "Białołęka": (52.3200, 21.0000),
    "Bemowo": (52.2549, 20.9118),
    "Wawer": (52.1966, 21.1772),
    "Wilanów": (52.1652, 21.0886),
    "Bielany": (52.2856, 20.9450),
}
PAIRS = [("Śródmieście", "Mokotów"), ("Wola", "Praga-Południe"), ("Ursynów", "Białołęka"),
         ("Bemowo", "Wawer"), ("Wilanów", "Bielany")]


def pt(name):
    lat, lon = POINTS[name]
    return {"latitude": lat, "longitude": lon}


def body(start, dest, **over):
    return {"start": start, "destination": dest, "mode": "NORMAL", "flightAltitudeMeters": 80,
            "droneProfileId": "DEMO_DRONE_01", "weatherMode": "SAMPLE", **over}


@pytest.fixture(scope="module")
def city():
    return load_city_coverage()


@pytest.fixture(scope="module")
def obstacle_zones(client):
    zones = client.get("/api/v1/zones", params={"altitudeM": 80}).json()["zones"]
    return [shape(z["geojsonGeometry"]) for z in zones if z["evaluation"]["isObstacle"]]


def test_official_boundary_and_18_districts(city):
    assert city.available and "TERYT 1465" in city.label
    assert len(city.districts) == 18
    assert {d.teryt for d in city.districts} == {f"1465{n:02d}_8" for n in range(2, 20)}
    assert "GUGiK" in city.source["source"]


@pytest.mark.parametrize("name", list(POINTS))
def test_test_points_lie_in_their_districts(city, name):
    lat, lon = POINTS[name]
    assert city.district_of(lon, lat) == name


def test_point_in_polygon_not_bounding_box(city):
    w, s, e, n = city.bounds
    # Inside the bounding box but outside the city: north-west corner (Łomianki side).
    assert w < 20.86 and n > 52.36
    assert not city.contains(20.86, 52.36)
    assert city.contains(21.0122, 52.2297)


@pytest.mark.parametrize("a, b", PAIRS)
def test_district_to_district_routes(client, obstacle_zones, a, b):
    r = client.post(URL, json=body(pt(a), pt(b))).json()
    assert r["coverage"]["valid"] is True
    assert (r["coverage"]["startDistrict"], r["coverage"]["destinationDistrict"]) == (a, b)
    assert r["status"] in ("OK", "NO_ROUTE")  # feasibility is not assumed
    s = r["search"]
    assert s["expansions"] <= ROUTE_MAX_EXPANSIONS * s["attempts"]
    assert s["elapsedMs"] <= ROUTE_TIME_LIMIT_S * 1000 + 2000
    if r["status"] == "OK":
        line = LineString(r["geometry"]["coordinates"])
        assert not any(line.intersects(z) for z in obstacle_zones)
        assert r["distanceM"] >= line.length * 0  # distance present
        assert r["distanceM"] > 0 and r["etaS"] > 0


def test_long_distance_route_performance(client):
    r = client.post(URL, json=body(pt("Ursynów"), pt("Białołęka"))).json()
    assert r["status"] == "OK"
    assert r["distanceM"] > 18_000
    assert r["search"]["elapsedMs"] < ROUTE_TIME_LIMIT_S * 1000
    again = client.post(URL, json=body(pt("Ursynów"), pt("Białołęka"))).json()
    assert again["search"]["cached"] is True and again["geometry"] == r["geometry"]


def test_route_outside__airspace_extent_is_flagged(client):
    r = client.post(URL, json=body(pt("Bemowo"), pt("Wawer"))).json()
    assert r["status"] == "OK"
    assert r["coverage"]["airspaceOutsideExtentM"] > 1000
    assert "PARTIAL AIRSPACE DATA" in r["planningVerificationStatus"]
    assert any("NOT checked" in w for w in r["warnings"])


@pytest.mark.parametrize("which", ["start", "destination"])
def test_endpoint_outside_warsaw(client, which):
    outside = {"latitude": 52.0812, "longitude": 21.0240}  # Piaseczno
    req = body(outside, pt("Mokotów")) if which == "start" else body(pt("Mokotów"), outside)
    r = client.post(URL, json=req).json()
    assert r["status"] == "OUTSIDE_COVERAGE" and r["geometry"] is None
    assert ("Start" if which == "start" else "Destination") in r["message"]


def test_restricted_zone_near_destination(client):
    # Just west of the -P-SEJM polygon (west edge ~21.0245): allowed, ends at the exact point.
    dest = {"latitude": 52.2250, "longitude": 21.0243}  # ~25 m west of the zone edge
    r = client.post(URL, json=body(pt("Wola"), dest)).json()
    assert r["status"] == "OK"
    end = r["geometry"]["coordinates"][-1]
    assert end == pytest.approx([dest["longitude"], dest["latitude"]], abs=1e-6)
    assert any(c["zoneId"] == "-P-SEJM" for c in r["zoneConflicts"])


# --- map API -------------------------------------------------------------------

def test_boundary_endpoint(client):
    res = client.get("/api/v1/map/warsaw-boundary").json()
    assert res["city"]["properties"]["teryt"] == "1465"
    assert len(res["districts"]["features"]) == 18
    w, s, e, n = res["bounds"]
    assert 20.8 < w < 20.9 and 21.2 < e < 21.3 and 52.05 < s < 52.15 and 52.3 < n < 52.4


def test_coverage_endpoint(client):
    res = client.get("/api/v1/map/coverage").json()
    assert res["status"] == "AVAILABLE" and res["geometry"]["type"] in ("Polygon", "MultiPolygon")
    assert len(res["districts"]) == 18
    assert res["routing"]["cellSizeM"] == 25 and res["routing"]["maxExpansions"] == ROUTE_MAX_EXPANSIONS
    assert res["airspace"]["sourceType"] == "SYNTHETIC" and res["airspace"]["extent"]["type"] == "Polygon"


def test_building_tiles(client):
    index = client.get("/api/v1/map/coverage")  # warm
    assert index.status_code == 200
    # Palace of Culture tile at z14
    res = client.get("/api/v1/map/buildings/14/9148/5394", headers={"Accept-Encoding": "gzip"})
    assert res.status_code == 200
    fc = res.json()
    assert fc["type"] == "FeatureCollection" and len(fc["features"]) > 100
    assert client.get("/api/v1/map/buildings/14/1/1").json()["features"] == []  # outside Warsaw
    assert client.get("/api/v1/map/buildings/13/1/1").status_code == 422


def test_missing_boundary_data(client, overrides, tmp_path):
    missing = load_city_coverage(tmp_path / "nope.geojson", tmp_path / "nope2.geojson")
    assert missing.available is False and "missing" in missing.message.lower()
    overrides[get_coverage] = lambda: missing
    assert client.get("/api/v1/map/warsaw-boundary").status_code == 503
    planner = make_planner()
    planner.coverage = missing
    overrides[get_planner] = lambda: planner
    r = client.post(URL, json=body({"longitude": WEST[0], "latitude": WEST[1]},
                                   {"longitude": EAST[0], "latitude": EAST[1]})).json()
    assert r["status"] == "COVERAGE_UNAVAILABLE" and r["geometry"] is None


# --- corridor search mechanics (synthetic world) ------------------------------------

WALL = lon_box(21.0045, 52.2300, 21.0055, 52.2350)


def plan(planner, start=WEST, dest=EAST):
    return planner.plan(start, dest, FlightMode.NORMAL, 80, PROFILE, CALM, NOW)


def test_corridor_widens_until_a_route_is_found(monkeypatch):
    monkeypatch.setattr(planner_module, "ROUTE_MIN_MARGIN_M", 25.0)
    monkeypatch.setattr(planner_module, "ROUTE_MARGIN_FACTOR", 0.0)
    r = plan(make_planner(zones=[zone("P", WALL)]))
    assert r.status == RouteStatus.OK
    assert r.search.attempts > 1  # the tight first window had no way around the wall


def test_large_windows_are_coarsened_conservatively(monkeypatch):
    monkeypatch.setattr(planner_module, "ROUTE_MAX_FINE_CELLS", 100)
    p_zone = zone("P", WALL)
    r = plan(make_planner(zones=[p_zone], buildings=[(lon_box(21.0020, 52.2335, 21.0030, 52.2345), 200.0)]))
    assert r.status == RouteStatus.OK and r.search.resolution_m > 25
    from app.routing.grid import lonlat_to_xy, to_metres

    line = LineString([lonlat_to_xy(*c) for c in r.path_lonlat])
    assert not line.intersects(to_metres(shape(p_zone.geojson_geometry)))


def test_search_limit_gives_explicit_error(monkeypatch):
    monkeypatch.setattr(planner_module, "ROUTE_MAX_EXPANSIONS", 20)
    r = plan(make_planner(zones=[zone("P", WALL)]))
    assert r.status == RouteStatus.SEARCH_LIMIT
    assert r.path_lonlat is None and "limit" in r.message


def test_no_valid_route_reports_whole_coverage(monkeypatch):
    full = lon_box(21.0045, 52.2290, 21.0055, 52.2370)
    r = plan(make_planner(zones=[zone("P", full)]))
    assert r.status == RouteStatus.NO_ROUTE and r.search.whole_city
    assert "anywhere in the Warsaw coverage" in r.message
