"""Drone state machine: the states and every allowed transition. Anything else is rejected."""

from __future__ import annotations

from enum import StrEnum


class DroneState(StrEnum):
    IDLE = "IDLE"  # on the ground, no active mission
    LOADING = "LOADING"  # payload being loaded; pre-flight check at the end
    TAKEOFF = "TAKEOFF"  # vertical climb to cruise altitude
    CRUISE = "CRUISE"  # flying to the destination (B)
    DELIVERING = "DELIVERING"  # hovering over B while the parcel is lowered
    RETURNING = "RETURNING"  # flying to the return target (A or a landing station)
    LANDING = "LANDING"  # vertical descent at the end of a leg
    CHARGING = "CHARGING"  # on a landing station, recharging
    HOLDING = "HOLDING"  # hovering in place, waiting for a path (e.g. a temporary zone)
    EMERGENCY_LANDING = "EMERGENCY_LANDING"  # flying to the nearest safe site, then descending
    FAILED = "FAILED"  # terminal: no safe site reachable, battery empty, or a fault


S = DroneState

TRANSITIONS: dict[DroneState, frozenset[DroneState]] = {
    S.IDLE: frozenset({S.LOADING}),
    S.LOADING: frozenset({S.TAKEOFF, S.IDLE}),  # IDLE = rejected by the pre-flight check
    S.TAKEOFF: frozenset({S.CRUISE, S.HOLDING, S.EMERGENCY_LANDING, S.FAILED}),
    S.CRUISE: frozenset({S.DELIVERING, S.HOLDING, S.EMERGENCY_LANDING, S.FAILED}),
    S.DELIVERING: frozenset({S.RETURNING, S.LANDING, S.EMERGENCY_LANDING, S.FAILED}),  # LANDING = stay at B
    S.RETURNING: frozenset({S.LANDING, S.HOLDING, S.EMERGENCY_LANDING, S.FAILED}),
    S.HOLDING: frozenset({S.CRUISE, S.RETURNING, S.EMERGENCY_LANDING, S.FAILED}),
    S.LANDING: frozenset({S.CHARGING, S.IDLE, S.FAILED}),  # CHARGING only at a landing station
    S.CHARGING: frozenset({S.IDLE}),
    S.EMERGENCY_LANDING: frozenset({S.IDLE, S.FAILED}),  # IDLE = landed safely, grounded
    S.FAILED: frozenset(),
}

AIRBORNE = frozenset({S.TAKEOFF, S.CRUISE, S.DELIVERING, S.RETURNING, S.LANDING, S.HOLDING, S.EMERGENCY_LANDING})


class IllegalTransition(RuntimeError):
    def __init__(self, drone_id: str, src: DroneState, dst: DroneState):
        allowed = ", ".join(sorted(TRANSITIONS[src])) or "none (terminal state)"
        super().__init__(f"Drone {drone_id}: {src} -> {dst} is not allowed (allowed from {src}: {allowed}).")
        self.src, self.dst = src, dst


def check_transition(drone_id: str, src: DroneState, dst: DroneState) -> None:
    if dst not in TRANSITIONS[src]:
        raise IllegalTransition(drone_id, src, dst)
