"""Red geofencing: blocked zone geometry (holes, multipolygons, several zones) is what A* avoids.

All zones here are SYNTHETIC test geometry, not real airspace.
"""

import math

import pytest
from shapely.geometry import LineString, MultiPolygon

from app.airspace.summary import OFFICIAL_UNAVAILABLE
from app.routing.costs import FlightMode
from app.routing.grid import lonlat_to_xy, to_metres
from app.schemas.planning import RouteStatus
from tests.conftest import CALM, EAST, NOW, PROFILE, WEST, lon_box, make_planner, zone
from tests.test_citywide_airspace import api, city, zones  # noqa: F401  (fixtures)


def _plan(planner, start=WEST, dest=EAST, mode=FlightMode.NORMAL, alt=80):
    return planner.plan(start, dest, mode, alt, PROFILE, CALM, NOW)


def _line_m(result):
    return LineString([lonlat_to_xy(lon, lat) for lon, lat in result.path_lonlat])


def _assert_clear(result, *polys):
    line = _line_m(result)
    for p in polys:
        assert not line.intersects(to_metres(p)), "route intersects blocked geometry"


# A ring (polygon with a hole) around EAST: the hole itself is not restricted.
OUTER = lon_box(21.0072, 52.2312, 21.0100, 52.2348)
HOLE = lon_box(21.0080, 52.2320, 21.0099, 52.2340)
RING = OUTER.difference(HOLE)


def test_deterministic_detour_around_a_restricted_polygon_with_exact_endpoints():
    wall = lon_box(21.0045, 52.2300, 21.0055, 52.2350)  # straight A-B line crosses it
    assert LineString([WEST, EAST]).intersects(wall)
    r = _plan(make_planner(zones=[zone("SYN-R", wall, category="DRA-R")]))
    assert r.status == RouteStatus.OK
    _assert_clear(r, wall)
    assert r.path_lonlat[0] == pytest.approx(WEST, abs=1e-6) and r.path_lonlat[-1] == pytest.approx(EAST, abs=1e-6)
    assert r.distance_m > math.dist(lonlat_to_xy(*WEST), lonlat_to_xy(*EAST)) * 1.2


def test_multipolygon_zone_blocks_every_part():
    a = lon_box(21.0030, 52.2300, 21.0036, 52.2350)  # open to the north
    b = lon_box(21.0060, 52.2310, 21.0066, 52.2360)  # open to the south
    r = _plan(make_planner(zones=[zone("SYN-MP", MultiPolygon([a, b]))]))
    assert r.status == RouteStatus.OK
    _assert_clear(r, a, b)


def test_multiple_zones_are_all_avoided():
    a = lon_box(21.0030, 52.2300, 21.0036, 52.2350)
    b = lon_box(21.0060, 52.2310, 21.0066, 52.2360)
    r = _plan(make_planner(zones=[zone("SYN-P", a), zone("SYN-RM", b, category="DRA-RM")]))
    assert r.status == RouteStatus.OK
    _assert_clear(r, a, b)


def test_point_in_a_hole_is_not_blocked_but_unreachable_through_the_ring():
    r = _plan(make_planner(zones=[zone("SYN-RING", RING)]))
    assert r.status == RouteStatus.NO_ROUTE  # not DESTINATION_BLOCKED: the hole is not restricted
    assert r.path_lonlat is None


def test_route_enters_a_hole_through_a_gap_without_touching_the_ring():
    gap = lon_box(21.0072, 52.2326, 21.0081, 52.2334)  # a channel through the west side of the ring
    ring = RING.difference(gap)
    r = _plan(make_planner(zones=[zone("SYN-RING", ring)], margin_m=5.0))
    assert r.status == RouteStatus.OK
    _assert_clear(r, ring)
    assert r.path_lonlat[-1] == pytest.approx(EAST, abs=1e-6)


@pytest.mark.parametrize("mode", list(FlightMode))
def test_destination_inside_a_prohibited_zone_is_blocked_in_every_mode(mode):
    r = _plan(make_planner(zones=[zone("SYN-P", lon_box(21.0085, 52.2325, 21.0095, 52.2335))]), mode=mode)
    assert r.status == RouteStatus.DESTINATION_BLOCKED and r.path_lonlat is None


# --- summary and status endpoints ---------------------------------------------------------

def test_status_without_official_data_warns_and_never_reports_unrestricted(client):
    body = client.get("/api/v1/airspace/status").json()
    assert body["officialDataAvailable"] is False
    assert OFFICIAL_UNAVAILABLE in body["warnings"]
    assert body["routingUsesMapZones"] is True
    assert body["safetyMarginM"] > 0 and "Modelling assumption" in body["safetyMarginNote"]


def test_summary_counts_are_dynamic_and_match_the_zone_list(api):  # noqa: F811
    s = api.get("/api/v1/zones/summary", params={"at": NOW.isoformat()}).json()
    listed = zones(api)
    assert s["totalZones"] == len(listed) == sum(s["byCategory"].values()) == sum(s["byStatus"].values())
    red = sum(1 for z in listed.values() if z["evaluation"]["displayClass"] == "RED")
    assert s["byStatus"]["BLOCKED"] == red > 0
    assert s["routingObstacles"] == sum(1 for z in listed.values() if z["evaluation"]["isObstacle"])
    assert OFFICIAL_UNAVAILABLE in s["warnings"]  # synthetic zones never count as official


def test_summary_follows_altitude(api):  # noqa: F811
    low = api.get("/api/v1/zones/summary", params={"at": NOW.isoformat(), "altitudeM": 40}).json()
    high = api.get("/api/v1/zones/summary", params={"at": NOW.isoformat(), "altitudeM": 80}).json()
    assert low["byStatus"] != high["byStatus"] and low["totalZones"] == high["totalZones"]


def test_restricted_zones_are_red_obstacles_on_the_map(api):  # noqa: F811
    for z in zones(api).values():
        e = z["evaluation"]
        if e["status"] == "UNAVAILABLE_AUTHORIZATION":
            assert e["displayClass"] == "RED" and e["isObstacle"]
