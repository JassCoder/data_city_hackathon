"""Simulation scenario files (JSON): drones, missions, timed events, seed, tick size.

Structural validation happens on load (unknown keys, references between drones,
missions and events, value ranges). Checks that need the loaded world (profile
ids, landing station ids, points inside Warsaw, payload vs. profile) run when the
engine is created. Not to be confused with app/routing/scenarios.py (routing
presets without coordinates).
"""

from __future__ import annotations

import json
from datetime import datetime
from pathlib import Path
from typing import Annotated, Literal, Union

from pydantic import Field, NonNegativeFloat, PositiveFloat, ValidationError, field_validator, model_validator

from app.airspace.models import DraCategory
from app.routing.costs import FlightMode, RouteObjective
from app.schemas.common import CamelModel
from app.schemas.planning import ALTITUDE_MAX_M, ALTITUDE_MIN_M, ALTITUDE_STEP_M, Latitude, Longitude
from app.sim.config import AfterDelivery

Identifier = Annotated[str, Field(min_length=1, max_length=64, pattern=r"^[A-Za-z0-9_.-]+$")]


class ScenarioError(RuntimeError):
    """The scenario file is missing or invalid (the message says where)."""


class LatLon(CamelModel):
    latitude: Latitude
    longitude: Longitude


class StationRef(CamelModel):
    station_id: Identifier


Place = Union[LatLon, StationRef]


class Wind(CamelModel):
    speed_kmh: NonNegativeFloat
    direction_deg: float = Field(ge=0, lt=360)  # meteorological: where it blows FROM


class ScenarioDrone(CamelModel):
    id: Identifier
    name: str | None = None  # default: the id
    color: str | None = Field(None, pattern=r"^#[0-9a-fA-F]{6}$")
    profile_id: str | None = None  # default: sim config defaultProfileId (Standard)
    # Where the drone starts, on the ground. Default: its first mission's start.
    position: Place | None = None
    battery_pct: float | None = Field(None, ge=0, le=100)  # default: full


class ScenarioMission(CamelModel):
    """The same fields the planning UI sends, plus timing and the after-delivery choice."""

    id: Identifier
    drone_id: Identifier
    start: Place | None = None  # pickup; default: where the drone is when the mission starts
    destination: Place
    mode: FlightMode = FlightMode.NORMAL
    route_objective: RouteObjective = RouteObjective.CORRIDORS
    flight_altitude_meters: int | None = Field(
        None, ge=ALTITUDE_MIN_M, le=ALTITUDE_MAX_M, multiple_of=ALTITUDE_STEP_M
    )  # default: cost model defaultCruiseM
    payload_kg: float | None = Field(None, ge=0)  # default: cost model defaultPayloadKg
    after_delivery: AfterDelivery | None = None  # default: sim config afterDelivery
    depart_at_s: NonNegativeFloat = 0  # earliest start, seconds after scenario start


class _Event(CamelModel):
    at_s: NonNegativeFloat


class WindChangeEvent(_Event):
    type: Literal["wind_change"]
    speed_kmh: NonNegativeFloat
    direction_deg: float = Field(ge=0, lt=360)


class CircleShape(CamelModel):
    longitude: Longitude
    latitude: Latitude
    radius_m: PositiveFloat


class ZoneActivateEvent(_Event):
    """A temporary DEMO zone (e.g. an incident) that blocks routes while active."""

    type: Literal["zone_activate"]
    zone_id: Identifier
    name: str = Field(min_length=1)
    category: DraCategory = DraCategory.R
    polygon: list[tuple[Longitude, Latitude]] | None = Field(None, min_length=4)
    circle: CircleShape | None = None
    lower_m: NonNegativeFloat = 0
    upper_m: PositiveFloat

    @model_validator(mode="after")
    def _one_shape(self):
        if (self.polygon is None) == (self.circle is None):
            raise ValueError("zone_activate needs exactly one of polygon or circle")
        if self.polygon is not None and self.polygon[0] != self.polygon[-1]:
            raise ValueError("zone polygon ring must be closed (first point = last point)")
        if self.upper_m <= self.lower_m:
            raise ValueError("upperM must be above lowerM")
        return self


class ZoneDeactivateEvent(_Event):
    type: Literal["zone_deactivate"]
    zone_id: Identifier


class BatteryFaultEvent(_Event):
    type: Literal["battery_fault"]
    drone_id: Identifier
    loss_pct: float = Field(gt=0, le=100)  # share of the battery capacity lost instantly


ScenarioEvent = Annotated[
    Union[WindChangeEvent, ZoneActivateEvent, ZoneDeactivateEvent, BatteryFaultEvent],
    Field(discriminator="type"),
]


class Scenario(CamelModel):
    name: str = Field(min_length=1)
    description: str = ""
    seed: int
    tick_s: PositiveFloat | None = None  # default: sim config tickS
    start_time: datetime  # timezone-aware; the planner uses it for zone validity and time-of-day costs
    wind: Wind | None = None  # default: the DEMO weather (no network access in simulations)
    drones: list[ScenarioDrone] = Field(min_length=1)
    missions: list[ScenarioMission] = []
    events: list[ScenarioEvent] = []

    @field_validator("start_time")
    @classmethod
    def _aware(cls, v: datetime) -> datetime:
        if v.tzinfo is None:
            raise ValueError("startTime needs a timezone offset, e.g. 2026-10-18T10:00:00+02:00")
        return v

    @model_validator(mode="after")
    def _references(self):
        drone_ids = [d.id for d in self.drones]
        if len(set(drone_ids)) != len(drone_ids):
            raise ValueError(f"duplicate drone ids: {sorted({i for i in drone_ids if drone_ids.count(i) > 1})}")
        mission_ids = [m.id for m in self.missions]
        if len(set(mission_ids)) != len(mission_ids):
            raise ValueError(f"duplicate mission ids: {sorted({i for i in mission_ids if mission_ids.count(i) > 1})}")
        for m in self.missions:
            if m.drone_id not in drone_ids:
                raise ValueError(f"mission '{m.id}' refers to unknown drone '{m.drone_id}'")
        for d in self.drones:
            first = min((m for m in self.missions if m.drone_id == d.id), key=lambda m: m.depart_at_s, default=None)
            if d.position is None and (first is None or first.start is None):
                raise ValueError(f"drone '{d.id}' needs a position, or its first mission needs a start")
        active: set[str] = set()
        for e in sorted(self.events, key=lambda e: e.at_s):
            if isinstance(e, BatteryFaultEvent) and e.drone_id not in drone_ids:
                raise ValueError(f"battery_fault at {e.at_s:g} s refers to unknown drone '{e.drone_id}'")
            if isinstance(e, ZoneActivateEvent):
                if e.zone_id in active:
                    raise ValueError(f"zone '{e.zone_id}' is activated twice without being deactivated")
                active.add(e.zone_id)
            if isinstance(e, ZoneDeactivateEvent):
                if e.zone_id not in active:
                    raise ValueError(f"zone_deactivate at {e.at_s:g} s: zone '{e.zone_id}' is not active")
                active.discard(e.zone_id)
        return self


def load_scenario(path: Path) -> Scenario:
    """Parses and validates a scenario file; raises ScenarioError naming the file and the problem."""
    if not path.is_file():
        raise ScenarioError(f"Missing scenario file {path}.")
    try:
        return Scenario.model_validate(json.loads(path.read_text(encoding="utf-8")))
    except json.JSONDecodeError as exc:
        raise ScenarioError(f"{path.name} is not valid JSON: {exc}") from exc
    except ValidationError as exc:
        raise ScenarioError(f"Invalid scenario {path.name}:\n{exc}") from exc
