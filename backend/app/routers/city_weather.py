from typing import Annotated

from fastapi import APIRouter, Depends

from app.dependencies import get_city_weather
from app.services.city_weather import CityWeatherResponse, CityWeatherService

router = APIRouter(tags=["open data"])


@router.get("/city-weather", response_model=CityWeatherResponse,
            summary="Current weather at Warsaw's ZOM stations (Open Data Warsaw, dane.um.warszawa.pl)")
async def city_weather(service: Annotated[CityWeatherService, Depends(get_city_weather)]) -> CityWeatherResponse:
    return await service.current()
