"""Multi-criteria cost model configuration (data/cost_model.json).

Every weight, radius and threshold of the risk-aware (SAFEST) objective lives in
that file; nothing here has a numeric default. Unknown keys are rejected and
weights must be non-negative, so a typo fails startup instead of silently
changing routes. JSON (not YAML) to avoid an extra dependency.
"""

from __future__ import annotations

import json
from pathlib import Path
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from pydantic import Field, NonNegativeFloat, PositiveFloat, ValidationError, field_validator, model_validator

from app.schemas.common import CamelModel

Hour = Field(ge=0, le=23)
Fraction = Field(ge=0.0, le=1.0)


class CostModelError(RuntimeError):
    """The cost model file is missing, invalid or inconsistent."""


class AltitudeLimits(CamelModel):
    default_cruise_m: PositiveFloat  # used when a request omits flightAltitudeMeters
    legal_ceiling_m: PositiveFloat  # hard legal maximum (open category: 120 m AGL)


class Weights(CamelModel):
    """Multipliers for the normalized (0..1) cost terms. 0 switches a term off."""

    population: NonNegativeFloat
    obstacle_proximity: NonNegativeFloat
    noise: NonNegativeFloat
    emergency_landing: NonNegativeFloat
    sensitive_areas: NonNegativeFloat
    energy: NonNegativeFloat
    time: NonNegativeFloat


class PopulationParams(CamelModel):
    reference_density_per_ha: PositiveFloat  # density mapped to term 1.0 (higher is clipped)
    exponent: float = Field(ge=1.0)  # nonlinear crowd penalty: (density / reference) ** exponent
    hourly_multiplier: list[NonNegativeFloat] = Field(min_length=24, max_length=24)  # local hour 0..23


class DensityProxyParams(CamelModel):
    """How OSM facts become people per hectare (osm.py). A proxy, not a census."""

    residential_floor_m2_per_person: PositiveFloat
    other_floor_m2_per_person: PositiveFloat  # offices, shops, services (daytime occupants)
    transit_stop_people: NonNegativeFloat  # people around each stop, spread over the radius
    transit_stop_radius_m: PositiveFloat


class RadiusParams(CamelModel):
    radius_m: PositiveFloat


class ObstacleProximityParams(RadiusParams):
    min_height_m: NonNegativeFloat  # only buildings at least this tall count as obstacles to keep clear of


class NoiseParams(CamelModel):
    day_factor: float = Fraction
    night_factor: float = Fraction
    night_start_hour: int = Hour
    night_end_hour: int = Hour


class EnergyParams(CamelModel):
    default_payload_kg: NonNegativeFloat  # used when a request omits payloadKg (clipped to the profile maximum)
    battery_reserve_fraction: float = Field(ge=0.0, lt=1.0)  # share of battery that must remain on landing


class CostModelConfig(CamelModel):
    description: str = ""
    timezone: str  # local time for time-of-day multipliers (IANA name)
    altitude: AltitudeLimits
    weights: Weights
    population: PopulationParams
    density_proxy: DensityProxyParams
    obstacle_proximity: ObstacleProximityParams
    noise: NoiseParams
    emergency_landing: RadiusParams  # term reaches 1.0 at this distance from open space
    sensitive_areas: RadiusParams  # term falls from 1.0 at the site to 0 at this distance
    energy: EnergyParams

    @field_validator("timezone")
    @classmethod
    def _known_timezone(cls, v: str) -> str:
        try:
            ZoneInfo(v)
        except (ZoneInfoNotFoundError, ValueError) as exc:
            raise ValueError(f"unknown timezone '{v}'") from exc
        return v

    @model_validator(mode="after")
    def _cruise_below_ceiling(self):
        a = self.altitude
        if a.default_cruise_m > a.legal_ceiling_m:
            raise ValueError(f"altitude.defaultCruiseM ({a.default_cruise_m:g} m) exceeds "
                             f"altitude.legalCeilingM ({a.legal_ceiling_m:g} m)")
        return self


def load_cost_model(path: Path) -> CostModelConfig:
    """Parses and validates the cost model; raises CostModelError with the reason."""
    if not path.is_file():
        raise CostModelError(f"Missing cost model file {path}.")
    try:
        return CostModelConfig.model_validate(json.loads(path.read_text(encoding="utf-8")))
    except (json.JSONDecodeError, ValidationError) as exc:
        raise CostModelError(f"Invalid {path.name}:\n{exc}") from exc


def validate_altitudes(cfg: CostModelConfig, request_min_m: float, request_max_m: float, step_m: float) -> None:
    """Startup check: the configured cruise altitude must be a valid request value
    and the API must never accept an altitude above the legal ceiling."""
    a = cfg.altitude
    if request_max_m > a.legal_ceiling_m:
        raise CostModelError(f"The API accepts altitudes up to {request_max_m:g} m, above the legal ceiling of "
                             f"{a.legal_ceiling_m:g} m in the cost model.")
    if not request_min_m <= a.default_cruise_m <= request_max_m or a.default_cruise_m % step_m:
        raise CostModelError(f"altitude.defaultCruiseM ({a.default_cruise_m:g} m) must be between "
                             f"{request_min_m:g} and {request_max_m:g} m in {step_m:g} m steps.")
