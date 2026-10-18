from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException

from app.dependencies import get_profiles, get_route_service, get_weather
from app.routing.scenarios import SCENARIOS
from app.schemas.planning import (
    DroneProfilesResponse,
    RouteRequest,
    RouteResponse,
    ScenarioInfo,
    ScenariosResponse,
    WeatherInfo,
    WeatherMode,
)
from app.services.drone_profiles import DroneProfileRegistry
from app.services.route_service import InvalidRouteRequestError, RouteService
from app.services.weather import WeatherService

router = APIRouter(tags=["planning"])


@router.get("/drone-profiles", response_model=DroneProfilesResponse)
def drone_profiles(profiles: Annotated[DroneProfileRegistry, Depends(get_profiles)]) -> DroneProfilesResponse:
    return profiles.response


@router.get("/weather", response_model=WeatherInfo)
async def weather(
    weather_service: Annotated[WeatherService, Depends(get_weather)],
    mode: WeatherMode = WeatherMode.DEMO,
    altitude_m: int = 80,
) -> WeatherInfo:
    return await weather_service.get(mode, altitude_m)


@router.get("/scenarios", response_model=ScenariosResponse, summary="Routing scenarios (configuration only, no endpoints)")
def scenarios() -> ScenariosResponse:
    return ScenariosResponse(
        scenarios=[
            ScenarioInfo(
                id=c.id, display_name=c.display_name, description=c.description,
                optimization_goal=c.optimization_goal, route_objective=c.route_objective, mode=c.mode,
                respect_restricted_zones=c.respect_restricted_zones, use_weather=c.use_weather,
                recommended_profile_id=c.recommended_profile_id,
            )
            for c in SCENARIOS.values()
        ],
        note="Scenarios configure the optimisation only. Start and destination always come from the request.",
    )


@router.post("/routes/calculate", response_model=RouteResponse)
async def calculate_route(
    req: RouteRequest, service: Annotated[RouteService, Depends(get_route_service)]
) -> RouteResponse:
    try:
        return await service.calculate(req)
    except InvalidRouteRequestError as exc:
        raise HTTPException(422, str(exc)) from exc
