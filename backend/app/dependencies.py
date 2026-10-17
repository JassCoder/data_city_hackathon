"""Accessors for the singletons built in main.lifespan (overridable in tests)."""

from fastapi import Request

from app.airspace.repository import AirspaceRepository
from app.routing.planner import RoutePlanner
from app.services.drone_profiles import DroneProfileRegistry
from app.services.geocoding import GeocodingService
from app.services.weather import WeatherService


def get_geocoder(request: Request) -> GeocodingService:
    return request.app.state.geocoder


def get_weather(request: Request) -> WeatherService:
    return request.app.state.weather


def get_profiles(request: Request) -> DroneProfileRegistry:
    return request.app.state.profiles


def get_planner(request: Request) -> RoutePlanner:
    return request.app.state.planner


def get_airspace(request: Request) -> AirspaceRepository:
    return request.app.state.planner.airspace
