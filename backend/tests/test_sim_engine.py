"""Simulation engine core: mission lifecycle, pre-flight check, movement, determinism."""

import math

import pytest

from app.routing.grid import lonlat_to_xy
from app.sim.engine import SimulationEngine
from app.sim.scenario import Scenario, ScenarioError
from app.sim.config import Randomness
from tests.conftest import EAST, PROFILE, WEST, make_sim_world

B = {"latitude": EAST[1], "longitude": EAST[0]}
EAST_PAD = (21.0085, 52.2345)


def scenario(missions=None, drones=None, **over) -> Scenario:
    raw = {
        "name": "test", "seed": 1, "startTime": "2026-10-17T14:00:00+02:00",
        "wind": {"speedKmh": 0, "directionDeg": 270},
        "drones": drones or [{"id": "d1", "position": {"stationId": "st-west"}}],
        "missions": missions if missions is not None else [
            {"id": "m1", "droneId": "d1", "destination": B, "routeObjective": "SHORTEST",
             "flightAltitudeMeters": 60, "payloadKg": 0.5},
        ],
        **over,
    }
    return Scenario.model_validate(raw)


def engine(sc=None, seed=None, world=None) -> SimulationEngine:
    return SimulationEngine.create(sc or scenario(), seed=seed, world=world or make_sim_world())


def states(e: SimulationEngine, drone="d1") -> list[str]:
    return [x["details"]["to"] for x in e.get_event_log() if x["type"] == "STATE_CHANGED" and x["droneId"] == drone]


def events(e: SimulationEngine, kind: str) -> list[dict]:
    return [x for x in e.get_event_log() if x["type"] == kind]


def metres(a, b) -> float:
    (ax, ay), (bx, by) = lonlat_to_xy(*a), lonlat_to_xy(*b)
    return math.hypot(bx - ax, by - ay)


def position(drone: dict) -> tuple[float, float]:
    return drone["position"]["longitude"], drone["position"]["latitude"]


def test_drone_delivers_and_returns_to_the_nearest_station():
    e = engine()
    final = e.run_until(3600, stop_when_finished=True)
    assert states(e) == ["LOADING", "TAKEOFF", "CRUISE", "DELIVERING", "RETURNING", "LANDING", "CHARGING", "IDLE"]
    (delivered,) = events(e, "DELIVERED")
    assert metres((delivered["details"]["at"][1], delivered["details"]["at"][0]), EAST) < 1.0  # at B
    d = final["drones"][0]
    assert metres(position(d), EAST_PAD) < 1.0  # the pad nearest to B, not the start pad
    assert d["state"] == "IDLE" and d["batteryPct"] == pytest.approx(100.0)  # recharged
    assert final["finished"] and final["stations"][1]["drones"] == ["d1"]
    # Energy actually used matches the pre-flight estimate.
    (done,) = events(e, "MISSION_COMPLETED")
    used = PROFILE.battery_wh * (1 - done["details"]["batteryPct"] / 100)
    assert used == pytest.approx(done["details"]["plannedEnergyWh"], rel=0.05)


def test_return_to_start_and_stay_at_destination():
    back = engine(scenario(missions=[{"id": "m1", "droneId": "d1", "destination": B, "routeObjective": "SHORTEST",
                                      "afterDelivery": "RETURN_TO_START"}]))
    final = back.run_until(3600, stop_when_finished=True)
    assert metres(position(final["drones"][0]), WEST) < 1.0
    assert states(back)[-2:] == ["CHARGING", "IDLE"]  # the start is a pad

    stay = engine(scenario(missions=[{"id": "m1", "droneId": "d1", "destination": B, "routeObjective": "SHORTEST",
                                      "afterDelivery": "STAY_AT_DESTINATION"}]))
    final = stay.run_until(3600, stop_when_finished=True)
    assert states(stay) == ["LOADING", "TAKEOFF", "CRUISE", "DELIVERING", "LANDING", "IDLE"]  # no pad at B
    d = final["drones"][0]
    assert metres(position(d), EAST) < 1.0 and d["batteryPct"] < 100 and d["position"]["altitudeM"] == 0


def test_preflight_rejects_a_mission_the_battery_cannot_finish():
    e = engine(scenario(drones=[{"id": "d1", "position": {"stationId": "st-west"}, "batteryPct": 20.5}]))
    final = e.run_until(600, stop_when_finished=True)
    assert states(e) == ["LOADING", "IDLE"]
    (rej,) = events(e, "MISSION_REJECTED")
    assert "pre-flight energy check" in rej["details"]["reason"] and "20 % reserve" in rej["details"]["reason"]
    assert metres(position(final["drones"][0]), WEST) < 1.0 and final["drones"][0]["batteryPct"] == pytest.approx(20.5)


def test_mission_rejected_when_the_drone_is_not_at_the_pickup_point():
    e = engine(scenario(missions=[{"id": "m1", "droneId": "d1", "start": B, "destination": {"stationId": "st-east"}}]))
    e.run_until(10)
    (rej,) = events(e, "MISSION_REJECTED")
    assert "from the pickup point" in rej["details"]["reason"]
    assert states(e) == []


def test_drones_move_along_the_route_without_jumping():
    e = engine()
    last = None
    jumps = []
    while not e.finished and e.time_s < 3600:
        d = e.step(1)["drones"][0]
        if d["state"] in ("CRUISE", "RETURNING") and last is not None:
            jumps.append(metres(last, position(d)))
        last = position(d)
    assert jumps and max(jumps) <= PROFILE.cruise_speed_mps * 1.0 + 0.5  # <= one tick of ground speed
    climbs = [x for x in e.get_event_log() if x["type"] == "STATE_CHANGED" and x["details"]["to"] == "CRUISE"]
    assert climbs[0]["details"]["position"][2] == 60  # cruise starts at the flight altitude


def test_same_seed_gives_identical_event_logs_and_reset_repeats_the_run():
    jittery = make_sim_world(config_update={"randomness": Randomness(loading_jitter_s=20, gust_std_kmh=4)})
    a = engine(seed=7, world=jittery)
    b = engine(seed=7, world=jittery)
    a.run_until(3600, stop_when_finished=True)
    b.run_until(3600, stop_when_finished=True)
    assert a.log.to_jsonl() == b.log.to_jsonl() and len(a.log) > 10
    first = a.log.to_jsonl()
    a.reset()
    assert a.time_s == 0 and len(a.log) == 0
    a.run_until(3600, stop_when_finished=True)
    assert a.log.to_jsonl() == first
    c = engine(seed=8, world=jittery)
    c.run_until(3600, stop_when_finished=True)
    assert c.log.to_jsonl() != first  # the seed drives the jitter


def test_time_advances_in_fixed_ticks():
    e = engine(scenario(tickS=0.5))
    e.step(4)
    assert e.time_s == 2.0 and e.tick == 4
    state = e.run_until(10)
    assert state["timeS"] == 10.0 and state["simTime"].startswith("2026-10-17T14:00:10")


def test_departure_time_is_respected():
    e = engine(scenario(missions=[{"id": "m1", "droneId": "d1", "destination": B, "departAtS": 120}]))
    e.run_until(119)
    assert states(e) == []
    e.run_until(125)
    assert states(e) == ["LOADING"]
    assert events(e, "MISSION_ASSIGNED")[0]["tS"] == 121.0  # the tick that contains t = 120 s


def test_wind_change_and_battery_fault_events():
    e = engine(scenario(events=[
        {"atS": 5, "type": "wind_change", "speedKmh": 20, "directionDeg": 90},
        {"atS": 6, "type": "battery_fault", "droneId": "d1", "lossPct": 30},
    ]))
    state = e.run_until(10)
    assert state["wind"]["baseSpeedKmh"] == 20 and state["wind"]["directionDeg"] == 90
    assert state["drones"][0]["batteryPct"] == pytest.approx(70.0)
    kinds = [x["details"]["kind"] for x in events(e, "SCENARIO_EVENT")]
    assert kinds == ["wind_change", "battery_fault"]


@pytest.mark.parametrize("change, message", [
    ({"drones": [{"id": "d1", "position": {"stationId": "st-nowhere"}}]}, "unknown landing station 'st-nowhere'"),
    ({"drones": [{"id": "d1", "position": {"latitude": 52.30, "longitude": 21.20}}]}, "outside the Warsaw boundary"),
    ({"drones": [{"id": "d1", "profileId": "BIG", "position": {"stationId": "st-west"}}]}, "unknown drone profile 'BIG'"),
    ({"missions": [{"id": "m1", "droneId": "d1", "destination": B, "payloadKg": 5}]}, "exceeds the Test drone maximum"),
])
def test_scenario_must_fit_the_world(change, message):
    with pytest.raises(ScenarioError, match=message):
        engine(scenario(**change))
