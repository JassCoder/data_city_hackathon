"""Calculation time in Warsaw (Europe/Warsaw).

The backend decides the effective calculation/departure time when a request
supplies none, and uses the same instant for zone validity and the weather
forecast hour. Uses the system tz database when available; otherwise (e.g. a
Windows Python without the tzdata package) applies the EU daylight-saving rule
Poland follows: CEST (UTC+2) from 01:00 UTC on the last Sunday of March to
01:00 UTC on the last Sunday of October, CET (UTC+1) otherwise.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

try:  # pragma: no cover - depends on the platform's tz database
    from zoneinfo import ZoneInfo

    _WARSAW = ZoneInfo("Europe/Warsaw")
except Exception:  # noqa: BLE001 - ZoneInfoNotFoundError or missing module
    _WARSAW = None


def _last_sunday(year: int, month: int) -> datetime:
    nxt = datetime(year + (month == 12), month % 12 + 1, 1, tzinfo=timezone.utc)
    last = nxt - timedelta(days=1)
    return last - timedelta(days=(last.weekday() + 1) % 7)


def warsaw_offset(utc: datetime) -> timedelta:
    """UTC offset of Warsaw at the given instant (EU rule)."""
    start = _last_sunday(utc.year, 3).replace(hour=1)
    end = _last_sunday(utc.year, 10).replace(hour=1)
    return timedelta(hours=2) if start <= utc < end else timedelta(hours=1)


def to_warsaw(when: datetime) -> datetime:
    when = when if when.tzinfo else when.replace(tzinfo=timezone.utc)
    if _WARSAW is not None:
        return when.astimezone(_WARSAW)
    utc = when.astimezone(timezone.utc)
    return utc.astimezone(timezone(warsaw_offset(utc), "Europe/Warsaw"))


def warsaw_now(now: datetime | None = None) -> datetime:
    """Current time in Warsaw as an aware datetime (`now` is for tests)."""
    return to_warsaw(now or datetime.now(timezone.utc))
