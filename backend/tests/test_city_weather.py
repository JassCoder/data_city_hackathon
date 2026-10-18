"""Open Data Warsaw city weather: token in the header, saved daily snapshot, honest fallbacks. No network."""

import asyncio

import httpx
import pytest

from app.config import CITY_WEATHER_RETRY_S
from app.dependencies import get_city_weather
from app.services.city_weather import CityWeatherService, CityWeatherStatus, parse_stations, summarize

DAY = 24 * 3600
ROWS = [
    {"lokalizacja": "Stacja Bielany", "lat": 52.29241, "lon": 20.97288, "czas": "2026-10-18 10:00:00",
     "temp_pow": 6.1, "temp_naw": 10.6, "wilg_pow": 99.8, "pred_wiatru": 0.5, "kier_wiatru": 225.0, "int_opadu": 0.0},
    {"lokalizacja": "Stacja Krakowska", "lat": 52.1752, "lon": 20.94439, "czas": "2026-10-18 10:10:00",
     "temp_pow": 8.1, "temp_naw": 12.8, "wilg_pow": 96.0, "pred_wiatru": 1.9, "kier_wiatru": 121.0, "int_opadu": 0.4},
    {"lokalizacja": "broken", "lat": None, "lon": 21.0},  # skipped: no position
]


class Api:
    """A fake Open Data Warsaw API that counts calls and can be switched off."""

    def __init__(self):
        self.calls, self.up = [], True

    def __call__(self, req: httpx.Request):
        self.calls.append(req)
        return httpx.Response(200, json=ROWS) if self.up else httpx.Response(503)


@pytest.fixture
def clock():
    return {"t": 1_000_000.0}


def make(api, clock, tmp_path, key="test-token"):
    return CityWeatherService(httpx.AsyncClient(transport=httpx.MockTransport(api)), api_key=key,
                              url="https://dane.um.warszawa.pl/api/action/get_zom_pogoda",
                              cache_file=tmp_path / "city_weather.json", refresh_s=DAY, clock=lambda: clock["t"])


def current(svc):
    return asyncio.run(svc.current())


def test_parses_stations_and_summarizes_the_city():
    stations = parse_stations(ROWS)
    assert [s.name for s in stations] == ["Stacja Bielany", "Stacja Krakowska"]
    s = summarize(stations)
    assert (s.stations, s.air_temp_c, s.min_air_temp_c, s.max_air_temp_c) == (2, 7.1, 6.1, 8.1)
    assert s.humidity_pct == 98 and s.max_wind_speed_ms == 1.9 and s.raining_stations == 1
    assert s.latest_measurement == "2026-10-18 10:10:00"


def test_sends_the_token_in_the_authorization_header_never_in_the_url(clock, tmp_path):
    api = Api()
    r = current(make(api, clock, tmp_path))
    assert r.status == CityWeatherStatus.LIVE and r.summary.stations == 2
    assert api.calls[0].method == "POST" and api.calls[0].headers["Authorization"] == "test-token"
    assert "test-token" not in str(api.calls[0].url)


def test_fetches_once_per_day_and_a_restart_reuses_the_saved_data(clock, tmp_path):
    api = Api()
    current(make(api, clock, tmp_path))
    assert len(api.calls) == 1 and (tmp_path / "city_weather.json").is_file()
    # The app restarts an hour later: the saved snapshot is used, the API is not called.
    clock["t"] += 3600
    restarted = make(api, clock, tmp_path)
    r = current(restarted)
    assert len(api.calls) == 1
    assert r.status == CityWeatherStatus.SAVED and r.age_s == 3600 and r.summary.air_temp_c == 7.1
    clock["t"] += DAY - 3600 - 60  # still within 24 h
    current(restarted)
    assert len(api.calls) == 1
    clock["t"] += 120  # now older than 24 h: refresh
    r = current(restarted)
    assert len(api.calls) == 2 and r.status == CityWeatherStatus.LIVE


def test_failed_daily_refresh_keeps_the_saved_data_and_retries_later(clock, tmp_path):
    api = Api()
    svc = make(api, clock, tmp_path)
    current(svc)
    api.up = False
    clock["t"] += DAY + 1
    r = current(svc)
    assert r.status == CityWeatherStatus.CACHED and "HTTP 503" in r.message and r.summary.stations == 2
    current(svc)  # within the retry wait: no new call
    assert len(api.calls) == 2
    api.up = True
    clock["t"] += CITY_WEATHER_RETRY_S + 1
    assert current(svc).status == CityWeatherStatus.LIVE and len(api.calls) == 3


def test_missing_key_is_reported_and_never_calls_the_api(clock, tmp_path):
    def api(req):
        raise AssertionError("must not be called without a key")

    r = current(make(api, clock, tmp_path, key=None))
    assert r.status == CityWeatherStatus.UNAVAILABLE and "SKYROUTE_WARSAW_API_KEY" in r.message


def test_a_broken_saved_file_is_ignored(clock, tmp_path):
    (tmp_path / "city_weather.json").write_text("{not json", encoding="utf-8")
    api = Api()
    assert current(make(api, clock, tmp_path)).status == CityWeatherStatus.LIVE and len(api.calls) == 1


def test_endpoint_returns_the_source_and_never_the_key(client, overrides, clock, tmp_path):
    svc = make(Api(), clock, tmp_path, key="secret-token-123")
    overrides[get_city_weather] = lambda: svc
    r = client.get("/api/v1/city-weather")
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "LIVE" and body["summary"]["airTempC"] == 7.1 and body["refreshIntervalS"] == DAY
    assert body["nextRefreshAt"] and "dane.um.warszawa.pl" in body["source"] and body["license"].startswith("CC BY")
    assert "secret-token-123" not in r.text
