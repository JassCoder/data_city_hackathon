"""Full-Warsaw geographic coverage: districts, long routes, boundary, adaptive search,
buildings, airports, coverage metrics and airspace source states (real /data)."""

import asyncio
import importlib.util
from datetime import datetime, timedelta, timezone

import httpx
import numpy as np
import pytest
from shapely.geometry import LineString, Point, box, shape

from app.airspace.models import SourceType
from app.airspace.providers import AirspaceDataset, EmptyProvider
from app.airspace.repository import AirspaceRepository
from app.airspace.status import SourceState, airspace_status, source_state
from app.config import CITY_GRID_FILE, REPO_ROOT
from app.dependencies import get_airspace, get_planner
from app.geo.coverage import Coverage
from app.routing.costs import FlightMode
from app.routing.grid import UnknownHeightPolicy, load_city_grid
from app.routing.planner import RoutePlanner
from app.schemas.planning import WeatherMode, WeatherSource
from app.services.coverage_service import geographic_routing, weather_status
from app.services.weather import WeatherService
from tests.conftest import StaticProvider, zone

API = "/api/v1"
NOW = datetime(2026, 10, 18, 12, 0, tzinfo=timezone.utc)


def body(a, b, altitude=80, **extra):
    return {"start": a, "destination": b, "mode": "NORMAL", "flightAltitudeMeters": altitude,
            "droneProfileId": "DEMO_DRONE_01", "weatherMode": "SAMPLE", **extra}


def pt(lon, lat):
    return {"latitude": lat, "longitude": lon}


@pytest.fixture(scope="module")
def city(client):
    return client.app.state.planner


def rep_points(city):
    return {d.name: d.geom.representative_point() for d in city.coverage.districts}


# --- all 18 districts ----------------------------------------------------------------

def test_every_district_has_a_routable_location(client, city):
    points = rep_points(city)
    assert len(points) == 18
    names = sorted(points)
    for i, name in enumerate(names):
        a, b = points[name], points[names[(i + 1) % len(names)]]
        assert city.coverage.district_of(a.x, a.y) == name
        r = client.post(f"{API}/routes/calculate", json=body(pt(a.x, a.y), pt(b.x, b.y))).json()
        assert r["status"] == "OK", f"{name} -> {names[(i + 1) % len(names)]}: {r['message']}"
        assert r["coverage"]["startDistrict"] == name
        assert r["start"] == pt(a.x, a.y)  # the user's point, unchanged


def test_long_distance_route_across_the_city(client):
    north, south = pt(21.005, 52.345), pt(21.04, 52.115)  # Białołęka -> Ursynów, ~26 km
    r = client.post(f"{API}/routes/calculate", json=body(north, south)).json()
    assert r["status"] == "OK", r["message"]
    assert r["coverage"]["startDistrict"] == "Białołęka" and r["coverage"]["destinationDistrict"] == "Ursynów"
    assert r["distanceM"] > 25_000
    assert r["search"]["resolutionM"] >= 25 and r["search"]["elapsedMs"] < 20_000


# --- boundary --------------------------------------------------------------------------

def test_points_inside_the_bbox_but_outside_the_polygon_are_rejected(client, city):
    corner = (20.87, 52.36)  # inside the city's bounding box, outside the official polygon
    w, s, e, n = city.coverage.bounds
    assert w < corner[0] < e and s < corner[1] < n and not city.coverage.contains(*corner)
    r = client.post(f"{API}/routes/calculate", json=body(pt(*corner), pt(21.01, 52.23))).json()
    assert r["status"] == "OUTSIDE_COVERAGE" and r["geometry"] is None


# --- adaptive search -------------------------------------------------------------------

def test_search_window_expands_when_the_first_corridor_is_insufficient(client, city):
    wall = zone("TEST-WALL", box(21.020, 52.195, 21.024, 52.265))  # ~7.8 km north-south wall
    planner = RoutePlanner(city.grid, AirspaceRepository(StaticProvider([wall]), city.grid), city.coverage)
    from tests.conftest import CALM, PROFILE
    r = planner.plan((21.000, 52.230), (21.045, 52.230), FlightMode.NORMAL, 80, PROFILE, CALM, NOW)
    assert r.status == "OK"
    assert r.search.attempts >= 2
    xs, ys = zip(*r.path_lonlat)
    assert max(ys) > 52.265 or min(ys) < 52.195  # went around the end of the wall
    assert not LineString(r.path_lonlat).intersects(shape(wall.geojson_geometry))


# --- buildings ---------------------------------------------------------------------------

def _fetch_osm():
    spec = importlib.util.spec_from_file_location("fetch_osm", REPO_ROOT / "scripts" / "fetch_osm.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def test_unknown_building_heights_are_never_invented():
    f = _fetch_osm()
    assert f.building_height({"building": "yes"}) == (None, "unknown")
    assert f.building_height({"building:levels": "4"}) == (12.0, "levels_x3")
    assert f.building_height({"height": "31 m"}) == (31.0, "osm_height")


def test_raster_keeps_unknown_heights_as_a_separate_mask():
    f = _fetch_osm()
    from app.routing.grid import to_metres
    area = to_metres(box(21.0, 52.23, 21.003, 52.232))
    r = f.Raster(area)
    r.add_building(to_metres(box(21.0005, 52.2305, 21.0012, 52.2310)), None)
    r.add_building(to_metres(box(21.0020, 52.2305, 21.0027, 52.2310)), 20.0)
    assert r.unknown.any() and r.height.max() == 20.0
    assert not (r.unknown & (r.height > 0)).any()


def test_unknown_height_policy_is_explicit_and_configurable(city):
    assert UnknownHeightPolicy.parse("assume:15") == UnknownHeightPolicy("assume", 15.0)
    with pytest.raises(Exception):
        UnknownHeightPolicy.parse("guess")
    unknown = city.grid.unknown_height
    assert unknown is not None and unknown.sum() > 1000
    assumed = city.grid.building_height
    assert (assumed[unknown] >= 15).all()
    blocked = load_city_grid(CITY_GRID_FILE, None, UnknownHeightPolicy.parse("block")).building_height
    assert np.isinf(blocked[unknown]).all()
    # at 120 m only the "block" policy keeps unknown-height cells as obstacles
    assert (blocked >= 110).sum() > (assumed >= 110).sum()


def test_buildings_bbox_returns_intersecting_footprints_with_mapped_heights(client):
    small = client.get(f"{API}/buildings", params={"bbox": "21.010,52.230,21.015,52.233"}).json()
    assert small["type"] == "FeatureCollection" and small["metadata"]["count"] > 0
    q = box(21.010, 52.230, 21.015, 52.233)
    assert all(shape(f["geometry"]).intersects(q) for f in small["features"])
    edge = [f for f in small["features"] if not q.contains(shape(f["geometry"]).representative_point())]
    assert edge, "footprints crossing the bbox edge must be included"
    for f in small["features"]:
        p = f["properties"]
        assert (p["height_m"] is None) == (p["height_source"] == "unknown")
    assert client.get(f"{API}/buildings", params={"bbox": "20.9,52.1,21.1,52.3"}).status_code == 422  # too large
    assert client.get(f"{API}/buildings", params={"bbox": "19.0,50.0,19.01,50.01"}).json()["features"] == []


# --- airports ----------------------------------------------------------------------------

def test_airports_are_real_osm_footprints_and_informative_only(client):
    fc = client.get(f"{API}/airports").json()
    by_icao = {f["properties"]["icao"]: f for f in fc["features"] if f["properties"]["icao"]}
    assert {"EPWA", "EPBC"} <= set(by_icao)
    assert "INFORMATIVE" in fc["metadata"]["regulatoryStatus"]
    epwa = shape(by_icao["EPWA"]["geometry"])
    assert epwa.geom_type in ("Polygon", "MultiPolygon") and epwa.contains(Point(20.967, 52.166))
    # A real footprint, not a circle: far from round
    assert epwa.area / epwa.minimum_rotated_rectangle.area < 0.95
    assert {f["properties"]["icao"] for f in client.get(f"{API}/airports", params={"bbox": "20.90,52.26,20.92,52.27"}).json()["features"]} == {"EPBC"}
    zone_ids = {z["id"] for z in client.get(f"{API}/zones").json()["zones"]}
    assert not any("EPWA" in z or "EPBC" in z for z in zone_ids)  # never turned into zones


def test_planning_constraints_are_optional_and_non_regulatory(client):
    a, b = pt(20.930, 52.170), pt(21.000, 52.160)  # Włochy (west) and Ursynów (east) of the Chopin footprint
    epwa = shape(next(f for f in client.get(f"{API}/airports").json()["features"] if f["properties"]["icao"] == "EPWA")["geometry"])
    off = client.post(f"{API}/routes/calculate", json=body(a, b, routeObjective="SHORTEST")).json()
    assert off["status"] == "OK" and not off["planningConstraintsApplied"]
    assert shape(off["geometry"]).intersects(epwa)  # airports are not zones: crossing is allowed by default
    on = client.post(f"{API}/routes/calculate", json=body(a, b, routeObjective="SHORTEST", planningConstraints=True)).json()
    assert on["status"] == "OK" and on["planningConstraintsApplied"]
    assert not shape(on["geometry"]).intersects(epwa)
    assert any("NON-REGULATORY PLANNING CONSTRAINT" in w for w in on["warnings"])
    inside = client.post(f"{API}/routes/calculate", json=body(pt(20.967, 52.166), b, planningConstraints=True)).json()
    assert inside["status"] == "START_BLOCKED" and "NON-REGULATORY" in inside["message"]


# --- airspace source states & unverified simulation ---------------------------------------

def test_source_states():
    fresh, old = NOW - timedelta(days=3), NOW - timedelta(days=60)
    assert source_state(SourceType.NONE, None, NOW) == SourceState.UNAVAILABLE
    assert source_state(SourceType.SYNTHETIC, old, NOW) == SourceState.SYNTHETIC
    assert source_state(SourceType.PERMITTED_SNAPSHOT, fresh, NOW) == SourceState.OFFICIAL_SNAPSHOT
    assert source_state(SourceType.PERMITTED_SNAPSHOT, old, NOW) == SourceState.STALE
    assert source_state(SourceType.PERMITTED_SNAPSHOT, None, NOW) == SourceState.STALE  # undated
    assert source_state(SourceType.OFFICIAL, fresh, NOW) == SourceState.OFFICIAL


def _snapshot(extent, ts):
    return AirspaceDataset(provider="pazp-file", source_type=SourceType.PERMITTED_SNAPSHOT, label="official file",
                           source_timestamp=ts, disclaimer="", zones=[], version="s1", loaded_at=NOW, extent=extent)


class _Fixed:
    name = "fixed"

    def __init__(self, ds):
        self.ds = ds

    def load(self):
        return self.ds

    def has_changed(self, dataset):
        return False


def test_official_coverage_comes_from_the_declared_extent_never_assumed(city):
    def status(extent, ts=NOW - timedelta(days=2)):
        return airspace_status(AirspaceRepository(_Fixed(_snapshot(extent, ts)), city.grid).state, city.coverage, NOW)

    whole = status(box(20.8, 52.0, 21.3, 52.4))
    assert whole.source_state == "OFFICIAL_SNAPSHOT" and whole.official_coverage_pct == pytest.approx(100, abs=0.1)
    assert whole.coverage_basis == "DECLARED_EXTENT"
    half = status(box(20.8, 52.0, 21.3, 52.23))
    assert 20 < half.official_coverage_pct < 80
    undeclared = status(None)
    assert undeclared.official_coverage_pct is None and undeclared.coverage_basis == "NOT_DECLARED"
    stale = status(box(20.8, 52.0, 21.3, 52.4), ts=NOW - timedelta(days=90))
    assert stale.source_state == "STALE" and not stale.official_data_available


def test__zones_never_count_as_official_coverage(client):
    m = client.get(f"{API}/map/coverage").json()["metrics"]
    assert m["officialAirspace"]["sourceState"] == "SYNTHETIC"
    assert m["officialAirspace"]["officialCoveragePct"] == 0 and not m["officialAirspace"]["officialDataAvailable"]
    assert "airspaceCompleteness" not in m  # dataset completeness is development-only
    dev = client.get(f"{API}/zones/diagnostics").json()
    assert dev["completeness"]["cityAreaCoveredPct"] < 10  # the  extent, diagnostics only
    assert dev["airspaceStatus"]["sourceState"] == "SYNTHETIC"


def test_missing_airspace_data_gives_unverified_simulation(client, overrides, city):
    empty = RoutePlanner(city.grid, AirspaceRepository(EmptyProvider(), city.grid), city.coverage)
    overrides[get_planner] = lambda: empty
    overrides[get_airspace] = lambda: empty.airspace
    zones = client.get(f"{API}/zones").json()
    assert zones["zones"] == [] and zones["airspaceStatus"]["sourceState"] == "UNAVAILABLE"
    r = client.post(f"{API}/routes/calculate", json=body(pt(20.95, 52.25), pt(21.10, 52.20))).json()
    assert r["status"] == "OK"
    assert r["planningVerificationStatus"].startswith("UNVERIFIED SIMULATION")
    assert "no zones were checked" in r["planningVerificationStatus"]
    assert r["airspaceVerification"]["sourceState"] == "UNAVAILABLE"
    assert not r["airspaceVerification"]["officialDataAvailable"]
    assert r["coverage"]["airspaceOutsideExtentM"] > 0
    assert any("Unknown airspace is not unrestricted airspace" in warning for warning in r["warnings"])


def test_stale_official_data_gives_unverified_simulation(client, overrides, city):
    stale = RoutePlanner(city.grid, AirspaceRepository(_Fixed(_snapshot(None, NOW - timedelta(days=400))), city.grid),
                         city.coverage)
    overrides[get_planner] = lambda: stale
    r = client.post(f"{API}/routes/calculate", json=body(pt(20.95, 52.25), pt(21.10, 52.20))).json()
    assert r["airspaceVerification"]["sourceState"] == "STALE"
    assert r["planningVerificationStatus"].startswith("UNVERIFIED SIMULATION") and "STALE" in r["planningVerificationStatus"]


# --- coverage metrics ------------------------------------------------------------------------

def test_geographic_routing_coverage_is_validated_citywide(client, city):
    g = client.get(f"{API}/map/coverage").json()["metrics"]["geographicRouting"]
    assert g["status"] == "VALIDATED" and g["pct"] == 100.0 and g["districts"] == 18
    assert {c["name"] for c in g["checks"]} >= {"all_18_districts", "routing_mask_matches_city", "raster_contains_city"}
    broken = Coverage(available=True, label=city.coverage.label, geom=city.coverage.geom,
                      districts=city.coverage.districts[:17], source=city.coverage.source)
    bad = geographic_routing(broken, city.grid)
    assert bad["status"] == "CHECKS_FAILED" and bad["pct"] < 100


def test_building_coverage_reports_heights_and_policy(client):
    b = client.get(f"{API}/map/coverage").json()["metrics"]["buildings"]
    assert b["status"] == "AVAILABLE" and b["buildings"] > 150_000
    assert b["unknownHeights"] > 0 and b["knownHeights"] + b["unknownHeights"] == b["buildings"]
    assert "assumption" in b["unknownHeightPolicy"] and "NOT verified" in b["method"]


def test_weather_provider_failure_is_reported():
    def fail(request):
        raise httpx.ConnectError("offline", request=request)

    async def run():
        async with httpx.AsyncClient(transport=httpx.MockTransport(fail)) as c:
            svc = WeatherService(c)
            info = await svc.get(WeatherMode.LIVE, 80)
            return svc, info

    svc, info = asyncio.run(run())
    assert info.source == WeatherSource.SAMPLE_FALLBACK and not info.live_available
    w = weather_status(svc)
    assert w["status"] == "LIVE_FAILING" and "ConnectError" in w["lastLiveError"] and w["supportsWarsaw"]
