"""10 drones for one simulated hour on the real Warsaw data: timing and determinism.

Recorded on the development laptop (2026-10-18): engine run about 1.9 s (3,600 ticks,
82 route plans, 281 events) plus about 0.6 s to load the world. The assertion is
deliberately generous so slower machines pass; the number is printed with -s.
"""

import time

import pytest

from app.config import SIM_SCENARIOS_DIR
from app.sim.engine import SimulationEngine
from app.sim.scenario import load_scenario
from app.sim.world import load_world

SCENARIO = load_scenario(SIM_SCENARIOS_DIR / "ten_drones_hour.json")
BUDGET_S = 15.0


@pytest.fixture(scope="module")
def world():
    return load_world()


@pytest.fixture(scope="module")
def run(world):
    t0 = time.perf_counter()
    e = SimulationEngine.create(SCENARIO, world=world)
    e.run_until(3600)
    elapsed = time.perf_counter() - t0
    print(f"\n10 drones x 1 simulated hour: {elapsed:.2f} s wall clock, {len(e.log)} events")
    return e, elapsed


def test_ten_drones_for_one_hour_run_in_a_few_seconds(run):
    e, elapsed = run
    assert e.time_s == 3600 and len(e.drones) == 10
    assert elapsed < BUDGET_S


def test_the_hour_produces_deliveries_and_no_failures(run):
    e, _ = run
    types = [x["type"] for x in e.get_event_log()]
    assert types.count("DELIVERED") >= 15
    assert "FAILURE" not in types
    assert all(d["batteryWh"] >= 0 for d in e.get_state()["drones"])


def test_real_world_runs_are_deterministic(run, world):
    e, _ = run
    again = SimulationEngine.create(SCENARIO, world=world)
    again.run_until(3600)
    assert again.log.to_jsonl() == e.log.to_jsonl()


@pytest.mark.parametrize("path", sorted(SIM_SCENARIOS_DIR.glob("*.json")), ids=lambda p: p.stem)
def test_every_bundled_scenario_fits_the_real_world(path, world):
    e = SimulationEngine.create(load_scenario(path), world=world)  # world checks: stations, capacity, Warsaw
    assert e.drones


def test_twenty_drones_fly_together_without_rejections(world):
    e = SimulationEngine.create(load_scenario(SIM_SCENARIOS_DIR / "twenty_drones.json"), world=world)
    from app.sim.states import AIRBORNE

    most = 0
    while e.time_s < 900:
        e.advance(1)
        most = max(most, sum(d.state in AIRBORNE for d in e.drones.values()))
    assert len(e.drones) == 20 and most == 20
    assert not [x for x in e.get_event_log() if x["type"] == "MISSION_REJECTED"]
