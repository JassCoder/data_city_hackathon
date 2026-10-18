"""Simulated drone: a config-driven profile (DroneProfile) plus runtime state."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any

from app.schemas.planning import DroneProfile
from app.sim.events import EventLog, EventType
from app.sim.states import DroneState, check_transition

if TYPE_CHECKING:  # avoid import cycles; set by the engine
    from app.sim.kinematics import Leg
    from app.sim.mission import MissionRun

# Display colours for drones without one in the scenario (same palette as the planning UI).
DEFAULT_COLORS = ("#0072b2", "#009e73", "#b05fa0", "#332288", "#2a9dcc", "#5c7f1e", "#7a4fb5", "#1f6f8b")


@dataclass
class Drone:
    id: str
    name: str
    color: str
    profile: DroneProfile
    latitude: float
    longitude: float
    battery_wh: float
    altitude_m: float = 0.0  # above ground
    heading_deg: float = 0.0  # direction of travel, clockwise from north
    speed_mps: float = 0.0  # ground speed
    payload_kg: float = 0.0
    state: DroneState = DroneState.IDLE
    state_entered_at_s: float = 0.0
    mission: MissionRun | None = None
    leg: Leg | None = None  # the polyline being flown and the progress along it
    warnings_sent: set[float] = field(default_factory=set)

    @property
    def battery_pct(self) -> float:
        return 100.0 * self.battery_wh / self.profile.battery_wh

    @property
    def reserve_wh(self) -> float:
        return self.profile.battery_wh * self.profile.reserve_fraction

    def transition(self, new: DroneState, t_s: float, log: EventLog, reason: str, **details: Any) -> None:
        """The only way to change state: illegal transitions raise IllegalTransition."""
        check_transition(self.id, self.state, new)
        log.append(t_s, self.id, EventType.STATE_CHANGED, **{"from": self.state, "to": new}, reason=reason,
                   batteryPct=self.battery_pct, position=[self.latitude, self.longitude, self.altitude_m], **details)
        self.state = new
        self.state_entered_at_s = t_s

    def snapshot(self) -> dict[str, Any]:
        """JSON-friendly runtime state for get_state()."""
        m = self.mission
        leg = self.leg
        return {
            "id": self.id,
            "name": self.name,
            "color": self.color,
            "profileId": self.profile.id,
            "state": self.state.value,
            "stateEnteredAtS": round(self.state_entered_at_s, 3),
            "position": {"latitude": round(self.latitude, 7), "longitude": round(self.longitude, 7),
                         "altitudeM": round(self.altitude_m, 2)},
            "headingDeg": round(self.heading_deg, 1),
            "speedMps": round(self.speed_mps, 2),
            "batteryWh": round(self.battery_wh, 3),
            "batteryPct": round(self.battery_pct, 2),
            "payloadKg": self.payload_kg,
            "mission": m.snapshot() if m else None,
            "leg": leg.snapshot() if leg else None,
        }
