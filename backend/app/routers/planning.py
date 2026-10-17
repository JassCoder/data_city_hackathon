from datetime import datetime, timezone
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException
from fastapi.concurrency import run_in_threadpool

from app.airspace.models import SourceType
from app.dependencies import get_planner, get_profiles, get_weather
from app.routing.planner import RoutePlanner, plan_timed
from app.schemas.planning import (
    Coordinate,
    DroneProfilesResponse,
    LineStringGeometry,
    RouteRequest,
    RouteResponse,
    WeatherInfo,
    WeatherMode,
    WeatherSource,
)
from app.services.drone_profiles import DroneProfileRegistry
from app.services.weather import WeatherService

router = APIRouter(tags=["planning"])

BASE_SOURCES = [
    "Buildings, river & parks: © OpenStreetMap contributors (ODbL)",
    "Landing stations: synthetic DEMO DATA",
    "Drone profiles: sample DEMO data",
]

VERIFICATION = {
    SourceType.DEMO: "SIMULATION_ONLY: DEMO airspace (synthetic zones). Not a check of real-world flight legality.",
    SourceType.PERMITTED_SNAPSHOT: "SIMULATION_ONLY: official zone snapshot, not checked for currency. "
    "Not a check of real-world flight legality; confirm in PAŻP DroneTower/DroneMap.",
    SourceType.OFFICIAL: "SIMULATION_ONLY: official zone data. Not a check of real-world flight legality; "
    "confirm in PAŻP DroneTower/DroneMap.",
}


@router.get("/drone-profiles", response_model=DroneProfilesResponse)
def drone_profiles(profiles: Annotated[DroneProfileRegistry, Depends(get_profiles)]) -> DroneProfilesResponse:
    return profiles.response


@router.get("/weather", response_model=WeatherInfo)
async def weather(
    weather_service: Annotated[WeatherService, Depends(get_weather)],
    mode: WeatherMode = WeatherMode.DEMO,
) -> WeatherInfo:
    return await weather_service.get(mode)


@router.post("/routes/calculate", response_model=RouteResponse)
async def calculate_route(
    req: RouteRequest,
    profiles: Annotated[DroneProfileRegistry, Depends(get_profiles)],
    weather_service: Annotated[WeatherService, Depends(get_weather)],
    planner: Annotated[RoutePlanner, Depends(get_planner)],
) -> RouteResponse:
    profile = profiles.get(req.drone_profile_id)
    if profile is None:
        raise HTTPException(
            422, f"Unknown droneProfileId '{req.drone_profile_id}'. Available: {', '.join(profiles.ids)}."
        )
    weather = await weather_service.get(req.weather_mode)
    at = req.departure_time or datetime.now(timezone.utc)
    if at.tzinfo is None:
        at = at.replace(tzinfo=timezone.utc)
    result, ms = await run_in_threadpool(
        plan_timed,
        planner,
        (req.start.longitude, req.start.latitude),
        (req.destination.longitude, req.destination.latitude),
        req.mode,
        req.flight_altitude_meters,
        profile,
        weather,
        at,
    )
    warnings = list(result.warnings)
    if weather.source == WeatherSource.DEMO_FALLBACK:
        warnings.insert(0, weather.message)
    weather_source = {
        WeatherSource.DEMO: "Weather: DEMO sample wind",
        WeatherSource.OPEN_METEO: "Weather: Open-Meteo (live)",
        WeatherSource.DEMO_FALLBACK: "Weather: DEMO sample wind (live unavailable)",
    }[weather.source]

    path = result.path_lonlat
    source = result.airspace.source_info()
    airspace_line = f"Airspace zones: {source.label} ({source.source_type.value}, version {source.dataset_version})"
    return RouteResponse(
        status=result.status,
        message=result.message,
        geometry=LineStringGeometry(coordinates=[list(p) for p in path]) if path else None,
        distance_m=result.distance_m,
        eta_s=result.eta_s,
        mode=req.mode,
        flight_altitude_meters=req.flight_altitude_meters,
        drone_profile_id=profile.id,
        weather=weather,
        route_start=Coordinate(longitude=path[0][0], latitude=path[0][1]) if path else None,
        route_destination=Coordinate(longitude=path[-1][0], latitude=path[-1][1]) if path else None,
        zone_conflicts=result.conflicts,
        airspace=source,
        planning_verification_status=VERIFICATION[source.source_type],
        warnings=warnings,
        data_sources=[airspace_line, *BASE_SOURCES, weather_source],
        compute_ms=round(ms, 1),
    )
