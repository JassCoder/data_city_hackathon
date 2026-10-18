"""Simulation engine parameters (data/sim_config.json).

Every duration, threshold and default of the engine lives in that file; drone
parameters live in data/drone_profiles.json. Unknown keys are rejected so a
typo fails loudly instead of silently changing a run.
"""

from __future__ import annotations

import json
from enum import StrEnum
from pathlib import Path

from pydantic import Field, NonNegativeFloat, PositiveFloat, ValidationError, field_validator

from app.schemas.common import CamelModel


class SimConfigError(RuntimeError):
    """The simulation config is missing or invalid."""


class AfterDelivery(StrEnum):
    RETURN_TO_START = "RETURN_TO_START"
    NEAREST_STATION = "NEAREST_STATION"
    STAY_AT_DESTINATION = "STAY_AT_DESTINATION"


class Durations(CamelModel):
    loading_s: PositiveFloat
    delivering_s: PositiveFloat  # hovering over B while the parcel is lowered
    charging_s: PositiveFloat  # time to recharge to full at a landing station


class HoldingParams(CamelModel):
    retry_s: PositiveFloat  # how often a holding drone tries to replan
    max_s: PositiveFloat  # then it diverts to a landing site


class Randomness(CamelModel):
    """Optional seeded noise; 0 = fully repeatable without depending on the seed."""

    loading_jitter_s: NonNegativeFloat  # uniform +/- jitter on the loading duration
    gust_std_kmh: NonNegativeFloat  # Gaussian noise on the wind speed, drawn per tick


class EmergencyParams(CamelModel):
    open_space_search_radius_m: PositiveFloat  # how far to look for open green space
    open_space_candidates: int = Field(ge=1)  # nearest open-space cells tried (a route is planned to each)


class ApiLimits(CamelModel):
    """Limits of the simulation session API (app/routers/simulations.py)."""

    max_sessions: int = Field(ge=1)  # the least recently used session is dropped beyond this
    idle_timeout_s: PositiveFloat  # sessions untouched this long are dropped
    max_ticks_per_step: int = Field(ge=1)
    history_max_frames: int = Field(ge=1)  # per-tick frames kept per session for the timeline
    history_max_frames_per_request: int = Field(ge=1)  # larger requests get a coarser stride
    zone_max_vertices: int = Field(ge=3)
    zone_max_duration_s: PositiveFloat
    zone_max_upper_m: PositiveFloat
    wind_max_kmh: PositiveFloat


class SimConfig(CamelModel):
    description: str = ""
    tick_s: PositiveFloat  # simulated seconds per tick (a scenario may override)
    default_profile_id: str = Field(min_length=1)
    after_delivery: AfterDelivery  # default for missions that do not say
    durations: Durations
    battery_warning_pct: list[float] = Field(min_length=1)  # logged once each, while flying
    holding: HoldingParams
    randomness: Randomness
    emergency: EmergencyParams
    position_tolerance_m: PositiveFloat  # how close a drone must be to a mission's pickup point
    api: ApiLimits

    @field_validator("battery_warning_pct")
    @classmethod
    def _warnings_descending(cls, v: list[float]) -> list[float]:
        if any(not 0 < p < 100 for p in v):
            raise ValueError("battery warning levels must be between 0 and 100 %")
        if v != sorted(set(v), reverse=True):
            raise ValueError("battery warning levels must be unique and in descending order")
        return v


def load_sim_config(path: Path) -> SimConfig:
    if not path.is_file():
        raise SimConfigError(f"Missing simulation config {path}.")
    try:
        return SimConfig.model_validate(json.loads(path.read_text(encoding="utf-8")))
    except (json.JSONDecodeError, ValidationError) as exc:
        raise SimConfigError(f"Invalid {path.name}:\n{exc}") from exc
