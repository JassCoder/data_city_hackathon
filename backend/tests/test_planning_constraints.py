"""SkyRoute planning constraints (OSM airport / military / government areas) on the real Warsaw grid."""

import json

import pytest
from shapely.geometry import LineString, shape

from app.airspace.constraints import WithPlanningConstraints, load_constraints, with_planning_constraints
from app.airspace.evaluation import FlightContext, evaluate
from app.airspace.models import DraCategory, SourceType
from app.airspace.providers import AirspaceLoadError, EmptyProvider, GeoJsonZoneFileProvider
from app.airspace.repository import AirspaceRepository
from app.airspace.status import airspace_status
from app.config import PLANNING_CONSTRAINTS_FILE
from app.routing.costs import FlightMode
from app.routing.grid import lonlat_to_xy, to_metres
from app.routing.planner import RoutePlanner
from app.schemas.planning import RouteStatus
from tests.conftest import CALM, NOW, PROFILE

FC = json.loads(PLANNING_CONSTRAINTS_FILE.read_text(encoding="utf-8"))


def feature(kind, name_part):
    return next(f for f in FC["features"] if f["properties"]["kind"] == kind
                and name_part in (f["properties"]["name"] or ""))


CHOPIN = shape(feature("AIRPORT", "Chopin")["geometry"])


@pytest.fixture(scope="module")
def planner(client):
    base = client.app.state.planner
    repo = AirspaceRepository(WithPlanningConstraints(EmptyProvider()), base.grid)
    return RoutePlanner(base.grid, repo, base.coverage)


def test_file_holds_real_airport_military_and_government_footprints():
    kinds = {f["properties"]["kind"] for f in FC["features"]}
    assert kinds == {"AIRPORT", "MILITARY", "GOVERNMENT"}
    icao = {f["properties"]["osmTags"].get("icao") for f in FC["features"] if f["properties"]["kind"] == "AIRPORT"}
    assert {"EPWA", "EPBC"} <= icao
    assert feature("GOVERNMENT", "Sejm")  # repaired OSM multipolygon is kept
    assert "NOT official" in FC["metadata"]["description"]


def test_constraints_are_blocked_red_obstacles_labelled_as_policy():
    zones, _ = load_constraints(PLANNING_CONSTRAINTS_FILE)
    z = next(z for z in zones if "Chopin" in z.name)
    assert z.dra_category == DraCategory.PLANNING and z.source_type == SourceType.PLANNING_CONSTRAINT
    assert "Not an official UAS geographical zone" in z.operational_conditions
    for alt in (20, 120):
        e = evaluate(z, FlightContext(altitude_agl_m=alt, at=NOW, mode=FlightMode.EMERGENCY))
        assert e.display_class == "RED" and e.is_obstacle and "Not an official UAS zone" in e.reasons[-1]


def test_route_across_chopin_airport_goes_around_it(planner):
    a, b = (20.950, 52.166), (21.000, 52.166)  # west and east of the airport, straight line crosses it
    assert LineString([a, b]).intersects(CHOPIN)
    for mode in FlightMode:
        r = planner.plan(a, b, mode, 80, PROFILE, CALM, NOW)
        assert r.status == RouteStatus.OK, r.message
        line = LineString([lonlat_to_xy(lon, lat) for lon, lat in r.path_lonlat])
        assert not line.intersects(to_metres(CHOPIN))
        assert r.path_lonlat[0] == pytest.approx(a, abs=1e-6) and r.path_lonlat[-1] == pytest.approx(b, abs=1e-6)


def test_destination_inside_the_airport_or_a_government_building_is_blocked(planner):
    for geom in (CHOPIN, shape(feature("GOVERNMENT", "Sejm")["geometry"])):
        p = geom.representative_point()
        r = planner.plan((20.98, 52.20), (p.x, p.y), FlightMode.NORMAL, 80, PROFILE, CALM, NOW)
        assert r.status == RouteStatus.DESTINATION_BLOCKED


def test_constraints_never_count_as_official_airspace(client, planner):
    state = planner.airspace.refresh()
    assert state.dataset.source_type == SourceType.NONE  # base metadata kept
    status = airspace_status(state, client.app.state.planner.coverage)
    assert not status.official_data_available and status.source_state == "UNAVAILABLE"
    assert len(state.zones) == len(FC["features"])


def test_switch_and_missing_file(tmp_path):
    base = EmptyProvider()
    assert with_planning_constraints(base, "off") is base
    with pytest.raises(AirspaceLoadError, match="missing"):
        with_planning_constraints(base, "on", tmp_path / "none.geojson")
    with pytest.raises(AirspaceLoadError, match="Unknown"):
        with_planning_constraints(base, "maybe")


def test_wrapper_reloads_only_when_the_file_changes(tmp_path):
    path = tmp_path / "pc.geojson"
    path.write_text(json.dumps({**FC, "features": FC["features"][:3]}), encoding="utf-8")
    provider = WithPlanningConstraints(EmptyProvider(), path)
    ds = provider.load()
    assert len(ds.zones) == 3 and not provider.has_changed(ds)
    path.write_text(json.dumps({**FC, "features": FC["features"][:5]}), encoding="utf-8")
    assert provider.has_changed(ds) and len(provider.load().zones) == 5


def test_airspace_files_cannot_claim_the_planning_category(tmp_path):
    f = feature("AIRPORT", "Chopin")
    bad = {"type": "FeatureCollection", "features": [{"type": "Feature", "geometry": f["geometry"],
           "properties": {"id": "X", "name": "X", "draCategory": "PLANNING", "restrictionType": "PROHIBITED"}}]}
    path = tmp_path / "zones.geojson"
    path.write_text(json.dumps(bad), encoding="utf-8")
    with pytest.raises((AirspaceLoadError, ValueError)):
        GeoJsonZoneFileProvider(path).load()
