"""Current weather across Warsaw from Open Data Warsaw (ZOM weather stations).

`POST https://dane.um.warszawa.pl/api/action/get_zom_pogoda` with the user's token in the
`Authorization` header returns one record per station (air and road temperature, humidity,
wind, precipitation intensity).

Fetching policy:
- The last good response is saved to CITY_WEATHER_FILE, so restarting the app reuses it.
- The API is called again only when the saved data is older than CITY_WEATHER_REFRESH_S (24 h).
- A failed refresh keeps the saved data, labelled CACHED, and is retried after CITY_WEATHER_RETRY_S.
- The status is LIVE for data younger than CITY_WEATHER_LIVE_S, otherwise SAVED (with its age).
The token stays on the server, and values are never invented.
"""

from __future__ import annotations

import json
import os
import time
from datetime import datetime, timezone
from enum import StrEnum
from pathlib import Path
from typing import Callable

import httpx

from app.config import (
    CITY_WEATHER_FILE,
    CITY_WEATHER_LIVE_S,
    CITY_WEATHER_REFRESH_S,
    CITY_WEATHER_RETRY_S,
    CITY_WEATHER_STALE_MAX_S,
    WARSAW_API_KEY,
    WARSAW_WEATHER_URL,
)
from app.schemas.common import CamelModel

SOURCE = "Open Data Warsaw (dane.um.warszawa.pl): weather stations of the City Cleaning Authority (ZOM)"
LICENSE = "CC BY: Capital City of Warsaw"
DATASET_URL = "https://dane.um.warszawa.pl/en/catalogue/db8077a8-d0e0-480a-af5d-040fb0ea176f"


class CityWeatherStatus(StrEnum):
    LIVE = "LIVE"  # fetched within the last CITY_WEATHER_LIVE_S
    SAVED = "SAVED"  # the saved daily snapshot (younger than the refresh interval)
    CACHED = "CACHED"  # the refresh failed; showing the last saved data
    UNAVAILABLE = "UNAVAILABLE"  # no key, or no data could be fetched or loaded


class Station(CamelModel):
    name: str
    latitude: float
    longitude: float
    measured_at: str | None
    air_temp_c: float | None
    road_temp_c: float | None
    humidity_pct: float | None
    wind_speed_ms: float | None
    wind_direction_deg: float | None
    precipitation: float | None  # intensity as published (int_opadu)


class CitySummary(CamelModel):
    stations: int
    air_temp_c: float | None  # mean over stations reporting it
    min_air_temp_c: float | None
    max_air_temp_c: float | None
    humidity_pct: float | None
    max_wind_speed_ms: float | None
    raining_stations: int
    latest_measurement: str | None


class CityWeatherResponse(CamelModel):
    status: CityWeatherStatus
    message: str
    fetched_at: str | None  # when the shown data was fetched from the API (UTC, ISO)
    age_s: int | None
    next_refresh_at: str | None  # earliest time the API will be called again (UTC, ISO)
    refresh_interval_s: int
    summary: CitySummary | None
    stations: list[Station]
    source: str = SOURCE
    license: str = LICENSE
    dataset_url: str = DATASET_URL


def _num(v) -> float | None:
    try:
        return None if v is None else float(v)
    except (TypeError, ValueError):
        return None


def _iso(epoch: float | None) -> str | None:
    return datetime.fromtimestamp(epoch, timezone.utc).isoformat(timespec="seconds") if epoch else None


def parse_stations(payload) -> list[Station]:
    if not isinstance(payload, list):
        raise ValueError("unexpected payload")
    out = []
    for r in payload:
        if not isinstance(r, dict):
            continue
        lat, lon = _num(r.get("lat")), _num(r.get("lon"))
        if lat is None or lon is None:
            continue
        out.append(Station(
            name=str(r.get("lokalizacja") or r.get("Lokalizacja") or "Unnamed station"),
            latitude=lat, longitude=lon, measured_at=r.get("czas"),
            air_temp_c=_num(r.get("temp_pow")), road_temp_c=_num(r.get("temp_naw")),
            humidity_pct=_num(r.get("wilg_pow")), wind_speed_ms=_num(r.get("pred_wiatru")),
            wind_direction_deg=_num(r.get("kier_wiatru")), precipitation=_num(r.get("int_opadu")),
        ))
    return out


def summarize(stations: list[Station]) -> CitySummary:
    def vals(attr):
        return [getattr(s, attr) for s in stations if getattr(s, attr) is not None]

    temps, hums, winds = vals("air_temp_c"), vals("humidity_pct"), vals("wind_speed_ms")
    times = [s.measured_at for s in stations if s.measured_at]
    return CitySummary(
        stations=len(stations),
        air_temp_c=round(sum(temps) / len(temps), 1) if temps else None,
        min_air_temp_c=min(temps) if temps else None, max_air_temp_c=max(temps) if temps else None,
        humidity_pct=round(sum(hums) / len(hums)) if hums else None,
        max_wind_speed_ms=max(winds) if winds else None,
        raining_stations=sum(1 for s in stations if (s.precipitation or 0) > 0),
        latest_measurement=max(times) if times else None,
    )


class CityWeatherService:
    def __init__(self, client: httpx.AsyncClient, api_key: str | None = WARSAW_API_KEY, url: str = WARSAW_WEATHER_URL,
                 cache_file: Path | None = CITY_WEATHER_FILE, refresh_s: int = CITY_WEATHER_REFRESH_S,
                 clock: Callable[[], float] = time.time, timeout_s: float = 10.0):
        self._client, self._key, self._url, self._clock, self._timeout = client, api_key, url, clock, timeout_s
        self._file, self._refresh_s = cache_file, refresh_s
        self._cache: tuple[float, list[Station]] | None = self._load()
        self._retry_at: float | None = None  # set after a failed refresh

    # --- saved snapshot -----------------------------------------------------------------
    def _load(self) -> tuple[float, list[Station]] | None:
        """The snapshot saved by an earlier run, if any (a broken file is ignored)."""
        if not self._file or not self._file.is_file():
            return None
        try:
            raw = json.loads(self._file.read_text(encoding="utf-8"))
            stations = [Station.model_validate(s) for s in raw["stations"]]
            return (float(raw["fetchedAt"]), stations) if stations else None
        except (OSError, ValueError, KeyError, TypeError):
            return None

    def _save(self, fetched: float, stations: list[Station]) -> None:
        if not self._file:
            return
        try:
            self._file.parent.mkdir(parents=True, exist_ok=True)
            tmp = self._file.with_suffix(".tmp")
            tmp.write_text(json.dumps({"fetchedAt": fetched, "source": SOURCE,
                                       "stations": [s.model_dump(by_alias=True) for s in stations]}), encoding="utf-8")
            os.replace(tmp, self._file)  # atomic: a crash never leaves a half-written file
        except OSError:
            pass  # keeping it in memory is still correct; it is just fetched again after a restart

    # --- responses ----------------------------------------------------------------------
    def _response(self, status: CityWeatherStatus, message: str, next_refresh: float | None) -> CityWeatherResponse:
        fetched, stations = self._cache if self._cache else (None, [])
        return CityWeatherResponse(
            status=status, message=message, fetched_at=_iso(fetched),
            age_s=int(self._clock() - fetched) if fetched else None,
            next_refresh_at=_iso(next_refresh), refresh_interval_s=self._refresh_s,
            summary=summarize(stations) if stations else None, stations=stations,
        )

    def _fresh(self, now: float) -> CityWeatherResponse:
        fetched = self._cache[0]
        age = now - fetched
        status = CityWeatherStatus.LIVE if age <= CITY_WEATHER_LIVE_S else CityWeatherStatus.SAVED
        msg = ("Live data from the Open Data Warsaw API." if status == CityWeatherStatus.LIVE else
               f"Saved Open Data Warsaw data, fetched {int(age // 3600)} h {int(age % 3600 // 60)} min ago; "
               f"refreshed every {self._refresh_s // 3600} h.")
        return self._response(status, msg, fetched + self._refresh_s)

    def _stale_or_unavailable(self, now: float, reason: str) -> CityWeatherResponse:
        if self._cache and now - self._cache[0] <= CITY_WEATHER_STALE_MAX_S:
            return self._response(CityWeatherStatus.CACHED,
                                  f"Open Data Warsaw is unavailable ({reason}); showing the last saved data.", self._retry_at)
        self._cache = None
        return self._response(CityWeatherStatus.UNAVAILABLE, f"Open Data Warsaw is unavailable ({reason}).", self._retry_at)

    async def current(self) -> CityWeatherResponse:
        now = self._clock()
        if self._cache and now - self._cache[0] < self._refresh_s:
            return self._fresh(now)  # saved data is recent enough: no API call
        if not self._key:
            if self._cache:
                return self._stale_or_unavailable(now, "API key not configured")
            return self._response(CityWeatherStatus.UNAVAILABLE,
                                  "Open Data Warsaw API key is not configured (set SKYROUTE_WARSAW_API_KEY).", None)
        if self._retry_at and now < self._retry_at:
            return self._stale_or_unavailable(now, "the last refresh failed; retrying later")
        try:
            res = await self._client.post(self._url, headers={"Authorization": self._key, "Content-Type": "application/json"},
                                          timeout=self._timeout)
            res.raise_for_status()
            stations = parse_stations(res.json())
            if not stations:
                raise ValueError("no stations in the response")
        except (httpx.HTTPError, ValueError) as exc:
            self._retry_at = now + CITY_WEATHER_RETRY_S
            reason = f"HTTP {exc.response.status_code}" if isinstance(exc, httpx.HTTPStatusError) else type(exc).__name__
            return self._stale_or_unavailable(now, reason)
        self._retry_at = None
        self._cache = (now, stations)
        self._save(now, stations)
        return self._fresh(now)
