"""API models for geocoding, drone profiles, weather and route calculation."""

from datetime import datetime
from enum import StrEnum
from typing import Annotated, Literal

from pydantic import Field, model_validator

from app.airspace.models import AirspaceSourceInfo, ZoneConflict
from app.routing.costs import FlightMode, RouteObjective
from app.routing.scenarios import SCENARIOS, OptimizationGoal, Scenario
from app.schemas.common import CamelModel

# strict: numeric JSON only; "52.2" strings and NaN/inf are rejected.
Latitude = Annotated[float, Field(strict=True, ge=-90, le=90, allow_inf_nan=False)]
Longitude = Annotated[float, Field(strict=True, ge=-180, le=180, allow_inf_nan=False)]

ALTITUDE_MIN_M = 20
ALTITUDE_MAX_M = 120
ALTITUDE_STEP_M = 5


class Coordinate(CamelModel):
    latitude: Latitude
    longitude: Longitude


# --- geocoding ---------------------------------------------------------------

class GeocodeResult(CamelModel):
    display_name: str
    latitude: float
    longitude: float
    place_id: str | None = None
    category: str | None = None
    source: str
    in_coverage: bool  # inside the routing region


class GeocodingResponse(CamelModel):
    query: str
    results: list[GeocodeResult]
    provider: str
    attribution: str
    cached: bool


# --- drone profiles ----------------------------------------------------------

class DroneProfile(CamelModel):
    id: str
    name: str
    description: str
    cruise_speed_mps: float = Field(gt=0)
    max_wind_kmh: float = Field(gt=0)
    vertical_clearance_m: float = Field(ge=0)
    max_range_km: float = Field(gt=0)
    max_payload_kg: float = Field(ge=0)
    source: Literal["DEMO"]


class DroneProfilesResponse(CamelModel):
    profiles: list[DroneProfile]
    disclaimer: str


# --- weather -----------------------------------------------------------------

class WeatherMode(StrEnum):
    DEMO = "DEMO"
    LIVE = "LIVE"


class WeatherSource(StrEnum):
    DEMO = "DEMO"
    OPEN_METEO = "OPEN_METEO"
    DEMO_FALLBACK = "DEMO_FALLBACK"  # LIVE requested but unavailable


class WindSample(CamelModel):
    latitude: float
    longitude: float
    wind_speed_kmh: float
    wind_direction_deg: float
    wind_gust_kmh: float | None = None


class WeatherInfo(CamelModel):
    mode: WeatherMode
    source: WeatherSource
    live_available: bool | None = None  # only meaningful for LIVE
    wind_speed_kmh: float
    wind_direction_deg: float  # meteorological: direction the wind comes FROM
    wind_gust_kmh: float | None = None
    observed_at: str | None = None
    altitude_m: float | None = None  # wind interpolated to this flight altitude
    samples: list[WindSample] = []  # along the route (LIVE) or a single fixed value (DEMO)
    message: str


# --- routing -----------------------------------------------------------------

class RouteStatus(StrEnum):
    OK = "OK"
    NO_ROUTE = "NO_ROUTE"
    OUTSIDE_COVERAGE = "OUTSIDE_COVERAGE"
    START_BLOCKED = "START_BLOCKED"
    DESTINATION_BLOCKED = "DESTINATION_BLOCKED"
    BLOCKED_WEATHER = "BLOCKED_WEATHER"
    SEARCH_LIMIT = "SEARCH_LIMIT"  # node/time budget exhausted: no route shown, nothing proven
    COVERAGE_UNAVAILABLE = "COVERAGE_UNAVAILABLE"  # official boundary missing: routing disabled


class RouteRequest(CamelModel):
    start: Coordinate
    destination: Coordinate
    mode: FlightMode = FlightMode.NORMAL
    flight_altitude_meters: int = Field(
        80, strict=True, ge=ALTITUDE_MIN_M, le=ALTITUDE_MAX_M, multiple_of=ALTITUDE_STEP_M
    )
    drone_profile_id: str = Field("DEMO_DRONE_01", min_length=1)
    weather_mode: WeatherMode = WeatherMode.DEMO
    # What the route minimises: safe corridors (default), distance, or wind-aware flight time.
    route_objective: RouteObjective = RouteObjective.CORRIDORS
    # Optional routing scenario. It sets mode/routeObjective from its configuration;
    # it never changes start/destination. Omitted = use mode/routeObjective as sent.
    scenario: Scenario | None = None
    # Planned departure, used to evaluate zone validity periods. Default: now.
    departure_time: datetime | None = None

    @model_validator(mode="after")
    def _distinct_points(self):
        if self.start == self.destination:
            raise ValueError("start and destination must be different points")
        return self

    @model_validator(mode="after")
    def _scenario_consistent(self):
        # An explicit mode/routeObjective that contradicts the scenario is rejected
        # instead of being silently overridden.
        if self.scenario is not None:
            cfg = SCENARIOS[self.scenario]
            if "mode" in self.model_fields_set and self.mode != cfg.mode:
                raise ValueError(f"mode {self.mode.value} conflicts with scenario {self.scenario.value} ({cfg.mode.value})")
            if "route_objective" in self.model_fields_set and self.route_objective != cfg.route_objective:
                raise ValueError(f"routeObjective {self.route_objective.value} conflicts with scenario "
                                 f"{self.scenario.value} ({cfg.route_objective.value})")
        return self


class CoverageCheck(CamelModel):
    valid: bool  # both endpoints inside the official Warsaw polygon
    area: str
    start_district: str | None
    destination_district: str | None
    source: str
    airspace_outside_extent_m: float  # route length where no zone data is loaded


class SearchInfo(CamelModel):
    attempts: int
    resolution_m: float
    window_km2: float
    expansions: int
    whole_city: bool
    limited_by: str | None
    elapsed_ms: float
    cached: bool


class ScenarioInfo(CamelModel):
    id: Scenario
    display_name: str
    description: str
    optimization_goal: OptimizationGoal
    route_objective: RouteObjective
    mode: FlightMode
    respect_restricted_zones: bool
    use_weather: bool
    recommended_profile_id: str | None


class ScenariosResponse(CamelModel):
    scenarios: list[ScenarioInfo]
    note: str


class LineStringGeometry(CamelModel):
    type: Literal["LineString"] = "LineString"
    coordinates: list[list[float]]  # [lon, lat]


class RouteResponse(CamelModel):
    status: RouteStatus
    message: str
    start: Coordinate  # echoed exactly as submitted
    destination: Coordinate  # echoed exactly as submitted
    scenario: Scenario | None
    scenario_display_name: str
    optimization_goal: OptimizationGoal | None
    geometry: LineStringGeometry | None
    distance_m: float | None
    eta_s: float | None
    mode: FlightMode
    route_objective: RouteObjective
    flight_altitude_meters: int
    drone_profile_id: str
    weather: WeatherInfo
    route_start: Coordinate | None  # first route point (after any snapping)
    route_destination: Coordinate | None
    coverage: CoverageCheck
    search: SearchInfo | None
    zone_conflicts: list[ZoneConflict]
    airspace: AirspaceSourceInfo  # zone dataset used for this plan (source, timestamp, version)
    planning_verification_status: str
    warnings: list[str]
    data_sources: list[str]
    compute_ms: float
