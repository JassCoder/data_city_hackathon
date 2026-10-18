"""Address search behind a provider abstraction.

The first provider is public Nominatim, used within its usage policy:
server-side only, max 1 request/s, descriptive User-Agent, results cached,
attribution returned to the UI, no autocomplete (explicit search only).
An autocomplete-capable provider can implement `GeocodingProvider` with
`supports_autocomplete = True` and be swapped in `main.py`.
"""

from __future__ import annotations

import asyncio
import re
import time
from collections import OrderedDict
from collections.abc import Awaitable, Callable
from typing import Protocol

import httpx

from app.schemas.planning import GeocodeResult


class GeocodingError(RuntimeError):
    """The provider failed (network, HTTP error, malformed payload)."""


class GeocodingBusyError(RuntimeError):
    """Too many queued requests for the provider's rate limit."""


class GeocodingProvider(Protocol):
    name: str
    attribution: str
    supports_autocomplete: bool

    async def search(self, query: str, limit: int) -> list[GeocodeResult]: ...


ContainsFn = Callable[[float, float], bool]  # (lon, lat) -> inside routing coverage


def _never(lon: float, lat: float) -> bool:
    return False


class NominatimProvider:
    name = "nominatim"
    attribution = "Geocoding: © OpenStreetMap contributors (ODbL), via Nominatim"
    supports_autocomplete = False  # forbidden by the public Nominatim usage policy

    def __init__(
        self,
        client: httpx.AsyncClient,
        base_url: str,
        user_agent: str,
        viewbox: str,
        timeout_s: float = 8.0,
        contains: ContainsFn = _never,
    ):
        self._client = client
        self._base_url = base_url
        self._user_agent = user_agent
        self._viewbox = viewbox
        self._contains = contains
        self._timeout = timeout_s

    async def search(self, query: str, limit: int) -> list[GeocodeResult]:
        return [r for _, r in await self.search_raw(query, limit)]

    async def search_raw(self, query: str, limit: int) -> list[tuple[dict, GeocodeResult]]:
        """Results with the raw item (address details are used to classify accuracy)."""
        try:
            res = await self._client.get(
                self._base_url,
                params={
                    "q": query,
                    "format": "jsonv2",
                    "addressdetails": 1,
                    "limit": limit,
                    "countrycodes": "pl",
                    "viewbox": self._viewbox,  # official city bounds (+ margin)
                    "bounded": 1,
                    "accept-language": "pl,en",
                },
                headers={"User-Agent": self._user_agent},
                timeout=self._timeout,
            )
            res.raise_for_status()
            payload = res.json()
        except (httpx.HTTPError, ValueError) as exc:
            raise GeocodingError(f"Nominatim request failed: {type(exc).__name__}") from exc
        results = self.parse(payload, self._contains)
        raws = [item for item in payload if isinstance(item, dict) and item.get("lat") and item.get("display_name")] \
            if isinstance(payload, list) else []
        return list(zip(raws, results))

    @staticmethod
    def parse(payload: object, contains: ContainsFn = _never) -> list[GeocodeResult]:
        if not isinstance(payload, list):
            raise GeocodingError("Nominatim returned an unexpected payload")
        results = []
        for item in payload:
            try:
                lat, lon = float(item["lat"]), float(item["lon"])
                name = str(item["display_name"])
            except (KeyError, TypeError, ValueError):
                continue  # skip malformed entries rather than failing the search
            category = "/".join(str(item[k]) for k in ("category", "type") if item.get(k)) or None
            results.append(GeocodeResult(
                display_name=name,
                latitude=lat,
                longitude=lon,
                place_id=f"nominatim:{item['place_id']}" if item.get("place_id") is not None else None,
                category=category,
                source="nominatim",
                in_coverage=contains(lon, lat),  # point-in-polygon on the official Warsaw boundary
            ))
        return results


class TTLCache[V]:
    def __init__(self, max_entries: int, ttl_s: float, clock: Callable[[], float] = time.monotonic):
        self._data: OrderedDict[str, tuple[float, V]] = OrderedDict()
        self._max = max_entries
        self._ttl = ttl_s
        self._clock = clock

    def get(self, key: str) -> V | None:
        hit = self._data.get(key)
        if hit is None:
            return None
        stored_at, value = hit
        if self._clock() - stored_at > self._ttl:
            del self._data[key]
            return None
        self._data.move_to_end(key)
        return value

    def set(self, key: str, value: V) -> None:
        self._data[key] = (self._clock(), value)
        self._data.move_to_end(key)
        while len(self._data) > self._max:
            self._data.popitem(last=False)


class RateLimiter:
    """At most one call per `min_interval_s`, process-wide. Callers queue; a
    caller that would wait longer than `max_wait_s` gets GeocodingBusyError."""

    def __init__(
        self,
        min_interval_s: float,
        max_wait_s: float,
        clock: Callable[[], float] = time.monotonic,
        sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
    ):
        self._interval = min_interval_s
        self._max_wait = max_wait_s
        self._clock = clock
        self._sleep = sleep
        self._next_slot = 0.0

    async def acquire(self) -> None:
        now = self._clock()
        slot = max(now, self._next_slot)
        wait = slot - now
        if wait > self._max_wait:
            raise GeocodingBusyError("Geocoding is busy, please retry in a few seconds")
        self._next_slot = slot + self._interval  # reserve before awaiting
        if wait > 0:
            await self._sleep(wait)


def normalise_query(query: str) -> str:
    return re.sub(r"\s+", " ", query).strip()


class GeocodingService:
    def __init__(self, provider: GeocodingProvider, cache: TTLCache, limiter: RateLimiter, limit: int = 8):
        self.provider = provider
        self._cache = cache
        self._limiter = limiter
        self._limit = limit

    async def search(self, query: str) -> tuple[list[GeocodeResult], bool]:
        """Returns (results, served_from_cache)."""
        results, cached, _ = await self.search_detailed(query)
        return results, cached

    async def search_detailed(self, query: str) -> tuple[list[GeocodeResult], bool, str | None]:
        """Returns (results, served_from_cache, note). Providers with `search_detailed`
        (AddressGeocoder) also explain accuracy, e.g. an unmatched building number."""
        q = normalise_query(query)
        key = q.casefold()
        cached = self._cache.get(key)
        if cached is not None:
            return cached[0], True, cached[1]
        await self._limiter.acquire()
        if hasattr(self.provider, "search_detailed"):
            results, note = await self.provider.search_detailed(q, self._limit)
        else:
            results, note = await self.provider.search(q, self._limit), None
        self._cache.set(key, (results, note))
        return results, False, note
