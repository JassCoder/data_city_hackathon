"""Official-airspace verification status of the loaded zone dataset.

This is the user-facing airspace metric. It is about OFFICIAL data only:
synthetic  zones never count, so with the bundled set official
coverage is 0 % and verification is UNAVAILABLE ( coverage is reported
separately, in the development diagnostics).

Coverage of an official file comes from the extent it declares, and is
labelled as declared (SkyRoute cannot verify a dataset's scope). A file
without a declared extent has unknown coverage, not 100 %. Missing data is
never reported as "no restrictions".
"""

from __future__ import annotations

from datetime import datetime, timezone
from enum import StrEnum

from shapely.geometry.base import BaseGeometry

from app.airspace.models import AirspaceStatus, SourceType
from app.airspace.repository import AirspaceState
from app.config import AIRSPACE_STALE_AFTER_DAYS
from app.geo.coverage import Coverage
from app.routing.grid import to_metres


class SourceState(StrEnum):
    OFFICIAL = "OFFICIAL"  # live official service, current
    OFFICIAL_SNAPSHOT = "OFFICIAL_SNAPSHOT"  # permitted official file, current
    SYNTHETIC = "SYNTHETIC"  # synthetic zones only: official verification unavailable
    UNAVAILABLE = "UNAVAILABLE"  # no airspace data loaded
    STALE = "STALE"  # official data older than AIRSPACE_STALE_AFTER_DAYS, or undated


def _age_days(ts: datetime | None, now: datetime) -> int | None:
    return None if ts is None else max(0, (now - ts).days)


def source_state(source_type: SourceType, source_timestamp: datetime | None, now: datetime) -> SourceState:
    if source_type == SourceType.NONE:
        return SourceState.UNAVAILABLE
    if source_type == SourceType.SYNTHETIC:
        return SourceState.SYNTHETIC
    age = _age_days(source_timestamp, now)
    if age is None or age > AIRSPACE_STALE_AFTER_DAYS:
        return SourceState.STALE
    return SourceState.OFFICIAL if source_type == SourceType.OFFICIAL else SourceState.OFFICIAL_SNAPSHOT


_city_m_cache: dict[int, BaseGeometry] = {}


def _city_m(coverage: Coverage) -> BaseGeometry | None:
    if coverage.geom is None:
        return None
    key = id(coverage.geom)
    if key not in _city_m_cache:
        _city_m_cache[key] = to_metres(coverage.geom)
    return _city_m_cache[key]


def airspace_status(state: AirspaceState, coverage: Coverage, now: datetime | None = None) -> AirspaceStatus:
    now = now or datetime.now(timezone.utc)
    ds = state.dataset
    st = source_state(ds.source_type, ds.source_timestamp, now)
    age = _age_days(ds.source_timestamp, now)
    official = st in (SourceState.OFFICIAL, SourceState.OFFICIAL_SNAPSHOT, SourceState.STALE)

    pct: float | None
    if not official:
        pct, basis = 0.0, "NO_OFFICIAL_DATA"
    elif state.extent_m is None:
        pct, basis = None, "NOT_DECLARED"
    else:
        city = _city_m(coverage)
        pct = None if city is None else round(100.0 * state.extent_m.intersection(city).area / city.area, 1)
        basis = "DECLARED_EXTENT"

    msg = {
        SourceState.UNAVAILABLE: "Official airspace data UNAVAILABLE: no zone dataset is loaded. Routes are unverified "
                                 "simulations; unknown airspace is not unrestricted airspace.",
        SourceState.SYNTHETIC: "Official airspace data UNAVAILABLE. Only synthetic zones are loaded; they are not "
                               "official restrictions. Routes are unverified simulations.",
        SourceState.STALE: f"Official zone data is STALE ({'undated' if age is None else f'{age} days old'}; limit "
                           f"{AIRSPACE_STALE_AFTER_DAYS} days). Routes are unverified simulations until it is refreshed.",
        SourceState.OFFICIAL_SNAPSHOT: "Official zone snapshot (permitted file). Check currency in PAŻP "
                                       "DroneTower/DroneMap before any real flight.",
        SourceState.OFFICIAL: "Official zone data. Not a flight authorization.",
    }[st]
    if official and basis == "NOT_DECLARED":
        msg += " The file declares no coverage extent, so its geographic scope is unknown."
    elif official and pct is not None and pct < 99.9:
        msg += f" Declared coverage: {pct:.1f} % of Warsaw."
    return AirspaceStatus(
        source_state=st.value,
        official_data_available=st in (SourceState.OFFICIAL, SourceState.OFFICIAL_SNAPSHOT),
        official_coverage_pct=pct,
        coverage_basis=basis,
        age_days=age,
        stale_after_days=AIRSPACE_STALE_AFTER_DAYS,
        provider=ds.provider,
        label=ds.label,
        message=msg,
    )


VERIFICATION_TEXT = {
    SourceState.UNAVAILABLE: "UNVERIFIED SIMULATION: no airspace data is loaded (official airspace verification "
                             "UNAVAILABLE), so no zones were checked. Not permission for real drone operation.",
    SourceState.SYNTHETIC: "UNVERIFIED SIMULATION: official airspace data UNAVAILABLE; only synthetic zones were "
                           "checked. Not permission for real drone operation.",
    SourceState.STALE: "UNVERIFIED SIMULATION: the official zone data is STALE and may not reflect current zones. "
                       "Not permission for real drone operation; confirm in PAŻP DroneTower/DroneMap.",
    SourceState.OFFICIAL_SNAPSHOT: "SIMULATION_ONLY: official zone snapshot, not checked for currency. Not a check of "
                                   "real-world flight legality; confirm in PAŻP DroneTower/DroneMap.",
    SourceState.OFFICIAL: "SIMULATION_ONLY: official zone data. Not a flight authorization; confirm in PAŻP "
                          "DroneTower/DroneMap.",
}
