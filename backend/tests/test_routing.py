import math

import numpy as np
import pytest
from shapely.geometry import LineString, Point

from app.routing.astar import astar, line_cells, smooth
from app.routing.costs import FlightMode
from app.routing.grid import lonlat_to_xy
from app.schemas.planning import RouteStatus
from tests.conftest import CALM, EAST, NOW, PROFILE, WEST, lon_box, make_planner, zone

INF = math.inf

# --- A* on raw arrays ---------------------------------------------------------


def test_astar_goes_around_a_wall():
    cost = np.ones((7, 7))
    cost[0:6, 3] = INF  # wall with a gap at the top row
    path = astar(cost, (0, 0), (0, 6), 1.0)
    assert path is not None
    assert all(np.isfinite(cost[c]) for c in path)
    assert (6, 3) in path  # through the only gap


def test_astar_does_not_cut_blocked_corners():
    cost = np.ones((2, 2))
    cost[0, 1] = INF
    cost[1, 0] = INF
    # (0,0) -> (1,1) only touches diagonally between two blocked cells.
    assert astar(cost, (0, 0), (1, 1), 1.0) is None


def test_astar_unreachable_returns_none():
    cost = np.ones((5, 5))
    cost[:, 2] = INF
    assert astar(cost, (2, 0), (2, 4), 1.0) is None


def test_astar_prefers_cheap_cells():
    cost = np.full((5, 9), 5.0)
    cost[4, :] = 1.0  # cheap "river" along the bottom
    path = astar(cost, (4, 0), (4, 8), 1.0)
    assert all(r == 4 for r, _ in path)


def test_line_cells_includes_both_cells_at_a_corner_crossing():
    cells = line_cells((0, 0), (1, 1))
    assert (0, 1) in cells and (1, 0) in cells


def test_smoothing_never_crosses_blocked_cells():
    cost = np.ones((10, 10))
    cost[2:10, 5] = INF
    path = astar(cost, (9, 0), (9, 9), 1.0)
    smoothed = smooth(cost, path, 1.02)
    assert len(smoothed) < len(path)
    for a, b in zip(smoothed, smoothed[1:]):
        assert all(np.isfinite(cost[c]) for c in line_cells(a, b))


# --- planner on a synthetic world -------------------------------------------

# A NO_FLY wall between WEST and EAST, open only at the northern edge.
WALL = lon_box(21.0045, 52.2300, 21.0055, 52.2350)


def _plan(planner, start=WEST, dest=EAST, mode=FlightMode.NORMAL, alt=80, weather=CALM, at=NOW):
    return planner.plan(start, dest, mode, alt, PROFILE, weather, at)


def _line_m(result):
    return LineString([lonlat_to_xy(lon, lat) for lon, lat in result.path_lonlat])


def _poly_m(poly):
    return LineString(lonlat_to_xy(x, y) for x, y in poly.exterior.coords).convex_hull


def test_route_avoids_known_blocked_polygon():
    planner = make_planner(zones=[zone("P", WALL)])
    r = _plan(planner)
    assert r.status == RouteStatus.OK
    assert not _line_m(r).intersects(_poly_m(WALL))
    straight = math.dist(lonlat_to_xy(*WEST), lonlat_to_xy(*EAST))
    assert r.distance_m > straight * 1.2  # a real detour, not the straight line
    assert r.path_lonlat[0] == pytest.approx(WEST, abs=1e-6)
    assert r.path_lonlat[-1] == pytest.approx(EAST, abs=1e-6)


@pytest.mark.parametrize("category", ["DRA-P", "DRA-R", "DRA-RH", "DRA-RM", "DRA-RL", "DRA-T", "DRA-U", "UNKNOWN"])
def test_emergency_mode_cannot_enter_obstacle_zones(category):
    full_wall = lon_box(21.0045, 52.2290, 21.0055, 52.2370)  # spans the whole area
    planner = make_planner(zones=[zone("Z", full_wall, category=category)])
    r = _plan(planner, mode=FlightMode.EMERGENCY)
    assert r.status == RouteStatus.NO_ROUTE
    assert r.path_lonlat is None


def test_unreachable_destination_returns_no_route():
    # Destination enclosed by a ring of tall buildings.
    ring = lon_box(21.0070, 52.2315, 21.0105, 52.2345).difference(lon_box(21.0078, 52.2322, 21.0098, 52.2338))
    planner = make_planner(buildings=[(ring, 200.0)])
    r = _plan(planner)
    assert r.status == RouteStatus.NO_ROUTE
    assert "No route found" in r.message


def test_tall_building_blocks_low_flight_but_not_high_flight():
    tower = lon_box(21.0035, 52.2290, 21.0065, 52.2370)  # 100 m slab across the area
    planner = make_planner(buildings=[(tower, 100.0)])
    assert _plan(planner, alt=80).status == RouteStatus.NO_ROUTE  # 100 >= 80 - 10
    assert _plan(planner, alt=120).status == RouteStatus.OK  # 100 < 120 - 10


def test_changing_endpoints_changes_route():
    planner = make_planner(zones=[zone("P", WALL)])
    a = _plan(planner)
    b = _plan(planner, dest=(21.0090, 52.2310))
    assert a.status == b.status == RouteStatus.OK
    assert a.path_lonlat != b.path_lonlat
    assert a.path_lonlat[-1] != b.path_lonlat[-1]


def test_outside_coverage_is_reported_precisely():
    r = _plan(make_planner(), dest=(20.9671, 52.1657))  # Chopin Airport
    assert r.status == RouteStatus.OUTSIDE_COVERAGE
    assert "Destination point" in r.message and "outside the supported routing area" in r.message


def test_start_inside_zone_is_rejected_not_snapped():
    planner = make_planner(zones=[zone("RM-1", WALL, category="DRA-RM", name="Test RM zone")])
    r = _plan(planner, start=(21.0050, 52.2320))
    assert r.status == RouteStatus.START_BLOCKED
    assert "Test RM zone" in r.message
    assert r.path_lonlat is None
    assert [(c.relation, c.zone_id) for c in r.conflicts] == [("START_INSIDE", "RM-1")]


def test_start_on_tall_building_snaps_with_warning():
    tower = lon_box(21.0005, 52.2325, 21.0015, 52.2335)
    planner = make_planner(buildings=[(tower, 150.0)])
    r = _plan(planner)
    assert r.status == RouteStatus.OK
    assert any("Start point is at a building" in w for w in r.warnings)
    assert not Point(lonlat_to_xy(*r.path_lonlat[0])).within(_poly_m(tower))


def test_wind_above_profile_limit_blocks_flight():
    windy = CALM.model_copy(update={"wind_speed_kmh": 55.0})
    r = _plan(make_planner(), weather=windy)
    assert r.status == RouteStatus.BLOCKED_WEATHER


def test_headwind_increases_eta():
    planner = make_planner()
    calm = _plan(planner)
    # Route flies west -> east; wind FROM the east (90 deg) is a headwind.
    head = _plan(planner, weather=CALM.model_copy(update={"wind_speed_kmh": 20.0, "wind_direction_deg": 90.0}))
    tail = _plan(planner, weather=CALM.model_copy(update={"wind_speed_kmh": 20.0, "wind_direction_deg": 270.0}))
    assert tail.eta_s < calm.eta_s < head.eta_s
    assert calm.eta_s == pytest.approx(calm.distance_m / PROFILE.cruise_speed_mps, abs=0.1)


def test_emergency_prefers_shorter_path_than_normal_over_river_detour():
    # Cheap corridor ~175 m south of both endpoints. With the costs.py weights
    # NORMAL (open 5 / river 1) detours via the river, EMERGENCY (2 / 1) flies direct.
    river = lon_box(21.0000, 52.2300, 21.0100, 52.2312)
    planner = make_planner(river=river)
    a, b = (21.0010, 52.2328), (21.0090, 52.2328)
    normal = _plan(planner, start=a, dest=b)
    emergency = _plan(planner, start=a, dest=b, mode=FlightMode.EMERGENCY)
    assert normal.status == emergency.status == RouteStatus.OK
    assert emergency.distance_m < normal.distance_m * 0.8
    assert min(lat for _, lat in normal.path_lonlat) < 52.2312  # normal reached the river
