"""A mission being executed by a drone: resolved points, plans and status."""

from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum

from app.sim.config import AfterDelivery
from app.sim.scenario import ScenarioMission


class MissionStatus(StrEnum):
    LOADING = "LOADING"
    OUTBOUND = "OUTBOUND"
    DELIVERED = "DELIVERED"
    RETURNING = "RETURNING"
    COMPLETED = "COMPLETED"
    REJECTED = "REJECTED"
    ABORTED = "ABORTED"


@dataclass
class Target:
    label: str
    longitude: float
    latitude: float
    station_id: str | None = None

    @property
    def lonlat(self) -> tuple[float, float]:
        return self.longitude, self.latitude

    def snapshot(self) -> dict:
        return {"label": self.label, "latitude": round(self.latitude, 7), "longitude": round(self.longitude, 7),
                "stationId": self.station_id}


@dataclass
class MissionRun:
    spec: ScenarioMission
    start: Target
    destination: Target
    altitude_m: int
    payload_kg: float
    after_delivery: AfterDelivery
    loading_s: float  # this run's loading time (config value, plus seeded jitter if configured)
    status: MissionStatus = MissionStatus.LOADING
    return_target: Target | None = None
    planned_energy_wh: float | None = None  # pre-flight estimate for the whole mission

    @property
    def id(self) -> str:
        return self.spec.id

    def snapshot(self) -> dict:
        return {
            "id": self.id,
            "status": self.status.value,
            "start": self.start.snapshot(),
            "destination": self.destination.snapshot(),
            "mode": self.spec.mode.value,
            "routeObjective": self.spec.route_objective.value,
            "altitudeM": self.altitude_m,
            "payloadKg": self.payload_kg,
            "afterDelivery": self.after_delivery.value,
            "returnTarget": self.return_target.snapshot() if self.return_target else None,
            "plannedEnergyWh": round(self.planned_energy_wh, 2) if self.planned_energy_wh is not None else None,
        }
