"""Coverage diagnostics: how much of Warsaw the loaded zone dataset covers.

A zone count of zero is never treated as an error by itself: a district can
genuinely have no zones. What matters is whether the dataset *covers* the
district (its declared extent). Outside the extent, zones are unknown, not
absent. SkyRoute never reports a district as VERIFIED: it cannot check a
dataset against the official source.
"""

from __future__ import annotations

from enum import StrEnum
from functools import lru_cache

from shapely.geometry.base import BaseGeometry

from app.airspace.evaluation import FlightContext
from app.airspace.models import (
    AirspaceCompleteness,
    AirspaceSourceInfo,
    AirspaceStatus,
    Completeness,
    DisplayClass,
    DraCategory,
    EvaluationStatus,
    FlightContextInfo,
    SourceType,
    ZoneEvaluation,
)
from app.airspace.repository import AirspaceState
from app.geo.coverage import Coverage
from app.routing.grid import to_metres
from app.schemas.common import CamelModel

FULL_COVERAGE_PCT = 99.9  # tolerance for boundary-vertex rounding


class DistrictStatus(StrEnum):
    OFFICIAL_SNAPSHOT = "OFFICIAL_SNAPSHOT"  # fully covered by a permitted official file
    OFFICIAL = "OFFICIAL"  # fully covered by a live official service
    SYNTHETIC = "SYNTHETIC"  # fully covered by synthetic data
    PARTIAL = "PARTIAL"  # partly covered: zones in the rest are unknown
    UNAVAILABLE = "UNAVAILABLE"  # not covered: zones are unknown


def category_group(c: DraCategory) -> str:
    if c == DraCategory.P:
        return "P"
    if c in (DraCategory.R, DraCategory.RH, DraCategory.RM, DraCategory.RL):
        return "R"
    if c == DraCategory.PLANNING:
        return "PLANNING"
    if c in (DraCategory.T, DraCategory.U, DraCategory.I):
        return c.value.removeprefix("DRA-")
    return "UNKNOWN"


class ZoneTotals(CamelModel):
    features: int
    by_group: dict[str, int]  # P, R (R/RH/RM/RL), T, U, I, UNKNOWN
    blocked: int  # RED: prohibited, or restricted with no authorization, for the planned operation
    conditional: int  # ORANGE: U-space services required
    technical: int  # YELLOW obstacle: technical requirements
    information: int  # warning only
    unverified: int  # GRAY: treated as blocked
    inactive: int  # outside validity or altitude band
    obstacles: int  # every zone the router avoids for these conditions


class DistrictCoverage(CamelModel):
    name: str
    teryt: str
    area_covered_pct: float
    status: DistrictStatus
    zone_count: int
    obstacle_count: int
    zone_ids: list[str]
    note: str


class AirspaceDiagnostics(CamelModel):
    source: AirspaceSourceInfo
    flight_context: FlightContextInfo
    airspace_status: AirspaceStatus  # official verification (the user-facing metric)
    # Development only: how much of Warsaw the loaded dataset's declared extent covers. For the
    # set this is the -zone coverage; it is never the application's coverage.
    completeness: AirspaceCompleteness
    totals: ZoneTotals
    districts: list[DistrictCoverage]
    zones_outside_city: list[str]  # ids of zones that do not touch the city at all
    duplicates_removed: int
    failed_requests: list[str]  # last provider reload error, if any
    warnings: list[str]


@lru_cache(maxsize=64)
def _metres(geom: BaseGeometry) -> BaseGeometry:
    return to_metres(geom)


def _covered_pct(extent_m: BaseGeometry | None, area_m: BaseGeometry) -> float:
    if extent_m is None:
        return 100.0  # the dataset claims the whole routing area
    if area_m.area == 0:
        return 0.0
    return round(100.0 * extent_m.intersection(area_m).area / area_m.area, 1)


def completeness(state: AirspaceState, coverage: Coverage) -> AirspaceCompleteness:
    src = state.dataset.source_type
    verification = {
        SourceType.SYNTHETIC: "SYNTHETIC: not official zones",
        SourceType.PERMITTED_SNAPSHOT: "OFFICIAL_UNVERIFIED_LOCALLY: official file, currency not checked by SkyRoute",
        SourceType.OFFICIAL: "OFFICIAL_UNVERIFIED_LOCALLY: official service, not independently verified",
        SourceType.NONE: "UNAVAILABLE: no airspace data loaded",
    }[src]
    if coverage.geom is None:
        return AirspaceCompleteness(status=Completeness.UNKNOWN, city_area_covered_pct=None,
                                    verification_status=verification,
                                    message="The Warsaw boundary is unavailable, so dataset coverage cannot be measured.")
    if src == SourceType.NONE:
        return AirspaceCompleteness(status=Completeness.NONE, city_area_covered_pct=0.0,
                                    verification_status=verification, message="No airspace dataset is loaded.")
    pct = _covered_pct(state.extent_m, _metres(coverage.geom))
    if pct >= FULL_COVERAGE_PCT:
        status, msg = Completeness.COMPLETE, "The airspace dataset declares coverage of the whole City of Warsaw."
    elif pct > 0:
        status = Completeness.PARTIAL
        msg = (f"PARTIAL AIRSPACE DATA: the loaded dataset covers {pct:.1f}% of Warsaw"
               f"{f' ({state.dataset.extent_label})' if state.dataset.extent_label else ''}. "
               "Elsewhere zones are unknown, not absent, and routes there are not checked against any zones.")
    else:
        status = Completeness.NONE
        msg = "NO AIRSPACE DATA for Warsaw: the loaded dataset does not cover the city."
    return AirspaceCompleteness(status=status, city_area_covered_pct=pct, verification_status=verification, message=msg)


def _totals(state: AirspaceState, evals: list[ZoneEvaluation]) -> ZoneTotals:
    groups = dict.fromkeys(["P", "R", "T", "U", "I", "UNKNOWN", "PLANNING"], 0)
    for z in state.zones:
        groups[category_group(z.dra_category)] += 1
    by = lambda pred: sum(1 for e in evals if pred(e))  # noqa: E731
    return ZoneTotals(
        features=len(state.zones),
        by_group=groups,
        blocked=by(lambda e: e.display_class == DisplayClass.RED),
        conditional=by(lambda e: e.display_class == DisplayClass.ORANGE and e.is_obstacle),
        technical=by(lambda e: e.status == EvaluationStatus.UNAVAILABLE_TECHNICAL),
        information=by(lambda e: e.status == EvaluationStatus.INFORMATION),
        unverified=by(lambda e: e.status == EvaluationStatus.UNVERIFIED),
        inactive=by(lambda e: e.display_class == DisplayClass.INACTIVE),
        obstacles=by(lambda e: e.is_obstacle),
    )


def _district_status(pct: float, src: SourceType) -> DistrictStatus:
    if pct <= 0 or src == SourceType.NONE:
        return DistrictStatus.UNAVAILABLE
    if pct < FULL_COVERAGE_PCT:
        return DistrictStatus.PARTIAL
    return {SourceType.SYNTHETIC: DistrictStatus.SYNTHETIC, SourceType.PERMITTED_SNAPSHOT: DistrictStatus.OFFICIAL_SNAPSHOT,
            SourceType.OFFICIAL: DistrictStatus.OFFICIAL}[src]


def _district_note(status: DistrictStatus, count: int) -> str:
    if status == DistrictStatus.UNAVAILABLE:
        return "Not covered by the loaded dataset: zones here are UNKNOWN (not absent) and routes are not checked."
    if status == DistrictStatus.PARTIAL:
        return "Only partly covered: zones in the uncovered part are unknown."
    if count == 0:
        return "Covered, and no zone in the loaded dataset intersects this district. This is not a data error."
    return "Covered by the loaded dataset."


def diagnostics(state: AirspaceState, ctx: FlightContext, coverage: Coverage, last_error: str | None) -> AirspaceDiagnostics:
    evals = state.evaluations(ctx)
    comp = completeness(state, coverage)
    src = state.dataset.source_type
    districts = []
    for d in coverage.districts:
        d_m = _metres(d.geom)
        pct = _covered_pct(state.extent_m, d_m)
        idx = state.zones_touching(d_m)
        status = _district_status(pct, src)
        districts.append(DistrictCoverage(
            name=d.name, teryt=d.teryt, area_covered_pct=pct, status=status, zone_count=len(idx),
            obstacle_count=sum(1 for i in idx if evals[i].is_obstacle),
            zone_ids=[state.zones[i].id for i in idx], note=_district_note(status, len(idx)),
        ))
    outside: list[str] = []
    if coverage.geom is not None:
        inside = set(state.zones_touching(_metres(coverage.geom)))
        outside = [z.id for i, z in enumerate(state.zones) if i not in inside]

    warnings: list[str] = []
    if comp.status in (Completeness.PARTIAL, Completeness.NONE):
        warnings.append(comp.message)
    uncovered = [d.name for d in districts if d.status == DistrictStatus.UNAVAILABLE]
    if uncovered:
        warnings.append(f"{len(uncovered)} of {len(districts)} districts are not covered by the airspace dataset: "
                        + ", ".join(uncovered) + ".")
    if src == SourceType.SYNTHETIC:
        warnings.append("The loaded zones are synthetic, not official PAŻP geographical zones.")
    if outside:
        warnings.append(f"{len(outside)} zone(s) do not touch Warsaw at all ({', '.join(outside[:5])}"
                        f"{'…' if len(outside) > 5 else ''}). If they should, check the coordinate order "
                        "(GeoJSON is longitude, latitude).")
    if last_error:
        warnings.append("The last airspace dataset update failed; the previous version is still in use.")

    from app.airspace.status import airspace_status  # local: status imports this module's siblings

    return AirspaceDiagnostics(
        source=state.source_info(),
        airspace_status=airspace_status(state, coverage, ctx.at),
        flight_context=FlightContextInfo(flight_altitude_meters=int(ctx.altitude_agl_m), at=ctx.at),
        completeness=comp,
        totals=_totals(state, evals),
        districts=districts,
        zones_outside_city=outside,
        duplicates_removed=state.dataset.duplicates_removed,
        failed_requests=[last_error] if last_error else [],
        warnings=warnings,
    )
