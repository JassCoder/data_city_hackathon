"""State machine, drone transitions and the append-only event log."""

import itertools

import pytest

from app.sim.drone import Drone
from app.sim.events import EventLog, EventType
from app.sim.states import TRANSITIONS, DroneState, IllegalTransition, check_transition
from tests.conftest import PROFILE

S = DroneState


def drone(state=S.IDLE) -> Drone:
    return Drone("d1", "Drone 1", "#0072b2", PROFILE, 52.23, 21.0, battery_wh=PROFILE.battery_wh, state=state)


def test_the_normal_mission_cycle_is_allowed():
    cycle = [S.IDLE, S.LOADING, S.TAKEOFF, S.CRUISE, S.DELIVERING, S.RETURNING, S.LANDING, S.CHARGING, S.IDLE]
    for a, b in zip(cycle, cycle[1:]):
        check_transition("d1", a, b)


@pytest.mark.parametrize("src, dst", [
    (S.IDLE, S.CRUISE),  # no take-off
    (S.IDLE, S.TAKEOFF),  # no loading / pre-flight check
    (S.CRUISE, S.CHARGING),  # charging needs a landing first
    (S.CHARGING, S.TAKEOFF),
    (S.LANDING, S.CRUISE),
    (S.DELIVERING, S.CRUISE),
    (S.EMERGENCY_LANDING, S.CRUISE),  # an emergency landing is never resumed
    (S.FAILED, S.IDLE),  # terminal
])
def test_illegal_transitions_are_rejected(src, dst):
    with pytest.raises(IllegalTransition, match=f"{src} -> {dst} is not allowed"):
        check_transition("d1", src, dst)


def test_the_table_is_exactly_what_check_transition_enforces():
    for src, dst in itertools.product(S, S):
        if dst in TRANSITIONS[src]:
            check_transition("d1", src, dst)
        else:
            with pytest.raises(IllegalTransition):
                check_transition("d1", src, dst)
    assert TRANSITIONS[S.FAILED] == frozenset()
    # Every airborne state can still end in an emergency landing or a failure.
    for s in (S.TAKEOFF, S.CRUISE, S.DELIVERING, S.RETURNING, S.HOLDING):
        assert {S.EMERGENCY_LANDING, S.FAILED} <= TRANSITIONS[s]


def test_drone_transition_logs_and_updates_the_state_clock():
    log = EventLog()
    d = drone()
    d.transition(S.LOADING, 12.0, log, "mission m1 started", missionId="m1")
    assert (d.state, d.state_entered_at_s) == (S.LOADING, 12.0)
    (e,) = log.events
    assert e.type == EventType.STATE_CHANGED and e.drone_id == "d1" and e.t_s == 12.0
    assert e.details["from"] == "IDLE" and e.details["to"] == "LOADING"
    assert e.details["reason"] == "mission m1 started" and e.details["missionId"] == "m1"
    assert e.details["batteryPct"] == 100.0


def test_an_illegal_drone_transition_changes_nothing():
    log = EventLog()
    d = drone()
    with pytest.raises(IllegalTransition):
        d.transition(S.CRUISE, 1.0, log, "skip ahead")
    assert d.state == S.IDLE and len(log) == 0


def test_event_log_is_append_only():
    log = EventLog()
    log.append(0.0, None, EventType.SCENARIO_EVENT, kind="wind_change", speedKmh=20.123456)
    log.append(1.0, "d1", EventType.BATTERY_WARNING, levelPct=40.0)
    events = log.events
    assert isinstance(events, tuple) and [e.seq for e in events] == [0, 1]
    assert events[0].details["speedKmh"] == 20.123  # stable rounding
    with pytest.raises(TypeError):
        events[0].details["speedKmh"] = 0  # read-only details
    with pytest.raises(AttributeError):
        events[0].t_s = 5  # frozen
    assert not hasattr(log, "clear") and not hasattr(log, "pop")
    assert '"type": "BATTERY_WARNING"' in log.to_jsonl()


def test_battery_percentage_and_reserve_come_from_the_profile():
    d = drone()
    d.battery_wh = PROFILE.battery_wh / 4
    assert d.battery_pct == pytest.approx(25.0)
    assert d.reserve_wh == pytest.approx(PROFILE.battery_wh * PROFILE.min_reserve_pct / 100)
