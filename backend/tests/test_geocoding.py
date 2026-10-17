import asyncio

import httpx
import pytest

from app.dependencies import get_geocoder
from app.geo.coverage import load_city_coverage
from app.services.geocoding import (
    GeocodingBusyError,
    GeocodingError,
    GeocodingService,
    NominatimProvider,
    RateLimiter,
    TTLCache,
)

KOPERNIK = {
    "place_id": 123,
    "lat": "52.2417800",
    "lon": "21.0286000",
    "display_name": "Centrum Nauki Kopernik, 20, Wybrzeże Kościuszkowskie, Powiśle, Warszawa",
    "category": "tourism",
    "type": "museum",
}
AIRPORT = {
    "place_id": 456,
    "lat": "52.16307",
    "lon": "20.97081",
    "display_name": "Lotnisko Chopina, Okęcie, Warszawa",
    "category": "aeroway",
    "type": "aerodrome",
}
PIASECZNO = {  # town south of Warsaw: outside the city boundary
    "place_id": 789,
    "lat": "52.0812",
    "lon": "21.0240",
    "display_name": "Piaseczno, powiat piaseczyński",
    "category": "boundary",
    "type": "administrative",
}
CITY = load_city_coverage()


class FakeClock:
    def __init__(self):
        self.t = 1000.0
        self.slept: list[float] = []

    def __call__(self):
        return self.t

    async def sleep(self, s):
        self.slept.append(s)
        self.t += s


def make_service(handler, clock=None):
    clock = clock or FakeClock()
    seen = []

    def wrapped(request):
        seen.append(request)
        return handler(request)

    client = httpx.AsyncClient(transport=httpx.MockTransport(wrapped))
    provider = NominatimProvider(client, "https://nominatim.test/search", "SkyRouteTest/1.0", "20.85,52.37,21.27,52.09",
                                 contains=CITY.contains)
    service = GeocodingService(
        provider, TTLCache(10, 3600, clock), RateLimiter(1.0, 5.0, clock, clock.sleep), limit=5
    )
    return service, seen, clock


def ok(*items):
    return lambda request: httpx.Response(200, json=list(items))


# --- parsing & provider ------------------------------------------------------

def test_parse_nominatim_results_and_coverage_flag():
    results = NominatimProvider.parse([KOPERNIK, AIRPORT, PIASECZNO], CITY.contains)
    assert [r.display_name for r in results][:2] == [KOPERNIK["display_name"], AIRPORT["display_name"]]
    k, a, p = results
    assert (k.latitude, k.longitude) == (52.24178, 21.0286)
    assert k.place_id == "nominatim:123" and k.source == "nominatim" and k.category == "tourism/museum"
    assert k.in_coverage is True
    assert a.in_coverage is True  # Chopin Airport (Włochy district) is inside the city polygon
    assert p.in_coverage is False  # Piaseczno is outside Warsaw


def test_parse_skips_malformed_entries():
    results = NominatimProvider.parse([KOPERNIK, {"lat": "x", "lon": "1", "display_name": "bad"}, {"foo": 1}])
    assert len(results) == 1


def test_parse_rejects_non_list_payload():
    with pytest.raises(GeocodingError):
        NominatimProvider.parse({"error": "nope"})


def test_provider_sends_policy_compliant_request():
    service, seen, _ = make_service(ok(KOPERNIK))
    asyncio.run(service.search("Centrum Nauki Kopernik"))
    req = seen[0]
    assert req.headers["User-Agent"] == "SkyRouteTest/1.0"
    assert req.url.params["format"] == "jsonv2"
    assert req.url.params["bounded"] == "1" and req.url.params["countrycodes"] == "pl"
    assert req.url.params["q"] == "Centrum Nauki Kopernik"


def test_provider_failure_raises_geocoding_error():
    service, _, _ = make_service(lambda r: httpx.Response(503, text="overloaded"))
    with pytest.raises(GeocodingError):
        asyncio.run(service.search("Stadion Narodowy"))


def test_network_failure_raises_geocoding_error():
    def boom(request):
        raise httpx.ConnectTimeout("timeout")

    service, _, _ = make_service(boom)
    with pytest.raises(GeocodingError):
        asyncio.run(service.search("Stadion Narodowy"))


# --- cache & rate limit ------------------------------------------------------

def test_cache_serves_repeat_queries_without_calling_provider():
    service, seen, _ = make_service(ok(KOPERNIK))
    r1, cached1 = asyncio.run(service.search("Kopernik  Warszawa"))
    r2, cached2 = asyncio.run(service.search("  kopernik warszawa "))  # normalised + case-insensitive
    assert (cached1, cached2) == (False, True)
    assert r1 == r2 and len(seen) == 1


def test_cache_entries_expire():
    clock = FakeClock()
    service, seen, _ = make_service(ok(KOPERNIK), clock)
    asyncio.run(service.search("Kopernik"))
    clock.t += 3601
    asyncio.run(service.search("Kopernik"))
    assert len(seen) == 2


def test_rate_limiter_spaces_provider_calls_one_second_apart():
    service, seen, clock = make_service(ok(KOPERNIK))

    async def burst():
        for q in ("a1a", "b2b", "c3c"):
            await service.search(q)

    asyncio.run(burst())
    assert len(seen) == 3
    assert clock.slept == [1.0, 1.0]  # first call immediate, then 1 s apart


def test_rate_limiter_rejects_when_queue_too_long():
    clock = FakeClock()
    limiter = RateLimiter(1.0, 2.5, clock, clock.sleep)

    async def run():
        limiter._next_slot = clock.t + 3.0  # three calls already queued
        await limiter.acquire()

    with pytest.raises(GeocodingBusyError):
        asyncio.run(run())


# --- endpoint ------------------------------------------------------------------

URL = "/api/v1/geocoding/search"


def test_search_endpoint_returns_structured_results(client, overrides):
    service, _, _ = make_service(ok(KOPERNIK, PIASECZNO))
    overrides[get_geocoder] = lambda: service
    res = client.get(URL, params={"query": "Kopernik"})
    assert res.status_code == 200
    body = res.json()
    assert body["provider"] == "nominatim" and "OpenStreetMap" in body["attribution"]
    first = body["results"][0]
    assert set(first) >= {"displayName", "latitude", "longitude", "placeId", "source", "inCoverage"}
    assert body["results"][1]["inCoverage"] is False


@pytest.mark.parametrize("query", ["", "   ", "ab"])
def test_empty_or_too_short_search_rejected(client, overrides, query):
    service, seen, _ = make_service(ok(KOPERNIK))
    overrides[get_geocoder] = lambda: service
    assert client.get(URL, params={"query": query}).status_code == 422
    assert seen == []


def test_missing_or_too_long_query_rejected(client):
    assert client.get(URL).status_code == 422
    assert client.get(URL, params={"query": "x" * 201}).status_code == 422


def test_search_endpoint_provider_failure_is_503(client, overrides):
    service, _, _ = make_service(lambda r: httpx.Response(500))
    overrides[get_geocoder] = lambda: service
    res = client.get(URL, params={"query": "Kopernik"})
    assert res.status_code == 503
    assert "temporarily unavailable" in res.json()["detail"]


def test_search_endpoint_busy_is_429(client, overrides):
    class Busy:
        provider = NominatimProvider(None, "", "", "")

        async def search(self, q):
            raise GeocodingBusyError("busy")

    overrides[get_geocoder] = lambda: Busy()
    assert client.get(URL, params={"query": "Kopernik"}).status_code == 429


def test_search_endpoint_no_results(client, overrides):
    service, _, _ = make_service(ok())
    overrides[get_geocoder] = lambda: service
    res = client.get(URL, params={"query": "Nonexistent Street 999"})
    assert res.status_code == 200 and res.json()["results"] == []
