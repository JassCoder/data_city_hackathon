"""API models for geocoding, drone profiles, weather and route calculation."""

from datetime import datetime
from enum import StrEnum
from typing import Annotated, Literal

from pydantic import Field, model_validator

from app.airspace.models import AirspaceSourceInfo, ZoneConflict
from app.routing.costs import FlightMode
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


class WeatherInfo(CamelModel):
    mode: WeatherMode
    source: WeatherSource
    live_available: bool | None = None  # only meaningful for LIVE
    wind_speed_kmh: float
    wind_direction_deg: float  # meteorological: direction the wind comes FROM
    wind_gust_kmh: float | None = None
    observed_at: str | None = None
    message: str


# --- routing -----------------------------------------------------------------

class RouteStatus(StrEnum):
    OK = "OK"
    NO_ROUTE = "NO_ROUTE"
    OUTSIDE_COVERAGE = "OUTSIDE_COVERAGE"
    START_BLOCKED = "START_BLOCKED"
    DESTINATION_BLOCKED = "DESTINATION_BLOCKED"
    BLOCKED_WEATHER = "BLOCKED_WEATHER"


class RouteRequest(CamelModel):
    start: Coordinate
    destination: Coordinate
    mode: FlightMode = FlightMode.NORMAL
    flight_altitude_meters: int = Field(
        80, strict=True, ge=ALTITUDE_MIN_M, le=ALTITUDE_MAX_M, multiple_of=ALTITUDE_STEP_M
    )
    drone_profile_id: str = Field("DEMO_DRONE_01", min_length=1)
    weather_mode: WeatherMode = WeatherMode.DEMO
    # Planned departure, used to evaluate zone validity periods. Default: now.
    departure_time: datetime | None = None

    @model_validator(mode="after")
    def _distinct_points(self):
        if self.start == self.destination:
            raise ValueError("start and destination must be different points")
        return self


class LineStringGeometry(CamelModel):
    type: Literal["LineString"] = "LineString"
    coordinates: list[list[float]]  # [lon, lat]


class RouteResponse(CamelModel):
    status: RouteStatus
    message: str
    geometry: LineStringGeometry | None
    distance_m: float | None
    eta_s: float | None
    mode: FlightMode
    flight_altitude_meters: int
    drone_profile_id: str
    weather: WeatherInfo
    route_start: Coordinate | None  # first route point (after any snapping)
    route_destination: Coordinate | None
    zone_conflicts: list[ZoneConflict]
    airspace: AirspaceSourceInfo  # zone dataset used for this plan (source, timestamp, version)
    planning_verification_status: str
    warnings: list[str]
    data_sources: list[str]
    compute_ms: float
