import asyncio

import httpx
import pytest

from app.schemas.planning import WeatherMode, WeatherSource
from app.services.weather import WeatherService, WindField, _interp_speed_dir, sample_points


def hourly(speed10, speed80, speed120, direction=270):
    return {"hourly": {"time": ["2026-10-17T12:00"], "wind_speed_10m": [speed10], "wind_speed_80m": [speed80],
                       "wind_speed_120m": [speed120], "wind_direction_10m": [direction],
                       "wind_direction_80m": [direction], "wind_direction_120m": [direction], "wind_gusts_10m": [30.0]}}


def service(handler):
    seen = []

    def wrapped(request):
        seen.append(request)
        return handler(request)

    return WeatherService(httpx.AsyncClient(transport=httpx.MockTransport(wrapped))), seen


def test_sample_points_scale_with_distance():
    short = sample_points((21.00, 52.23), (21.02, 52.23))  # ~1.4 km
    long = sample_points((21.03, 52.14), (21.00, 52.32))  # ~20 km
    assert len(short) == 2
    assert 4 <= len(long) <= 8
    assert long[0] == pytest.approx((21.04, 52.14), abs=0.011)


def test_altitude_interpolation():
    speed, direction = _interp_speed_dir([10, 20, 30], [270, 270, 270], 45)
    assert speed == pytest.approx(15) and direction == pytest.approx(270)
    assert _interp_speed_dir([10, 20, 30], [0, 0, 0], 120)[0] == pytest.approx(30)
    assert _interp_speed_dir([10, 20, 30], [0, 0, 0], 5)[0] == pytest.approx(10)  # clamped below 10 m


def test_live_samples_along_route_at_altitude():
    payload = [hourly(5, 10, 12), hourly(8, 16, 20), hourly(10, 30, 40)]
    svc, seen = service(lambda r: httpx.Response(200, json=payload))
    pts = [(21.0, 52.2), (21.05, 52.25), (21.1, 52.3)]
    info = asyncio.run(svc.get(WeatherMode.LIVE, 100, pts))
    assert info.source == WeatherSource.OPEN_METEO and len(info.samples) == 3
    assert info.samples[2].wind_speed_kmh == pytest.approx(35)  # between 80 m (30) and 120 m (40)
    assert info.wind_speed_kmh == pytest.approx(35)  # strongest sample reported
    q = seen[0].url.params
    assert q["latitude"].count(",") == 2 and "wind_speed_120m" in q["hourly"] and q["forecast_hours"] == "1"
    # cached: same points + altitude => no new request
    asyncio.run(svc.get(WeatherMode.LIVE, 100, pts))
    assert len(seen) == 1


def test_wind_field_nearest_sample():
    payload = [hourly(5, 10, 12), hourly(10, 30, 40)]
    svc, _ = service(lambda r: httpx.Response(200, json=payload))
    info = asyncio.run(svc.get(WeatherMode.LIVE, 80, [(21.0, 52.2), (21.1, 52.3)]))
    field = WindField(info.samples)
    assert field.at(21.01, 52.21).wind_speed_kmh == 10
    assert field.at(21.09, 52.29).wind_speed_kmh == 30


def test_live_failure_falls_back_explicitly():
    def boom(request):
        raise httpx.ConnectError("offline")

    svc, _ = service(boom)
    info = asyncio.run(svc.get(WeatherMode.LIVE, 80, [(21.0, 52.2)]))
    assert info.source == WeatherSource.DEMO_FALLBACK and info.live_available is False
    assert "Live weather is not available" in info.message


def test_demo_weather_is_fixed_and_not_fetched():
    svc, seen = service(lambda r: httpx.Response(500))
    info = asyncio.run(svc.get(WeatherMode.DEMO, 80, [(21.0, 52.2), (21.1, 52.3)]))
    assert info.source == WeatherSource.DEMO and seen == []
