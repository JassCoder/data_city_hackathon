"""SAMPLE (reproducible) and LIVE (Open-Meteo) wind, sampled along a route.

LIVE asks Open-Meteo for the next-hour forecast at several points along the
trip (one request, multiple locations) at 10/80/120 m and interpolates to the
flight altitude. LIVE never pretends: if Open-Meteo fails, the result is SAMPLE wind marked
source=SAMPLE_FALLBACK with liveAvailable=false and a message.
"""

from __future__ import annotations

import math
import time
from datetime import datetime, timezone
from collections import OrderedDict
from collections.abc import Callable
from dataclasses import dataclass

import httpx

from app.config import (
    _WEATHER,
    MAP_CENTER,
    OPEN_METEO_URL,
    USER_AGENT,
    WEATHER_CACHE_TTL_S,
    WEATHER_STALE_MAX_S,
    WEATHER_SAMPLE_SPACING_KM,
    WEATHER_SAMPLE_GRID_DEG,
    WEATHER_MAX_SAMPLES,
    WEATHER_TIMEOUT_S,
)
from app.schemas.planning import WeatherInfo, WeatherMode, WeatherSource, WindSample

LIVE_UNAVAILABLE = "Live weather is not available"
LEVELS_M = (10, 80, 120)  # Open-Meteo wind heights


@dataclass(frozen=True)
class WindField:
    """Wind samples along a route; `at()` returns the nearest sample."""

    samples: list[WindSample]

    def at(self, lon: float, lat: float) -> WindSample:
        k = math.cos(math.radians(lat))
        return min(self.samples, key=lambda s: ((s.longitude - lon) * k) ** 2 + (s.latitude - lat) ** 2)

    @property
    def max_speed(self) -> float:
        return max(s.wind_speed_kmh for s in self.samples)

    @property
    def max_gust(self) -> float | None:
        gusts = [s.wind_gust_kmh for s in self.samples if s.wind_gust_kmh is not None]
        return max(gusts) if gusts else None


def sample_points(start: tuple[float, float], end: tuple[float, float]) -> list[tuple[float, float]]:
    """Evenly spaced (lon, lat) points on the A-B line, about one per
    WEATHER_SAMPLE_SPACING_KM, snapped to a coarse grid so nearby trips share cache entries."""
    (lon0, lat0), (lon1, lat1) = start, end
    km = math.hypot((lon1 - lon0) * 111.32 * math.cos(math.radians((lat0 + lat1) / 2)), (lat1 - lat0) * 110.57)
    n = max(2, min(WEATHER_MAX_SAMPLES, int(km // WEATHER_SAMPLE_SPACING_KM) + 2))
    g = WEATHER_SAMPLE_GRID_DEG
    pts = []
    for i in range(n):
        t = i / (n - 1)
        p = (round((lon0 + (lon1 - lon0) * t) / g) * g, round((lat0 + (lat1 - lat0) * t) / g) * g)
        if p not in pts:
            pts.append((round(p[0], 4), round(p[1], 4)))
    return pts


def _interp_speed_dir(speeds: list[float], dirs: list[float], altitude: float) -> tuple[float, float]:
    """Linear in height between the Open-Meteo levels; directions averaged as vectors."""
    alt = min(max(altitude, LEVELS_M[0]), LEVELS_M[-1])
    for i in range(len(LEVELS_M) - 1):
        lo, hi = LEVELS_M[i], LEVELS_M[i + 1]
        if alt <= hi:
            t = (alt - lo) / (hi - lo)
            break
    speed = speeds[i] + (speeds[i + 1] - speeds[i]) * t
    u = (1 - t) * math.sin(math.radians(dirs[i])) + t * math.sin(math.radians(dirs[i + 1]))
    v = (1 - t) * math.cos(math.radians(dirs[i])) + t * math.cos(math.radians(dirs[i + 1]))
    return speed, math.degrees(math.atan2(u, v)) % 360


def _weather(altitude_m: float = 80) -> WeatherInfo:
    sample = WindSample(
        latitude=MAP_CENTER[0], longitude=MAP_CENTER[1],
        wind_speed_kmh=_WEATHER["windSpeedKmh"], wind_direction_deg=_WEATHER["windDirectionDeg"],
        wind_gust_kmh=_WEATHER["windGustKmh"],
    )
    return WeatherInfo(
        mode=WeatherMode.SAMPLE,
        source=WeatherSource.SAMPLE,
        wind_speed_kmh=sample.wind_speed_kmh,
        wind_direction_deg=sample.wind_direction_deg,
        wind_gust_kmh=sample.wind_gust_kmh,
        altitude_m=altitude_m,
        samples=[sample],
        message="SAMPLE weather: fixed sample wind for reproducible results (same everywhere).",
    )


class WeatherService:
    def __init__(self, client: httpx.AsyncClient, clock: Callable[[], float] = time.monotonic):
        self._client = client
        self._clock = clock
        self._cache: OrderedDict[tuple, tuple[float, WeatherInfo]] = OrderedDict()
        # Outcome of the latest LIVE Open-Meteo call (reported by GET /map/coverage).
        self.last_live_success: datetime | None = None
        self.last_live_error: str | None = None
        self.last_live_error_at: datetime | None = None

    async def get(self, mode: WeatherMode, altitude_m: float = 80,
                  points: list[tuple[float, float]] | None = None) -> WeatherInfo:
        """Weather for (lon, lat) points (default: city centre) at the flight altitude."""
        if mode == WeatherMode.SAMPLE:
            return _weather(altitude_m)
        points = points or [(MAP_CENTER[1], MAP_CENTER[0])]
        key = (tuple(points), round(altitude_m))
        hit = self._cache.get(key)
        if hit and self._clock() - hit[0] < WEATHER_CACHE_TTL_S:
            return hit[1]
        try:
            info = await self._fetch_live(points, altitude_m)
        except (httpx.HTTPError, KeyError, TypeError, ValueError, IndexError) as exc:
            self.last_live_error = f"{type(exc).__name__}: {exc}"[:200]
            self.last_live_error_at = datetime.now(timezone.utc)
            if hit and self._clock() - hit[0] < WEATHER_STALE_MAX_S:
                age_min = (self._clock() - hit[0]) / 60
                return hit[1].model_copy(update={
                    "source": WeatherSource.CACHED,
                    "live_available": False,
                    "message": f"{LIVE_UNAVAILABLE} ({type(exc).__name__}). Showing the last LIVE values "
                               f"(forecast {hit[1].observed_at or 'time unknown'}, retrieved {age_min:.0f} min ago); "
                               "they may not reflect current conditions.",
                })
            fallback = _weather(altitude_m)
            return fallback.model_copy(update={
                "mode": WeatherMode.LIVE,
                "source": WeatherSource.SAMPLE_FALLBACK,
                "live_available": False,
                "message": f"{LIVE_UNAVAILABLE} ({type(exc).__name__}) and nothing recent is cached. "
                           "The route uses SAMPLE wind, which is NOT live data.",
            })
        self.last_live_success = datetime.now(timezone.utc)
        self._cache[key] = (self._clock(), info)
        while len(self._cache) > 256:
            self._cache.popitem(last=False)
        return info

    async def get_for_route(self, mode: WeatherMode, altitude_m: float,
                            start: tuple[float, float], end: tuple[float, float]) -> WeatherInfo:
        return await self.get(mode, altitude_m, sample_points(start, end))

    async def _fetch_live(self, points: list[tuple[float, float]], altitude_m: float) -> WeatherInfo:
        variables = [f"wind_speed_{h}m" for h in LEVELS_M] + [f"wind_direction_{h}m" for h in LEVELS_M] + ["wind_gusts_10m"]
        res = await self._client.get(
            OPEN_METEO_URL,
            params={
                "latitude": ",".join(f"{lat:.4f}" for _, lat in points),
                "longitude": ",".join(f"{lon:.4f}" for lon, _ in points),
                "hourly": ",".join(variables),
                "forecast_hours": 1,
                "wind_speed_unit": "kmh",
                "timezone": "UTC",
            },
            headers={"User-Agent": USER_AGENT},
            timeout=WEATHER_TIMEOUT_S,
        )
        res.raise_for_status()
        payload = res.json()
        locations = payload if isinstance(payload, list) else [payload]
        if len(locations) not in (1, len(points)):
            raise ValueError("unexpected number of locations")
        samples, observed = [], None
        for i, (lon, lat) in enumerate(points):
            hourly = locations[min(i, len(locations) - 1)]["hourly"]
            speeds = [float(hourly[f"wind_speed_{h}m"][0]) for h in LEVELS_M]
            dirs = [float(hourly[f"wind_direction_{h}m"][0]) for h in LEVELS_M]
            speed, direction = _interp_speed_dir(speeds, dirs, altitude_m)
            gust = hourly.get("wind_gusts_10m", [None])[0]
            samples.append(WindSample(latitude=lat, longitude=lon, wind_speed_kmh=round(speed, 1),
                                      wind_direction_deg=round(direction), wind_gust_kmh=gust))
            observed = observed or hourly["time"][0]
        strongest = max(samples, key=lambda s: s.wind_speed_kmh)
        gusts = [s.wind_gust_kmh for s in samples if s.wind_gust_kmh is not None]
        return WeatherInfo(
            mode=WeatherMode.LIVE,
            source=WeatherSource.OPEN_METEO,
            live_available=True,
            wind_speed_kmh=strongest.wind_speed_kmh,
            wind_direction_deg=strongest.wind_direction_deg,
            wind_gust_kmh=max(gusts) if gusts else None,
            altitude_m=altitude_m,
            samples=samples,
            observed_at=f"{observed}Z" if observed else None,
            message=f"LIVE Open-Meteo forecast (next hour) at {len(samples)} point(s) along the route, "
            f"interpolated to {altitude_m:.0f} m. Strongest sample shown.",
        )
