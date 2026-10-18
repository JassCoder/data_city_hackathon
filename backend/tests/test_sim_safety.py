"""Simulation safety: battery reserve monitoring, emergency landings, holding and diverting."""

import pytest

from app.routing.grid import lonlat_to_xy
from app.sim.engine import SimulationEngine
from tests.conftest import EAST, PROFILE, WEST, make_planner, make_sim_world
from tests.test_sim_engine import B, events, metres, position, scenario, states

GRID = make_planner().grid
WR, WC = GRID.cell_of(*lonlat_to_xy(*WEST))
_, EC = GRID.cell_of(*lonlat_to_xy(*EAST))


def ring(lon0, lat0, lon1, lat1):
    return [[lon0, lat0], [lon1, lat0], [lon1, lat1], [lon0, lat1], [lon0, lat0]]


WALL = ring(21.0045, 52.2300, 21.0055, 52.2350)  # leaves a gap in the north
FULL_WALL = ring(21.0045, 52.2290, 21.0055, 52.2370)  # spans the whole test area


def fault(at_s, pct):
    return {"atS": at_s, "type": "battery_fault", "droneId": "d1", "lossPct": pct}


def run(sc, world=None, until=3600):
    """Runs to the end, recording the lowest battery seen."""
    e = SimulationEngine.create(sc, world=world or make_sim_world())
    lowest = 100.0
    while e.time_s < until and not e.finished:
        lowest = min(lowest, e.step(1)["drones"][0]["batteryWh"])
    return e, lowest


def test_low_battery_triggers_an_emergency_landing_at_the_nearest_station():
    e, lowest = run(scenario(events=[fault(100, 79)]))  # ~19 % left mid-cruise: below the 20 % reserve
    (em,) = events(e, "EMERGENCY")
    assert em["details"]["siteType"] == "station" and em["details"]["site"] == "West pad"  # closer than East pad
    assert "reserve" in em["details"]["reason"]
    assert events(e, "MISSION_ABORTED") and not events(e, "DELIVERED")
    assert states(e)[-2:] == ["EMERGENCY_LANDING", "IDLE"] and "FAILED" not in states(e)
    final = e.get_state()["drones"][0]
    assert metres(position(final), WEST) < 1.0 and final["position"]["altitudeM"] == 0
    assert lowest > 0  # never crashed through zero


def test_open_green_space_is_used_when_no_station_is_reachable():
    # No stations; open space only in a block around B.
    world = make_sim_world(stations=[], world={"open_space": [(slice(WR - 1, WR + 2), slice(EC - 2, EC + 1))]})
    sc = scenario(drones=[{"id": "d1", "position": {"latitude": WEST[1], "longitude": WEST[0]}}],
                  missions=[{"id": "m1", "droneId": "d1", "destination": B, "routeObjective": "SHORTEST",
                             "afterDelivery": "STAY_AT_DESTINATION", "flightAltitudeMeters": 60}],
                  events=[fault(100, 79)])
    e, lowest = run(sc, world)
    (em,) = events(e, "EMERGENCY")
    assert em["details"]["siteType"] == "open_space" and em["details"]["distanceM"] > 50
    assert states(e)[-1] == "IDLE" and lowest > 0
    assert metres(position(e.get_state()["drones"][0]), EAST) < 80  # landed in the open block near B


def test_no_safe_site_means_landing_in_place_and_failed():
    world = make_sim_world(stations=[], world={"open_everywhere": False})
    sc = scenario(drones=[{"id": "d1", "position": {"latitude": WEST[1], "longitude": WEST[0]}}],
                  missions=[{"id": "m1", "droneId": "d1", "destination": B, "routeObjective": "SHORTEST",
                             "afterDelivery": "STAY_AT_DESTINATION"}],
                  events=[fault(100, 79)])
    e, lowest = run(sc, world)
    (em,) = events(e, "EMERGENCY")
    assert em["details"]["siteType"] == "in_place_unsafe"
    assert states(e)[-2:] == ["EMERGENCY_LANDING", "FAILED"]
    assert "no safe landing site" in events(e, "FAILURE")[0]["details"]["reason"]
    assert e.get_state()["drones"][0]["position"]["altitudeM"] == 0 and lowest > 0


def test_battery_never_goes_below_zero():
    # A fault that empties the battery at once: FAILED immediately, clamped at 0.
    e, lowest = run(scenario(events=[fault(100, 99.9)]))
    d = e.get_state()["drones"][0]
    assert d["state"] == "FAILED" and d["batteryWh"] == 0 and lowest >= 0
    assert events(e, "FAILURE")[-1]["details"]["reason"] == "battery empty"

    # A fault that leaves 0.5 Wh (less than the descent needs): the drone starts an emergency
    # landing, the battery runs out on the way down, and it stops at 0 instead of going negative.
    baseline = SimulationEngine.create(scenario(), world=make_sim_world())
    at_100 = baseline.run_until(100)["drones"][0]["batteryWh"]
    loss_pct = (at_100 - 0.5) / PROFILE.battery_wh * 100
    e, lowest = run(scenario(events=[fault(100, loss_pct)]))
    assert events(e, "EMERGENCY")
    d = e.get_state()["drones"][0]
    assert d["state"] == "FAILED" and d["batteryWh"] == 0 and lowest >= 0 and d["position"]["altitudeM"] > 0


def test_an_emergency_during_take_off_descends_back_to_the_take_off_point():
    e, _ = run(scenario(events=[fault(65, 79)]))  # climbing (loading takes 60 s)
    (em,) = events(e, "EMERGENCY")
    assert em["details"]["siteType"] == "takeoff_point"
    assert states(e)[:4] == ["LOADING", "TAKEOFF", "EMERGENCY_LANDING", "IDLE"]
    assert metres(position(e.get_state()["drones"][0]), WEST) < 1.0


def test_battery_warnings_are_logged_once_per_level():
    e, _ = run(scenario(events=[fault(90, 58), fault(95, 2), fault(96, 1), fault(97, 10)]))
    levels = [x["details"]["levelPct"] for x in events(e, "BATTERY_WARNING")]
    assert levels == [40, 30]
    assert events(e, "DELIVERED")  # still above the reserve: the mission goes on


def test_a_new_zone_on_the_route_makes_the_drone_replan_around_it():
    zone = {"atS": 100, "type": "zone_activate", "zoneId": "z1", "name": "Incident", "polygon": WALL, "upperM": 120}
    e, _ = run(scenario(events=[zone]))
    re = [x for x in events(e, "REPLANNED") if x["details"].get("reason", "").startswith("zone 'Incident'")]
    assert re and re[0]["details"]["distanceM"] > 400
    assert events(e, "DELIVERED") and "HOLDING" not in states(e)


def test_a_blocking_zone_makes_the_drone_hold_until_it_is_lifted():
    sc = scenario(events=[
        {"atS": 100, "type": "zone_activate", "zoneId": "z1", "name": "Incident", "polygon": FULL_WALL, "upperM": 120},
        {"atS": 200, "type": "zone_deactivate", "zoneId": "z1"},
    ])
    e, _ = run(sc)
    s = states(e)
    assert s[s.index("HOLDING") + 1] == "CRUISE"
    hold = next(x for x in e.get_event_log() if x["type"] == "STATE_CHANGED" and x["details"]["to"] == "HOLDING")
    resume = next(x for x in events(e, "REPLANNED") if x["details"].get("reason") == "path clear again")
    assert hold["tS"] == pytest.approx(101, abs=1) and resume["tS"] >= 200
    assert events(e, "DELIVERED")


def test_holding_too_long_diverts_to_the_nearest_station():
    zone = {"atS": 100, "type": "zone_activate", "zoneId": "z1", "name": "Incident", "polygon": FULL_WALL, "upperM": 120}
    e, _ = run(scenario(events=[zone]))
    divert = next(x for x in events(e, "REPLANNED") if x["details"].get("leg") == "divert")
    assert divert["details"]["target"] == "West pad" and divert["tS"] >= 100 + e.config.holding.max_s
    assert events(e, "MISSION_ABORTED") and not events(e, "DELIVERED")
    assert states(e)[-3:] == ["LANDING", "CHARGING", "IDLE"]
    assert metres(position(e.get_state()["drones"][0]), WEST) < 1.0


def test_safety_runs_are_deterministic():
    sc = scenario(events=[fault(100, 79)])
    a, _ = run(sc)
    b, _ = run(sc)
    assert a.log.to_jsonl() == b.log.to_jsonl()
    assert PROFILE.min_reserve_pct == 20  # the scenarios above assume a 20 % reserve
