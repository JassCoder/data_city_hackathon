import math

import numpy as np
import pytest

from app.config import COST_MODEL_FILE
from app.routing.astar import MOVES
from app.routing.risk import energy, terms
from app.routing.risk.config import load_cost_model
from app.routing.risk.energy import DroneEnergy
from app.routing.risk.providers import WindVector

CFG = load_cost_model(COST_MODEL_FILE)
DRONE = DroneEnergy(cruise_speed_mps=15, cruise_power_w=250, payload_power_w_per_kg=60, battery_wh=100,
                    max_wind_kmh=36, max_payload_kg=1.0)
CELL = 25.0


# --- distances ------------------------------------------------------------------

def brute_distance(mask, cell, radius):
    out = np.full(mask.shape, radius)
    pts = np.argwhere(mask)
    for r, c in np.ndindex(mask.shape):
        if len(pts):
            out[r, c] = min(radius, np.hypot(pts[:, 0] - r, pts[:, 1] - c).min() * cell)
    return out


@pytest.mark.parametrize("seed", range(5))
def test_distance_within_matches_brute_force(seed):
    rng = np.random.default_rng(seed)
    mask = rng.random((15, 18)) < 0.03
    np.testing.assert_allclose(terms.distance_within(mask, CELL, 120.0), brute_distance(mask, CELL, 120.0), rtol=1e-6)


def test_distance_within_empty_mask_is_radius_everywhere():
    assert (terms.distance_within(np.zeros((4, 4), bool), CELL, 100.0) == 100.0).all()


# --- terms are normalized ----------------------------------------------------------

def test_every_cell_term_stays_in_unit_interval():
    rng = np.random.default_rng(1)
    shape = (20, 20)
    density = rng.random(shape) * 2000  # far above the reference density
    heights = rng.random(shape) * 100
    flags = rng.random(shape) < 0.1
    share = rng.random(shape)
    arrays = [
        terms.population_term(density, 8, CFG.population),
        terms.obstacle_proximity_term(heights, CELL, CFG.obstacle_proximity),
        terms.noise_term(share, 2, CFG.noise),
        terms.emergency_landing_term(flags, CELL, CFG.emergency_landing),
        terms.sensitive_term(flags, CELL, CFG.sensitive_areas),
    ]
    for a in arrays:
        assert a.shape == shape and a.min() >= 0.0 and a.max() <= 1.0


def test_population_penalty_is_nonlinear_and_time_dependent():
    p = CFG.population
    noon = p.hourly_multiplier.index(1.0)
    ref = p.reference_density_per_ha
    low, high = terms.population_term(np.array([ref / 4, ref / 2], np.float32), noon, p)
    assert high == pytest.approx(low * 2 ** p.exponent)  # density^2: double the people, 4x the cost
    night = min(range(24), key=lambda h: p.hourly_multiplier[h])
    assert terms.population_term(np.array([ref / 2]), night, p)[0] < high


def test_noise_is_stronger_at_night_including_wraparound():
    p = CFG.noise  # night 22:00-06:00
    res = np.ones((1, 1), np.float32)
    assert terms.is_night(23, p) and terms.is_night(0, p) and terms.is_night(5, p)
    assert not terms.is_night(6, p) and not terms.is_night(14, p)
    assert terms.noise_term(res, 23, p)[0, 0] > terms.noise_term(res, 14, p)[0, 0]


def test_proximity_and_landing_terms_follow_distance():
    mask = np.zeros((1, 30), bool)
    mask[0, 0] = True
    heights = np.where(mask, 60.0, 0.0)
    prox = terms.obstacle_proximity_term(heights, CELL, CFG.obstacle_proximity)
    assert prox[0, 0] == 1.0 and prox[0, 1] == pytest.approx(0.5) and prox[0, 2] == 0.0  # radius 50 m
    land = terms.emergency_landing_term(mask, CELL, CFG.emergency_landing)
    assert land[0, 0] == 0.0 and np.all(np.diff(land[0]) >= 0) and land[0, -1] == 1.0
    low = terms.obstacle_proximity_term(np.where(mask, 10.0, 0.0), CELL, CFG.obstacle_proximity)
    assert low.max() == 0.0  # below minHeightM: not an obstacle to keep clear of


# --- energy ------------------------------------------------------------------------

EAST = (0, 1, 1.0)
WEST = (0, -1, 1.0)
NORTH = (1, 0, 1.0)


def ground(move, speed_kmh, from_deg):
    return energy.ground_speed(DRONE.cruise_speed_mps, speed_kmh, from_deg, *energy.unit_heading(move))


def test_headwind_costs_more_energy_than_tailwind():
    # Wind FROM the west (270 deg) blows east: flying west is into the wind.
    head = energy.energy_term(DRONE, 0.0, ground(WEST, 20, 270))
    tail = energy.energy_term(DRONE, 0.0, ground(EAST, 20, 270))
    cross = energy.energy_term(DRONE, 0.0, ground(NORTH, 20, 270))
    calm = energy.energy_term(DRONE, 0.0, ground(EAST, 0, 270))
    assert head > cross > calm > tail


def test_payload_costs_energy():
    g = ground(EAST, 0, 0)
    assert energy.energy_term(DRONE, 1.0, g) > energy.energy_term(DRONE, 0.0, g)
    assert energy.energy_j_per_m(DRONE, 0.0, g) == pytest.approx(250 / 15)


def test_energy_and_time_terms_peak_at_one_in_the_worst_allowed_case():
    worst = ground(WEST, DRONE.max_wind_kmh, 270)
    assert energy.energy_term(DRONE, DRONE.max_payload_kg, worst) == pytest.approx(1.0)
    assert energy.time_term(DRONE, worst) == pytest.approx(1.0)
    for heading in range(0, 360, 15):
        ux, uy = math.sin(math.radians(heading)), math.cos(math.radians(heading))
        for wind in (0, 10, 25, DRONE.max_wind_kmh):
            for from_deg in range(0, 360, 30):
                g = energy.ground_speed(DRONE.cruise_speed_mps, wind, from_deg, ux, uy)
                assert 0 < energy.energy_term(DRONE, DRONE.max_payload_kg, g) <= 1 + 1e-9
                assert 0 < energy.time_term(DRONE, g) <= 1 + 1e-9


def test_direction_table_is_weighted_per_move():
    w = CFG.weights.model_copy(update={"energy": 2.0, "time": 0.5})
    (row,) = energy.direction_table(DRONE, 0.0, [WindVector(0, 0, 20, 270)], MOVES, w)
    k_east, k_west = MOVES.index((0, 1, 1.0)), MOVES.index((0, -1, 1.0))
    g = ground(WEST, 20, 270)
    assert row[k_west] == pytest.approx(2.0 * energy.energy_term(DRONE, 0, g) + 0.5 * energy.time_term(DRONE, g))
    assert row[k_west] > row[k_east]
