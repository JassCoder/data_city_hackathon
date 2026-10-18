"""Simulated drone-delivery infrastructure API. Admin mutations need the
development token (header X-Admin-Token); see config.ADMIN_TOKEN."""

import hmac
from typing import Annotated

from fastapi import APIRouter, Depends, Header, HTTPException, Query

from app.config import ADMIN_TOKEN
from app.dependencies import get_fleet, get_weather
from app.fleet.models import (
    AssignmentResult,
    DepotCreate,
    Drone,
    DroneStatus,
    Facility,
    FacilityKind,
    FacilityPatch,
    Hospital,
    Order,
    OrderCreate,
    OrderStatus,
    PadCheck,
    PadCreate,
    Page,
    Restaurant,
    SubscriptionPatch,
    SubscriptionStatus,
)
from app.fleet.service import FleetError, FleetService
from app.geo.bbox import parse_bbox
from app.schemas.planning import Coordinate
from app.services.weather import WeatherService

router = APIRouter(tags=["fleet (simulation)"])

Fleet = Annotated[FleetService, Depends(get_fleet)]
BboxQ = Annotated[str | None, Query(description="minLon,minLat,maxLon,maxLat")]
Offset = Annotated[int, Query(ge=0)]
Limit = Annotated[int, Query(ge=1, le=5000)]


def require_admin(x_admin_token: Annotated[str | None, Header()] = None) -> None:
    """Development-only protection for administrative state changes (not production authentication)."""
    if ADMIN_TOKEN is None:
        raise HTTPException(403, "Administrative fleet changes are disabled: no SKYROUTE_ADMIN_TOKEN configured.")
    if not x_admin_token or not hmac.compare_digest(x_admin_token, ADMIN_TOKEN):
        raise HTTPException(401, "Missing or invalid X-Admin-Token (development admin token).")


Admin = Annotated[None, Depends(require_admin)]


def _call(fn, *args, **kwargs):
    try:
        return fn(*args, **kwargs)
    except FleetError as exc:
        raise HTTPException(exc.status_code, str(exc)) from exc


# --- hospitals (real OSM records + simulated station) ---------------------------------
@router.get("/hospitals", response_model=Page[Hospital], summary="OSM hospitals in Warsaw with their simulated station")
def hospitals(fleet: Fleet, bbox: BboxQ = None, district: str | None = None, offset: Offset = 0, limit: Limit = 500):
    return fleet.hospitals(parse_bbox(bbox) if bbox else None, district, offset, limit)


@router.get("/hospitals/{hospital_id:path}", response_model=Hospital)
def hospital(hospital_id: str, fleet: Fleet):
    return _call(fleet.hospital, hospital_id)


# --- depots ---------------------------------------------------------------------------
@router.get("/depots", response_model=list[Facility], summary="Simulated depots (existing Vistula depot + planned sites)")
def depots(fleet: Fleet, district: str | None = None):
    return fleet.facilities(FacilityKind.DEPOT, district)


@router.post("/depots", response_model=Facility, status_code=201)
def create_depot(req: DepotCreate, fleet: Fleet, _: Admin):
    return _call(fleet.create_depot, req)


@router.patch("/depots/{depot_id}", response_model=Facility)
def patch_depot(depot_id: str, req: FacilityPatch, fleet: Fleet, _: Admin):
    return _call(fleet.patch_facility, depot_id, req, FacilityKind.DEPOT)


@router.patch("/stations/{station_id}", response_model=Facility, summary="Edit a simulated hospital station")
def patch_station(station_id: str, req: FacilityPatch, fleet: Fleet, _: Admin):
    return _call(fleet.patch_facility, station_id, req, FacilityKind.HOSPITAL_STATION)


# --- restaurants ----------------------------------------------------------------------------
@router.get("/restaurants", response_model=Page[Restaurant], summary="OSM restaurants (paginated / bbox) + subscription")
def restaurants(fleet: Fleet, bbox: BboxQ = None, district: str | None = None,
                subscription: SubscriptionStatus | None = None, subscribed: bool = False,
                offset: Offset = 0, limit: Limit = 500):
    return fleet.restaurants(parse_bbox(bbox) if bbox else None, district, subscription, subscribed, offset, limit)


@router.get("/restaurants/{restaurant_id:path}", response_model=Restaurant)
def restaurant(restaurant_id: str, fleet: Fleet):
    if restaurant_id.endswith("/subscription"):
        raise HTTPException(405, "Use PATCH for /subscription.")
    return _call(fleet.restaurant, restaurant_id)


@router.patch("/restaurants/{restaurant_id:path}/subscription", response_model=Restaurant)
def subscription(restaurant_id: str, req: SubscriptionPatch, fleet: Fleet, _: Admin):
    return _call(fleet.set_subscription, restaurant_id, req.status)


# --- landing pads -------------------------------------------------------------------------------
@router.get("/landing-pads", response_model=list[Facility], summary="Proposed restaurant pickup pads")
def pads(fleet: Fleet, district: str | None = None):
    return fleet.facilities(FacilityKind.RESTAURANT_PAD, district)


@router.post("/landing-pads", response_model=Facility, status_code=201)
def create_pad(req: PadCreate, fleet: Fleet, _: Admin):
    return _call(fleet.create_pad, req)


@router.patch("/landing-pads/{pad_id}", response_model=Facility)
def patch_pad(pad_id: str, req: FacilityPatch, fleet: Fleet, _: Admin):
    return _call(fleet.patch_facility, pad_id, req, FacilityKind.RESTAURANT_PAD)


@router.post("/landing-pads/check", response_model=PadCheck,
             summary="Check a proposed landing point (map data cannot verify physical suitability)")
def check_pad(point: Coordinate, fleet: Fleet, facility_id: str | None = None):
    ref = None
    if facility_id:
        ref = fleet.pois.restaurants.get(facility_id) or fleet.pois.hospitals.get(facility_id)
        if ref is None:
            raise HTTPException(404, f"Facility '{facility_id}' not found.")
    return fleet.check_point(point.latitude, point.longitude, ref.latitude if ref else None,
                             ref.longitude if ref else None)


# --- drones & fleet --------------------------------------------------------------------------------
@router.get("/drones", response_model=list[Drone])
def drones(fleet: Fleet, status: DroneStatus | None = None, depot_id: str | None = None):
    return fleet.drones(status, depot_id)


@router.get("/drones/{drone_id}", response_model=Drone)
def drone(drone_id: str, fleet: Fleet):
    return _call(fleet.drone, drone_id)


@router.post("/drones/{drone_id}/finish-charging", response_model=Drone, summary="Simulation: end charging")
def finish_charging(drone_id: str, fleet: Fleet):
    return _call(fleet.finish_charging, drone_id)


@router.get("/fleet/summary")
def summary(fleet: Fleet, district: str | None = None) -> dict:
    return fleet.summary(district)


@router.get("/fleet/availability")
def availability(fleet: Fleet, district: str | None = None) -> list[dict]:
    return fleet.availability(district)


@router.get("/fleet/demand", summary="Simulated demand and capacity recommendations (never auto-applied)")
def demand(fleet: Fleet, scenario: str = "BASELINE") -> dict:
    return _call(fleet.demand, scenario)


# --- orders ------------------------------------------------------------------------------------------
@router.post("/orders", response_model=Order, status_code=201)
def create_order(req: OrderCreate, fleet: Fleet):
    return _call(fleet.create_order, req)


@router.get("/orders", response_model=list[Order])
def orders(fleet: Fleet, status: OrderStatus | None = None):
    return fleet.orders(status)


@router.get("/orders/{order_id}", response_model=Order)
def order(order_id: str, fleet: Fleet):
    return _call(fleet.order, order_id)


@router.post("/orders/{order_id}/assign-drone", response_model=AssignmentResult,
             summary="Rank eligible drones by routed time and reserve one plus landing capacity atomically")
async def assign(order_id: str, fleet: Fleet, weather: Annotated[WeatherService, Depends(get_weather)]):
    o = _call(fleet.order, order_id)
    info = await weather.get_for_route(
        _weather_mode(fleet, order_id), o.flight_altitude_meters,
        (o.pickup.longitude, o.pickup.latitude), (o.destination.longitude, o.destination.latitude))
    from fastapi.concurrency import run_in_threadpool
    try:
        return await run_in_threadpool(fleet.assign, order_id, info)
    except FleetError as exc:
        raise HTTPException(exc.status_code, str(exc)) from exc


def _weather_mode(fleet: FleetService, order_id: str):
    from app.schemas.planning import WeatherMode
    row = fleet.db.one("SELECT weather_mode FROM orders WHERE id = ?", (order_id,))
    return WeatherMode(row["weather_mode"])


@router.post("/orders/{order_id}/advance", response_model=Order, summary="Simulation: next delivery step")
def advance(order_id: str, fleet: Fleet):
    return _call(fleet.advance, order_id)


@router.post("/orders/{order_id}/cancel", response_model=Order)
def cancel(order_id: str, fleet: Fleet):
    return _call(fleet.cancel, order_id)
