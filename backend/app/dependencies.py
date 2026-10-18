"""Accessors for the singletons built in main.lifespan (overridable in tests)."""

from fastapi import Depends, Request

from app.airspace.repository import AirspaceRepository
from app.fleet.service import FleetService
from app.geo.airports import AirportData
from app.geo.coverage import Coverage
from app.routing.planner import RoutePlanner
from app.services.drone_profiles import DroneProfileRegistry
from app.services.geocoding import GeocodingService
from app.services.route_service import RouteService
from app.services.weather import WeatherService


def get_geocoder(request: Request) -> GeocodingService:
    return request.app.state.geocoder


def get_entrances(request: Request):
    return request.app.state.entrances


def get_weather(request: Request) -> WeatherService:
    return request.app.state.weather


def get_profiles(request: Request) -> DroneProfileRegistry:
    return request.app.state.profiles


def get_planner(request: Request) -> RoutePlanner:
    return request.app.state.planner


def get_airspace(request: Request) -> AirspaceRepository:
    return request.app.state.planner.airspace


def get_coverage(request: Request) -> Coverage:
    return request.app.state.planner.coverage


def get_fleet(request: Request) -> FleetService:
    return request.app.state.fleet


def get_airports(request: Request) -> AirportData:
    return request.app.state.airports


def get_weather_optional(request: Request) -> WeatherService | None:
    return getattr(request.app.state, "weather", None)


def get_route_service(
    planner: RoutePlanner = Depends(get_planner),
    profiles: DroneProfileRegistry = Depends(get_profiles),
    weather: WeatherService = Depends(get_weather),
) -> RouteService:
    """Built from the overridable singletons, so tests can fake any part."""
    return RouteService(planner, profiles, weather)
