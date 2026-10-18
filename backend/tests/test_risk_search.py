import math
from datetime import datetime, timezone

import numpy as np
import pytest

from app.config import COST_MODEL_FILE
from app.routing.astar import astar
from app.routing.risk.config import load_cost_model
from app.routing.risk.energy import DroneEnergy
from app.routing.risk.providers import CostContext, GridSpec, SampledWind, WindVector
from app.routing.risk.search import RouteFailure, find_route, path_cost
from app.routing.risk.surface import CELL_TERMS, CostModel
from app.routing.risk.synthetic import synthetic_world

CFG = load_cost_model(COST_MODEL_FILE)
RESERVE = 0.2  # DroneProfile.minReservePct / 100 in production
NOON = datetime(2026, 10, 17, 10, 0, tzinfo=timezone.utc)  # 12:00 in Warsaw
CTX = CostContext(NOON, altitude_m=80, payload_kg=0.0)
DRONE = DroneEnergy(cruise_speed_mps=15, cruise_power_w=250, payload_power_w_per_kg=60, battery_wh=100,
                    max_wind_kmh=36, max_payload_kg=1.0)
SPEC = GridSpec(21, 41, 25.0)
START, GOAL = (10, 0), (10, 40)
CROWD = (slice(5, 16), slice(15, 26))  # hand-placed crowded block on the straight line


def only(**weights):
    """The shipped weights with every term off except the ones given."""
    return CFG.weights.model_copy(update={k: 0.0 for k in CFG.weights.model_dump()} | weights)


def model(spec=SPEC, cfg=CFG, **world):
    return CostModel(cfg, spec, synthetic_world(spec, **world))


def in_block(path, block):
    rs, cs = block
    return [c for c in path if rs.start <= c[0] < rs.stop and cs.start <= c[1] < cs.stop]


# --- crowd weight -----------------------------------------------------------------------

def test_zero_crowd_weight_flies_straight_through_the_crowd():
    m = model(crowded=[(CROWD, 600.0)])
    route = find_route(m.surface(CTX, DRONE, only(population=0.0)), {}, START, GOAL, RESERVE)
    assert route.feasible
    assert all(r == 10 for r, _ in route.path)  # the straight line
    assert in_block(route.path, CROWD)
    assert route.breakdown.population_exposure > 0


def test_high_crowd_weight_detours_around_the_crowd():
    m = model(crowded=[(CROWD, 600.0)])
    route = find_route(m.surface(CTX, DRONE, only(population=5.0)), {}, START, GOAL, RESERVE)
    assert route.feasible and not in_block(route.path, CROWD)
    straight = find_route(m.surface(CTX, DRONE, only(population=0.0)), {}, START, GOAL, RESERVE)
    assert route.breakdown.length_m > straight.breakdown.length_m  # safety costs distance
    # Only diagonal steps grazing the block corners are left (sampled on the flown line).
    assert route.breakdown.population_exposure < 0.2 * straight.breakdown.population_exposure


def test_crowd_penalty_is_lower_at_night():
    night = CostContext(datetime(2026, 10, 17, 1, 0, tzinfo=timezone.utc), 80, 0.0)  # 03:00 local
    m = model(crowded=[(CROWD, 200.0)])
    day_s, night_s = m.surface(CTX, DRONE), m.surface(night, DRONE)
    assert night_s.cell_terms["population"][10, 20] < day_s.cell_terms["population"][10, 20]
    assert night_s is not day_s and m.surface(CTX, DRONE) is day_s  # new context = recomputed surface


# --- hard constraints --------------------------------------------------------------------

ZONE = (slice(0, 18), slice(20, 22))  # wall with a gap in the top rows


def test_restricted_zone_is_never_entered_even_to_dodge_a_crowd():
    zone = np.zeros(SPEC.shape, bool)
    zone[ZONE] = True
    # A crowd fills the gap: the only way through. The route must take it.
    m = model(crowded=[((slice(18, 21), slice(15, 27)), 2000.0)])
    route = find_route(m.surface(CTX, DRONE, only(population=50.0)), {"restricted zone": zone}, START, GOAL, RESERVE)
    assert route.feasible
    assert not any(zone[c] for c in route.path)
    assert any(r >= 18 for r, _ in route.path)


def test_obstacles_taller_than_cruise_block_and_lower_ones_do_not():
    tall, low = (slice(0, 21), slice(10, 12)), (slice(0, 21), slice(30, 32))
    m = model(buildings=[(tall, 100.0), (low, 50.0)])
    mask = m.obstacle_mask(altitude_m=80, clearance_m=10)
    assert mask[tall].all() and not mask[low].any()
    route = find_route(m.surface(CTX, DRONE), {"obstacle above cruise altitude": mask}, START, GOAL, RESERVE)
    assert route.reason == RouteFailure.NO_ROUTE
    assert "obstacle above cruise altitude" in route.message
    assert route.path is None and route.breakdown is None
    higher = m.obstacle_mask(altitude_m=120, clearance_m=10)
    assert find_route(m.surface(CTX, DRONE), {"obstacle": higher}, START, GOAL, RESERVE).feasible


def test_wind_above_the_limit_blocks_the_flight():
    m = CostModel(CFG, SPEC, synthetic_world(SPEC, wind=(DRONE.max_wind_kmh + 1, 270)))
    route = find_route(m.surface(CTX, DRONE), {}, START, GOAL, RESERVE)
    assert route.reason == RouteFailure.WIND_LIMIT and route.path is None


def test_blocked_start_names_the_constraint():
    zone = np.zeros(SPEC.shape, bool)
    zone[START] = True
    route = find_route(model().surface(CTX, DRONE), {"restricted zone": zone}, START, GOAL, RESERVE)
    assert route.reason == RouteFailure.START_BLOCKED and "restricted zone" in route.message


def test_battery_reserve_is_a_structured_failure():
    weak = DroneEnergy(15, 250, 60, battery_wh=0.2, max_wind_kmh=36, max_payload_kg=1.0)
    route = find_route(model().surface(CTX, weak), {}, START, GOAL, RESERVE)
    assert route.reason == RouteFailure.BATTERY_RESERVE and route.path is None
    assert route.breakdown.energy_wh > weak.usable_wh(RESERVE)


# --- wind ----------------------------------------------------------------------------------

def test_flying_into_the_wind_costs_more_than_with_it():
    m = model(wind=(25.0, 270.0))  # from the west
    s = m.surface(CTX, DRONE, only(energy=1.0))
    east = find_route(s, {}, START, GOAL, RESERVE)
    west = find_route(s, {}, GOAL, START, RESERVE)
    assert west.breakdown.energy_wh > east.breakdown.energy_wh
    assert west.search_cost > east.search_cost


# --- breakdown -----------------------------------------------------------------------------

def test_breakdown_adds_up():
    m = model(crowded=[(CROWD, 600.0)], residential=[CROWD], sensitive=[(slice(10, 11), slice(30, 31))])
    s = m.surface(CTX, DRONE, only(population=0.0, noise=1.0, sensitive_areas=1.0, energy=1.0))
    b = s.breakdown_cells([(10, c) for c in range(41)])  # the straight line
    assert b.length_m == pytest.approx(40 * 25.0)
    assert b.total_cost == pytest.approx(b.length_m + sum(t.cost for t in b.terms.values()))
    assert b.terms["noise"].cost > 0 and b.terms["sensitive_areas"].cost > 0
    assert b.terms["population"].cost == 0 and b.terms["population"].mean > 0  # weight 0, still reported
    # 11 crowded cells of 25 m at 600/ha x the 12:00 multiplier
    noon = CFG.population.hourly_multiplier[12]
    assert b.population_exposure == pytest.approx(600 * noon * 11 * 25 / 1000)
    assert b.max_density_per_ha == pytest.approx(600 * noon)
    assert b.flight_time_s == pytest.approx(b.length_m / DRONE.cruise_speed_mps)
    assert b.energy_wh == pytest.approx(DRONE.cruise_power_w * b.flight_time_s / 3600)


def test_search_cost_matches_the_breakdown_of_the_found_route():
    m = model(crowded=[(CROWD, 600.0)], residential=[CROWD], sensitive=[(slice(10, 11), slice(30, 31))],
              wind=(20.0, 200.0))
    route = find_route(m.surface(CTX, DRONE), {}, START, GOAL, RESERVE)
    # Same formula: per entered cell (search) vs sampled along the flown line (breakdown).
    assert route.search_cost == pytest.approx(route.breakdown.total_cost, rel=0.03)


# --- A* optimality and determinism ---------------------------------------------------------

def random_model(seed: int, spec: GridSpec):
    rng = np.random.default_rng(seed)
    world = synthetic_world(spec)
    world.population._density = (rng.random(spec.shape) * 500).astype(np.float32)
    world.land_use._residential = rng.random(spec.shape).astype(np.float32)
    world.land_use._sensitive = rng.random(spec.shape) < 0.05
    world.land_use._open = rng.random(spec.shape) < 0.1
    world.obstacles._heights = (rng.random(spec.shape) * 60).astype(np.float32)
    world.wind = SampledWind([
        WindVector(float(rng.random() * spec.cols * spec.cell_m), float(rng.random() * spec.rows * spec.cell_m),
                   float(rng.random() * 30), float(rng.random() * 360))
        for _ in range(3)
    ])
    blocked = rng.random(spec.shape) < 0.15
    return CostModel(CFG, spec, world), blocked, rng


@pytest.mark.parametrize("seed", range(25))
def test_heuristic_never_overestimates_compared_with_dijkstra(seed):
    spec = GridSpec(14, 14, 25.0)
    m, blocked, rng = random_model(seed, spec)
    s = m.surface(CTX, DRONE)
    cost = s.search_cost(blocked)
    free = np.argwhere(~blocked)
    a, b = (tuple(map(int, free[i])) for i in rng.choice(len(free), 2, replace=False))
    move = (s.regions(), s.table)
    with_h = astar(cost, a, b, s.min_cost_per_m, move_cost=move, additive=True)
    dijkstra = astar(cost, a, b, 0.0, move_cost=move, additive=True)
    assert (with_h is None) == (dijkstra is None)
    if dijkstra is None:
        return
    exact = path_cost(s, cost, dijkstra)
    assert path_cost(s, cost, with_h) == pytest.approx(exact, rel=1e-9)
    # The heuristic at the start is a lower bound on the optimal cost.
    dr, dc = abs(a[0] - b[0]), abs(a[1] - b[1])
    octile = max(dr, dc) + (math.sqrt(2) - 1) * min(dr, dc)
    assert octile * spec.cell_m * s.min_cost_per_m <= exact + 1e-9


def test_same_inputs_and_seed_give_identical_routes():
    spec = GridSpec(30, 30, 25.0)
    routes = []
    for _ in range(2):
        m, blocked, _ = random_model(7, spec)
        blocked[0, 0] = blocked[29, 29] = False
        routes.append(find_route(m.surface(CTX, DRONE), {"blocked": blocked}, (0, 0), (29, 29), RESERVE))
    assert routes[0].path == routes[1].path and routes[0].search_cost == routes[1].search_cost


def test_cell_cost_is_one_plus_weighted_terms():
    m, _, _ = random_model(3, GridSpec(10, 10, 25.0))
    s = m.surface(CTX, DRONE)
    w = CFG.weights.model_dump()
    expected = 1 + sum(w[n] * s.cell_terms[n] for n in CELL_TERMS)
    np.testing.assert_allclose(s.cell_cost, expected, rtol=1e-5)
    assert s.cell_cost.min() >= 1.0
