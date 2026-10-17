"""Normalized UAS geographical-zone model, shared by every provider.

`None` always means "unknown / not supplied by the source"; the evaluator
treats unknowns conservatively (e.g. unknown upper limit = unlimited).
"""

from datetime import datetime
from enum import StrEnum
from typing import Any, Literal

from pydantic import Field

from app.schemas.common import CamelModel


class DraCategory(StrEnum):
    """Polish UAS geographical-zone types (PAŻP)."""

    P = "DRA-P"  # prohibited
    R = "DRA-R"  # restricted: consent + conditions required
    RH = "DRA-RH"  # restricted, consent highly likely
    RM = "DRA-RM"  # restricted, consent moderately likely
    RL = "DRA-RL"  # restricted, consent unlikely
    T = "DRA-T"  # technical requirements (consent may also be required)
    U = "DRA-U"  # U-space: verified services required
    I = "DRA-I"  # noqa: E741 - information / navigation warnings
    UNKNOWN = "UNKNOWN"


RESTRICTED_CATEGORIES = {DraCategory.R, DraCategory.RH, DraCategory.RM, DraCategory.RL}


class RestrictionType(StrEnum):
    PROHIBITED = "PROHIBITED"
    AUTHORIZATION_REQUIRED = "AUTHORIZATION_REQUIRED"
    CONDITIONAL = "CONDITIONAL"
    TECHNICAL_REQUIREMENTS = "TECHNICAL_REQUIREMENTS"
    USPACE_SERVICES_REQUIRED = "USPACE_SERVICES_REQUIRED"
    INFORMATION = "INFORMATION"
    UNKNOWN = "UNKNOWN"


class AltitudeReference(StrEnum):
    AGL = "AGL"
    AMSL = "AMSL"
    UNKNOWN = "UNKNOWN"


class SourceType(StrEnum):
    OFFICIAL = "OFFICIAL"  # live official service
    PERMITTED_SNAPSHOT = "PERMITTED_SNAPSHOT"  # official file obtained with permission
    DEMO = "DEMO"  # synthetic, non-authoritative


class VerificationStatus(StrEnum):
    OFFICIAL_UNVERIFIED_LOCALLY = "OFFICIAL_UNVERIFIED_LOCALLY"
    SYNTHETIC_DEMO = "SYNTHETIC_DEMO"
    INSUFFICIENT_DATA = "INSUFFICIENT_DATA"


class Circle(CamelModel):
    center: tuple[float, float]  # lon, lat
    radius_m: float = Field(gt=0)


class AirspaceZone(CamelModel):
    id: str
    name: str
    dra_category: DraCategory
    restriction_type: RestrictionType
    # Polygon/MultiPolygon in WGS84. For circular zones this is a geodesic
    # polygon approximation of `circle`, which is kept for display/metadata.
    geojson_geometry: dict[str, Any]
    circle: Circle | None = None
    source: str | None
    source_type: SourceType
    source_timestamp: datetime | None
    validity_start: datetime | None
    validity_end: datetime | None
    lower_altitude: float | None  # metres
    upper_altitude: float | None  # metres
    altitude_reference: AltitudeReference
    authorization_required: bool | None
    operational_conditions: str | None
    verification_status: VerificationStatus


class EvaluationStatus(StrEnum):
    BLOCKED = "BLOCKED"  # prohibited for the planned operation
    UNAVAILABLE_AUTHORIZATION = "UNAVAILABLE_AUTHORIZATION"  # consent/conditions not held
    UNAVAILABLE_TECHNICAL = "UNAVAILABLE_TECHNICAL"  # technical requirements not verified
    UNAVAILABLE_USPACE = "UNAVAILABLE_USPACE"  # U-space services not verified
    UNVERIFIED = "UNVERIFIED"  # insufficient data: treated as blocked
    INFORMATION = "INFORMATION"  # warning only
    NOT_ACTIVE_TIME = "NOT_ACTIVE_TIME"  # outside validity period
    NOT_APPLICABLE_ALTITUDE = "NOT_APPLICABLE_ALTITUDE"  # flight outside vertical band


class DisplayClass(StrEnum):
    RED = "RED"  # blocked / prohibited for planned operation
    ORANGE = "ORANGE"  # conditional / authorization required
    YELLOW = "YELLOW"  # technical or informational
    GRAY = "GRAY"  # insufficient verification
    INACTIVE = "INACTIVE"  # not applicable to this flight (time/altitude)


class ZoneEvaluation(CamelModel):
    status: EvaluationStatus
    display_class: DisplayClass
    is_obstacle: bool  # routing treats the zone as a hard obstacle
    reasons: list[str]


class EvaluatedZone(AirspaceZone):
    evaluation: ZoneEvaluation


class AirspaceSourceInfo(CamelModel):
    provider: str
    source_type: SourceType
    label: str
    source_timestamp: datetime | None
    dataset_version: str
    loaded_at: datetime
    disclaimer: str


class FlightContextInfo(CamelModel):
    flight_altitude_meters: int
    at: datetime


class ZonesResponse(CamelModel):
    source: AirspaceSourceInfo
    flight_context: FlightContextInfo
    zones: list[EvaluatedZone]


class ZoneResponse(CamelModel):
    source: AirspaceSourceInfo
    flight_context: FlightContextInfo
    zone: EvaluatedZone


Relation = Literal["START_INSIDE", "DESTINATION_INSIDE", "DIRECT_LINE_BLOCKED", "ROUTE_CROSSES_INFO", "NEAR_ROUTE"]


class ZoneConflict(CamelModel):
    zone_id: str
    name: str
    dra_category: DraCategory
    display_class: DisplayClass
    evaluation_status: EvaluationStatus
    relation: Relation
    message: str
