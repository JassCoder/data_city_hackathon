"""Zone model, providers, per-flight evaluation and obstacle-aware routing."""

import json
from datetime import timedelta

import pytest
from shapely.geometry import LineString, MultiPolygon, Point, shape

from app.airspace.evaluation import FlightContext, evaluate
from app.airspace.geometry import geodesic_circle, geodesic_distance_m
from app.airspace.models import DisplayClass, EvaluationStatus, SourceType
from app.airspace.providers import AirspaceLoadError, Ed269FileProvider, GeoJsonZoneFileProvider
from app.airspace.factory import make_provider
from app.airspace.repository import AirspaceRepository
from app.routing.costs import FlightMode
from app.routing.grid import lonlat_to_xy, to_metres
from app.schemas.planning import RouteStatus
from tests.conftest import CALM, EAST, NOW, PROFILE, WEST, lon_box, make_planner, zone

WALL = lon_box(21.0045, 52.2300, 21.0055, 52.2350)  # open at the northern edge
FULL_WALL = lon_box(21.0045, 52.2290, 21.0055, 52.2370)  # spans the whole test area


def ctx(alt=80, at=NOW, mode=FlightMode.NORMAL):
    return FlightContext(altitude_agl_m=alt, at=at, mode=mode)


def plan(planner, start=WEST, dest=EAST, mode=FlightMode.NORMAL, alt=80, at=NOW):
    return planner.plan(start, dest, mode, alt, PROFILE, CALM, at)


def metric_line(r):
    return LineString([lonlat_to_xy(*c) for c in r.path_lonlat])


def metric(z):
    return to_metres(shape(z.geojson_geometry))


# --- evaluation ----------------------------------------------------------------

@pytest.mark.parametrize("category, status, colour, obstacle", [
    ("DRA-P", EvaluationStatus.BLOCKED, DisplayClass.RED, True),
    ("DRA-R", EvaluationStatus.UNAVAILABLE_AUTHORIZATION, DisplayClass.RED, True),
    ("DRA-RH", EvaluationStatus.UNAVAILABLE_AUTHORIZATION, DisplayClass.RED, True),
    ("DRA-RM", EvaluationStatus.UNAVAILABLE_AUTHORIZATION, DisplayClass.RED, True),
    ("DRA-RL", EvaluationStatus.UNAVAILABLE_AUTHORIZATION, DisplayClass.RED, True),
    ("DRA-T", EvaluationStatus.UNAVAILABLE_TECHNICAL, DisplayClass.YELLOW, True),
    ("DRA-U", EvaluationStatus.UNAVAILABLE_USPACE, DisplayClass.ORANGE, True),
    ("DRA-I", EvaluationStatus.INFORMATION, DisplayClass.YELLOW, False),
    ("UNKNOWN", EvaluationStatus.UNVERIFIED, DisplayClass.GRAY, True),
])
def test_category_evaluation(category, status, colour, obstacle):
    e = evaluate(zone("Z", WALL, category=category), ctx())
    assert (e.status, e.display_class, e.is_obstacle) == (status, colour, obstacle)
    assert e.reasons


def test_restricted_likelihood_is_explained_not_treated_as_permission():
    rh = evaluate(zone("Z", WALL, category="DRA-RH"), ctx())
    rl = evaluate(zone("Z", WALL, category="DRA-RL"), ctx())
    assert "highly likely" in rh.reasons[-1] and rh.is_obstacle
    assert "low likelihood" in rl.reasons[-1] and rl.is_obstacle


def test_information_zone_blocks_if_restriction_independently_requires_it():
    e = evaluate(zone("Z", WALL, category="DRA-I", restriction="PROHIBITED"), ctx())
    assert e.is_obstacle and e.display_class == DisplayClass.RED


def test_missing_source_is_unverified_obstacle():
    e = evaluate(zone("Z", WALL, category="DRA-I", source=None), ctx())
    assert e.status == EvaluationStatus.UNVERIFIED and e.is_obstacle and e.display_class == DisplayClass.GRAY


def test_validity_period():
    z = zone("Z", WALL, start=NOW - timedelta(days=30), end=NOW - timedelta(days=1))
    assert evaluate(z, ctx()).status == EvaluationStatus.NOT_ACTIVE_TIME
    assert not evaluate(z, ctx()).is_obstacle
    future = zone("Z", WALL, start=NOW + timedelta(hours=1))
    assert evaluate(future, ctx()).status == EvaluationStatus.NOT_ACTIVE_TIME
    open_ended = zone("Z", WALL, start=NOW - timedelta(days=1), end=None)
    assert evaluate(open_ended, ctx()).is_obstacle


def test_altitude_band_agl():
    low = zone("Z", WALL, lower=0, upper=60)
    assert evaluate(low, ctx(alt=40)).is_obstacle
    assert evaluate(low, ctx(alt=70)).is_obstacle  # within the 10 m vertical margin
    assert evaluate(low, ctx(alt=80)).status == EvaluationStatus.NOT_APPLICABLE_ALTITUDE
    high = zone("Z", WALL, lower=150, upper=None)  # unknown ceiling = unlimited
    assert not evaluate(high, ctx(alt=120)).is_obstacle
    assert evaluate(zone("Z", WALL, lower=100, upper=None), ctx(alt=120)).is_obstacle


def test_altitude_band_amsl_uses_terrain_range_conservatively():
    # Terrain 75–120 m AMSL: an 80 m AGL flight spans 155–200 m AMSL.
    assert evaluate(zone("Z", WALL, lower=None, upper=170, ref="AMSL"), ctx(alt=80)).is_obstacle
    assert not evaluate(zone("Z", WALL, lower=None, upper=100, ref="AMSL"), ctx(alt=120)).is_obstacle


def test_unknown_altitude_reference_applies_everywhere():
    e = evaluate(zone("Z", WALL, lower=500, upper=600, ref="UNKNOWN"), ctx(alt=40))
    assert e.is_obstacle and any("reference unknown" in r for r in e.reasons)


def test_endpoint_evaluation_includes_climb_from_ground():
    low = zone("Z", WALL, lower=0, upper=60)
    assert not evaluate(low, ctx(alt=100)).is_obstacle  # cruise passes above
    assert evaluate(low, ctx(alt=100), endpoint=True).is_obstacle  # take-off climbs through it


# --- geometry & providers --------------------------------------------------------

def test_geodesic_circle_is_accurate():
    lon, lat, r = 21.0152, 52.2478, 140.0
    poly = geodesic_circle(lon, lat, r)
    dists = [geodesic_distance_m(lon, lat, x, y) for x, y in poly.exterior.coords[:-1]]
    assert max(abs(d - r) for d in dists) < 0.01
    area = to_metres(poly).area
    assert area == pytest.approx(3.14159 * r * r, rel=0.005)


def test_default_provider_has_no_airspace_data():
    ds = make_provider().load()
    assert ds.source_type == SourceType.NONE
    assert not ds.zones
    assert "No airspace zones are loaded" in ds.disclaimer


def test_geojson_provider_rejects_invalid_zone(tmp_path):
    doc = {
        "metadata": {"sourceType": "SYNTHETIC"},
        "features": [
            {
                "type": "Feature",
                "properties": {"draCategory": "DRA-Z"},
                "geometry": {
                    "type": "Polygon",
                    "coordinates": [[[21, 52], [21.01, 52], [21.01, 52.01], [21, 52]]],
                },
            }
        ],
    }
    bad = tmp_path / "zones.geojson"
    bad.write_text(json.dumps(doc), encoding="utf-8")
    with pytest.raises(AirspaceLoadError, match="feature 0"):
        GeoJsonZoneFileProvider(bad).load()


def test_official_provider_requires_a_file():
    with pytest.raises(AirspaceLoadError, match="SKYROUTE_AIRSPACE_FILE"):
        make_provider("ed269", None)


ED269_SAMPLE = {
    "title": "Sample ED-269 export (test fixture, synthetic)",
    "features": [
        {
            "identifier": "EPDRA-P-001", "name": "DRA-P test polygon", "restriction": "PROHIBITED",
            "applicability": [{"permanent": "YES"}],
            "geometry": [{
                "uomDimensions": "M", "lowerLimit": 0, "lowerVerticalReference": "AGL",
                "upperLimit": 120, "upperVerticalReference": "AGL",
                "horizontalProjection": {"type": "Polygon", "coordinates": [[[21.0, 52.23], [21.01, 52.23], [21.01, 52.235], [21.0, 52.23]]]},
            }],
        },
        {
            "identifier": "EPDRA-RM-002", "name": "Test zone", "otherReasonInfo": "DRA-RM", "restriction": "REQ_AUTHORISATION",
            "message": "Consent of the requester required.",
            "applicability": [{"permanent": "NO", "startDateTime": "2026-10-01T00:00:00Z", "endDateTime": "2026-12-31T23:59:59Z"}],
            "geometry": [{
                "uomDimensions": "FT", "lowerLimit": 0, "lowerVerticalReference": "AMSL",
                "upperLimit": 1000, "upperVerticalReference": "AMSL",
                "horizontalProjection": {"type": "Circle", "center": [21.02, 52.24], "radius": 500},
            }],
        },
    ],
}


def test_ed269_parsing(tmp_path):
    path = tmp_path / "pansa_ed269.json"
    path.write_text(json.dumps(ED269_SAMPLE), encoding="utf-8")
    ds = Ed269FileProvider(path).load()
    assert ds.source_type == SourceType.PERMITTED_SNAPSHOT
    p, rm = ds.zones
    assert p.dra_category == "DRA-P" and p.restriction_type == "PROHIBITED" and p.validity_end is None
    assert rm.dra_category == "DRA-RM" and rm.restriction_type == "AUTHORIZATION_REQUIRED"
    assert rm.circle.radius_m == pytest.approx(152.4)  # 500 ft
    assert rm.upper_altitude == pytest.approx(304.8) and rm.altitude_reference == "AMSL"
    assert rm.validity_start.year == 2026 and rm.operational_conditions.startswith("Consent")
    assert rm.verification_status == "OFFICIAL_UNVERIFIED_LOCALLY"


def test_ed269_without_dra_label_is_unknown_category(tmp_path):
    doc = {"features": [dict(ED269_SAMPLE["features"][0], name="Zone 7", identifier="EP7")]}
    path = tmp_path / "x.json"
    path.write_text(json.dumps(doc), encoding="utf-8")
    z = Ed269FileProvider(path).load().zones[0]
    assert z.dra_category == "UNKNOWN" and z.restriction_type == "PROHIBITED"  # still blocked


# --- routing against zones ---------------------------------------------------------

@pytest.mark.parametrize("mode", list(FlightMode))
def test_prohibited_polygon_avoidance_both_modes(mode):
    p_zone = zone("P", WALL)
    planner = make_planner(zones=[p_zone])
    r = plan(planner, mode=mode)
    assert r.status == RouteStatus.OK
    assert LineString([lonlat_to_xy(*WEST), lonlat_to_xy(*EAST)]).intersects(metric(p_zone))
    assert not metric_line(r).intersects(metric(p_zone))
    assert ("DIRECT_LINE_BLOCKED", "P") in [(c.relation, c.zone_id) for c in r.conflicts]


def test_route_keeps_the_safety_margin_from_obstacles():
    p_zone = zone("P", WALL)
    r = plan(make_planner(zones=[p_zone], margin_m=20.0))
    assert metric_line(r).distance(metric(p_zone)) > 10.0  # margin + cell rasterisation


def test_restricted_zone_is_conditional_on_altitude_band():
    rm = zone("RM", FULL_WALL, category="DRA-RM", lower=0, upper=60)
    planner = make_planner(zones=[rm])
    assert plan(planner, alt=40).status == RouteStatus.NO_ROUTE  # inside band: unavailable
    high = plan(planner, alt=90)
    assert high.status == RouteStatus.OK  # above band: not applicable
    assert high.distance_m < 650  # straight across


def test_zone_outside_validity_is_passable():
    expired = zone("P", FULL_WALL, start=NOW - timedelta(days=10), end=NOW - timedelta(days=1))
    planner = make_planner(zones=[expired])
    assert plan(planner).status == RouteStatus.OK
    assert plan(planner, at=NOW - timedelta(days=5)).status == RouteStatus.NO_ROUTE


def test_information_zone_is_crossed_with_warning():
    info = zone("I", FULL_WALL, category="DRA-I")
    r = plan(make_planner(zones=[info]))
    assert r.status == RouteStatus.OK
    assert ("ROUTE_CROSSES_INFO", "I") in [(c.relation, c.zone_id) for c in r.conflicts]
    assert any("information zone" in w for w in r.warnings)


def test_unknown_conditions_block_conservatively():
    r = plan(make_planner(zones=[zone("X", FULL_WALL, category="UNKNOWN", lower=None, upper=None, ref="UNKNOWN")]))
    assert r.status == RouteStatus.NO_ROUTE


def test_multipolygon_zone_avoided():
    parts = MultiPolygon([lon_box(21.0045, 52.2300, 21.0055, 52.2325), lon_box(21.0045, 52.2335, 21.0055, 52.2370)])
    mp = zone("MP", parts)  # two parts with a ~110 m gap between them
    r = plan(make_planner(zones=[mp]))
    assert r.status == RouteStatus.OK
    assert not metric_line(r).intersects(metric(mp))
    assert r.distance_m < 700  # uses the gap instead of going around both parts


def test_circular_zone_avoided_with_geodesic_geometry():
    c = zone("C", circle=(21.0050, 52.2330, 120.0))
    r = plan(make_planner(zones=[c]))
    assert r.status == RouteStatus.OK
    assert not metric_line(r).intersects(metric(c))
    assert metric_line(r).distance(to_metres(Point(21.0050, 52.2330))) > 120.0


def test_route_near_boundary_never_touches_it():
    # Destination just outside the zone edge (8 m): allowed, joined from the margin.
    edge = zone("P", lon_box(21.0060, 52.2300, 21.0100, 52.2360))
    dest = (21.00588, 52.2330)  # west of the zone's west edge (21.0060)
    r = plan(make_planner(zones=[edge]), dest=dest)
    assert r.status == RouteStatus.OK
    assert r.path_lonlat[-1] == pytest.approx(dest, abs=1e-6)  # exact selected point, not relocated
    assert not metric_line(r).intersects(metric(edge))


def test_start_and_destination_inside_blocked_zone():
    planner = make_planner(zones=[zone("P", WALL, name="Wall P")])
    inside = (21.0050, 52.2320)
    s = plan(planner, start=inside)
    d = plan(planner, dest=inside)
    assert s.status == RouteStatus.START_BLOCKED and s.path_lonlat is None
    assert d.status == RouteStatus.DESTINATION_BLOCKED and d.path_lonlat is None
    assert "Wall P" in d.message and d.conflicts[0].relation == "DESTINATION_INSIDE"


def test_no_route_when_zones_enclose_destination():
    ring = lon_box(21.0065, 52.2310, 21.0100, 52.2350).difference(lon_box(21.0075, 52.2320, 21.0095, 52.2340))
    r = plan(make_planner(zones=[zone("RING", ring)]), dest=(21.0085, 52.2330))
    assert r.status == RouteStatus.NO_ROUTE and r.path_lonlat is None


def test_diagonal_corner_between_two_zones_is_not_crossed():
    # Two prohibited squares touching at one corner, spanning the full height of
    # the test area: the shared corner point is the only "passage", and a drone
    # must not squeeze through it, so there is no route.
    a = zone("A", lon_box(21.0040, 52.2300, 21.0050, 52.2330))
    b = zone("B", lon_box(21.0050, 52.2330, 21.0060, 52.2360))
    start, dest = (21.0030, 52.2345), (21.0070, 52.2315)
    r = plan(make_planner(zones=[a, b], margin_m=0), start=start, dest=dest)
    assert r.status == RouteStatus.NO_ROUTE and r.path_lonlat is None
    # Shift B north to open a real gap: now a route exists and touches neither square.
    b2 = zone("B", lon_box(21.0050, 52.2340, 21.0060, 52.2360))
    r2 = plan(make_planner(zones=[a, b2], margin_m=0), start=start, dest=dest)
    assert r2.status == RouteStatus.OK
    line = metric_line(r2)
    assert not line.intersects(metric(a)) and not line.intersects(metric(b2))


def test_route_recomputed_after_obstacle_change():
    planner = make_planner()
    before = plan(planner)
    assert before.status == RouteStatus.OK and before.distance_m < 600
    v1 = planner.airspace.state.version
    planner.airspace.provider.set_zones([zone("P", WALL)])
    after = plan(planner)
    assert planner.airspace.state.version != v1
    assert after.status == RouteStatus.OK and after.distance_m > before.distance_m * 1.2
    planner.airspace.provider.set_zones([zone("P", FULL_WALL)])
    assert plan(planner).status == RouteStatus.NO_ROUTE


def test_broken_dataset_update_keeps_last_good_version(tmp_path):
    path = tmp_path / "zones.geojson"
    path.write_text(json.dumps({
        "type": "FeatureCollection",
        "metadata": {"sourceType": "SYNTHETIC"},
        "features": [],
    }), encoding="utf-8")
    planner = make_planner()
    repo = AirspaceRepository(GeoJsonZoneFileProvider(path), planner.grid)
    v1 = repo.state.version
    path.write_text("{ not json", encoding="utf-8")
    assert repo.refresh().version == v1 and repo.last_error
