"""Fleet API models. Every simulated object carries a source/verification label;
none implies regulatory approval or a real facility's consent."""

from __future__ import annotations

from enum import StrEnum
from typing import Any

from pydantic import Field

from app.schemas.common import CamelModel
from app.schemas.planning import Coordinate, WeatherMode

SIMULATION_NOTICE = ("SIMULATION: stations, depots, pads, drones and orders are simulated planning objects. "
                     "No hospital or restaurant has agreed to host drones; nothing here is approved for real flight.")


class FacilityKind(StrEnum):
    HOSPITAL_STATION = "HOSPITAL_STATION"
    DEPOT = "DEPOT"
    RESTAURANT_PAD = "RESTAURANT_PAD"


class Verification(StrEnum):
    PROPOSED = "PROPOSED"
    REVIEW_REQUIRED = "REVIEW_REQUIRED"
    SIMULATION_ENABLED = "SIMULATION_ENABLED"
    VERIFIED_BY_OPERATOR = "VERIFIED_BY_OPERATOR"  # operator check in the simulation, NOT regulatory approval
    DISABLED = "DISABLED"


DISPATCH_ENABLED = {Verification.SIMULATION_ENABLED, Verification.VERIFIED_BY_OPERATOR}


class OperationalStatus(StrEnum):
    OPEN = "OPEN"
    CLOSED = "CLOSED"


class DepotType(StrEnum):
    STANDARD = "STANDARD"
    HIGH_DEMAND = "HIGH_DEMAND"


class SubscriptionStatus(StrEnum):
    NOT_SUBSCRIBED = "NOT_SUBSCRIBED"
    TRIAL = "TRIAL"
    ACTIVE = "ACTIVE"
    SUSPENDED = "SUSPENDED"


class DroneStatus(StrEnum):
    AVAILABLE = "AVAILABLE"
    RESERVED = "RESERVED"
    LOADING = "LOADING"
    IN_FLIGHT = "IN_FLIGHT"
    DELIVERING = "DELIVERING"
    RETURNING = "RETURNING"
    CHARGING = "CHARGING"
    MAINTENANCE = "MAINTENANCE"
    OFFLINE = "OFFLINE"


class OrderType(StrEnum):
    FOOD_DELIVERY = "FOOD_DELIVERY"
    BLOOD_DELIVERY = "BLOOD_DELIVERY"
    AED_DELIVERY = "AED_DELIVERY"
    MEDICAL_SUPPLIES = "MEDICAL_SUPPLIES"


class OrderStatus(StrEnum):
    CREATED = "CREATED"
    ASSIGNED = "ASSIGNED"  # drone + capacity reserved
    TO_PICKUP = "TO_PICKUP"
    LOADING = "LOADING"
    IN_DELIVERY = "IN_DELIVERY"
    DELIVERED = "DELIVERED"
    RETURNING = "RETURNING"
    COMPLETED = "COMPLETED"
    NO_DRONE_AVAILABLE = "NO_DRONE_AVAILABLE"
    FAILED = "FAILED"
    CANCELLED = "CANCELLED"


class Facility(CamelModel):
    id: str
    kind: FacilityKind
    ref_id: str | None
    name: str
    latitude: float
    longitude: float
    district: str | None
    capacity: int
    occupied: int
    reserved: int
    available: int  # capacity - occupied - reserved (never negative)
    verification: Verification
    operational_status: OperationalStatus
    dispatch_enabled: bool
    depot_type: DepotType | None = None
    landing_method: str | None = None
    data_source: str
    demand_score: float | None = None
    notes: str | None = None
    assigned_drones: int = 0
    available_drones: int = 0
    updated_at: str


class DepotCreate(CamelModel):
    name: str = Field(min_length=3, max_length=80)
    location: Coordinate
    capacity: int = Field(ge=0, le=50)
    depot_type: DepotType = DepotType.STANDARD
    verification: Verification = Verification.PROPOSED
    notes: str | None = None


class FacilityPatch(CamelModel):
    """Admin edit. `location` moves a depot/pad (re-validated)."""

    name: str | None = Field(default=None, min_length=3, max_length=80)
    capacity: int | None = Field(default=None, ge=0, le=50)
    verification: Verification | None = None
    operational_status: OperationalStatus | None = None
    depot_type: DepotType | None = None
    location: Coordinate | None = None
    notes: str | None = None


class PadCreate(CamelModel):
    restaurant_id: str
    location: Coordinate | None = None  # default: the mapped restaurant point (review required)
    capacity: int = Field(default=1, ge=1, le=2)
    landing_method: str = "GROUND_PAD_PROPOSED"


class PadCheck(CamelModel):
    """Validation of a proposed landing point. Map data cannot verify physical suitability."""

    inside_warsaw: bool
    distance_from_facility_m: float | None
    within_max_distance: bool
    obstacle_zones: list[str]  # loaded blocked zones covering the point
    on_mapped_building: bool | None  # None = no data at this point
    building_height_known: bool | None
    ok_for_simulation: bool
    issues: list[str]
    not_verifiable_from_map_data: list[str]


class Hospital(CamelModel):
    id: str
    osm_id: str
    name: str | None
    address: str | None
    district: str | None
    latitude: float
    longitude: float
    website: str | None = None
    phone: str | None = None
    footprint: dict[str, Any] | None = None
    completeness: dict[str, bool]
    merged_osm_ids: list[str] = []
    source: str
    imported_at: str | None
    station: Facility | None  # simulated drone station (separate record)


class Restaurant(CamelModel):
    id: str
    osm_id: str
    name: str | None
    address: str | None
    district: str | None
    latitude: float
    longitude: float
    cuisine: str | None = None
    source: str
    imported_at: str | None
    subscription: SubscriptionStatus
    demo_partner: bool
    pad: Facility | None


class Page[T](CamelModel):
    total: int
    offset: int
    limit: int
    items: list[T]
    source: str | None = None
    completeness_note: str | None = None
    notice: str = SIMULATION_NOTICE


class SubscriptionPatch(CamelModel):
    status: SubscriptionStatus


class Drone(CamelModel):
    id: str
    name: str
    drone_profile_id: str
    status: DroneStatus
    home_depot_id: str
    current_facility_id: str | None
    battery_percent: float
    maximum_range_meters: float
    available: bool
    current_order_id: str | None
    latitude: float | None  # current facility position (None while flying)
    longitude: float | None
    last_updated: str


class OrderCreate(CamelModel):
    order_type: OrderType
    pickup: Coordinate  # the user's Point A (or an explicitly chosen facility's point)
    destination: Coordinate  # the user's Point B
    pickup_facility_id: str | None = None  # explicit choice: a restaurant pad / hospital station / depot
    destination_facility_id: str | None = None  # explicit choice: landing at a hospital station etc.
    partner_id: str | None = None  # restaurant/hospital record this order is for
    drone_profile_id: str | None = None  # restrict to this profile
    flight_altitude_meters: int = Field(default=80, ge=20, le=120, multiple_of=5)
    weather_mode: WeatherMode = WeatherMode.SAMPLE


class RouteLeg(CamelModel):
    leg: str  # TO_PICKUP | DELIVERY | RETURN
    status: str
    distance_m: float | None
    eta_s: float | None
    geometry: dict[str, Any] | None
    message: str


class Order(CamelModel):
    id: str
    order_type: OrderType
    status: OrderStatus
    pickup: Coordinate
    destination: Coordinate
    pickup_facility_id: str | None
    destination_facility_id: str | None
    partner_id: str | None
    drone_id: str | None
    drone_profile_id: str | None
    flight_altitude_meters: int
    legs: list[RouteLeg]
    distance_m: float | None
    estimated_duration_s: float | None
    message: str | None
    verification: str | None
    created_at: str
    updated_at: str
    notice: str = SIMULATION_NOTICE


class AssignmentCandidate(CamelModel):
    drone_id: str
    depot_id: str
    eligible: bool
    reason: str
    pickup_eta_s: float | None = None
    total_eta_s: float | None = None
    total_distance_m: float | None = None


class AssignmentResult(CamelModel):
    order: Order
    assigned: bool
    candidates: list[AssignmentCandidate]
    message: str
