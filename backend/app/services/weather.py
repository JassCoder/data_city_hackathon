"""DEMO (reproducible) and LIVE (Open-Meteo) wind data.

LIVE never pretends: if Open-Meteo fails, the result is demo wind marked
source=DEMO_FALLBACK with liveAvailable=false and an explicit message.
"""

from __future__ import annotations

import time
from collections.abc import Callable

import httpx

from app.config import (
    DEMO_WEATHER,
    MAP_CENTER,
    OPEN_METEO_URL,
    USER_AGENT,
    WEATHER_CACHE_TTL_S,
    WEATHER_TIMEOUT_S,
)
from app.schemas.planning import WeatherInfo, WeatherMode, WeatherSource

LIVE_UNAVAILABLE = "Live weather is not available"


def demo_weather() -> WeatherInfo:
    return WeatherInfo(
        mode=WeatherMode.DEMO,
        source=WeatherSource.DEMO,
        wind_speed_kmh=DEMO_WEATHER["windSpeedKmh"],
        wind_direction_deg=DEMO_WEATHER["windDirectionDeg"],
        wind_gust_kmh=DEMO_WEATHER["windGustKmh"],
        message="DEMO weather: fixed sample wind for reproducible results.",
    )


class WeatherService:
    def __init__(self, client: httpx.AsyncClient, clock: Callable[[], float] = time.monotonic):
        self._client = client
        self._clock = clock
        self._live: tuple[float, WeatherInfo] | None = None

    async def get(self, mode: WeatherMode) -> WeatherInfo:
        if mode == WeatherMode.DEMO:
            return demo_weather()
        if self._live and self._clock() - self._live[0] < WEATHER_CACHE_TTL_S:
            return self._live[1]
        try:
            info = await self._fetch_live()
        except (httpx.HTTPError, KeyError, TypeError, ValueError) as exc:
            fallback = demo_weather()
            return fallback.model_copy(update={
                "mode": WeatherMode.LIVE,
                "source": WeatherSource.DEMO_FALLBACK,
                "live_available": False,
                "message": f"{LIVE_UNAVAILABLE} ({type(exc).__name__}). Using DEMO wind instead.",
            })
        self._live = (self._clock(), info)
        return info

    async def _fetch_live(self) -> WeatherInfo:
        lat, lon = MAP_CENTER
        res = await self._client.get(
            OPEN_METEO_URL,
            params={
                "latitude": lat,
                "longitude": lon,
                "current": "wind_speed_10m,wind_direction_10m,wind_gusts_10m",
                "wind_speed_unit": "kmh",
                "timezone": "UTC",
            },
            headers={"User-Agent": USER_AGENT},
            timeout=WEATHER_TIMEOUT_S,
        )
        res.raise_for_status()
        cur = res.json()["current"]
        return WeatherInfo(
            mode=WeatherMode.LIVE,
            source=WeatherSource.OPEN_METEO,
            live_available=True,
            wind_speed_kmh=float(cur["wind_speed_10m"]),
            wind_direction_deg=float(cur["wind_direction_10m"]),
            wind_gust_kmh=float(cur["wind_gusts_10m"]) if cur.get("wind_gusts_10m") is not None else None,
            observed_at=f"{cur['time']}Z",
            message="LIVE weather from Open-Meteo (10 m wind, central Warsaw).",
        )
