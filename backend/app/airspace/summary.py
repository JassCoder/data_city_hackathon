"""Zone counts and the airspace status for the planned flight.

Every number is computed from the loaded dataset and the same `evaluate()` the
router uses; nothing is hard-coded. An empty dataset is reported as UNKNOWN
airspace, never as unrestricted airspace.
"""

from __future__ import annotations

from enum import StrEnum

from app.airspace.diagnostics import AirspaceCompleteness, _totals, completeness
from app.airspace.evaluation import FlightContext
from app.airspace.models import AirspaceSourceInfo, AirspaceStatus, EvaluationStatus, FlightContextInfo
from app.airspace.repository import AirspaceState
from app.airspace.status import airspace_status
from app.config import AIRSPACE_SAFETY_MARGIN_M
from app.geo.coverage import Coverage
from app.schemas.common import CamelModel

OFFICIAL_UNAVAILABLE = "Official airspace data unavailable. Routing is an unverified simulation."
MARGIN_NOTE = ("Modelling assumption, not a legal requirement: blocked zones are widened by this margin for routing "
               "(SKYROUTE config AIRSPACE_SAFETY_MARGIN_M).")


class StatusGroup(StrEnum):
    BLOCKED = "BLOCKED"  # prohibited, or restricted with no authorization: the route may not enter
    CONDITIONAL = "CONDITIONAL"  # technical / U-space requirements not established: unavailable for routing
    INFORMATIONAL = "INFORMATIONAL"  # warning only
    UNKNOWN = "UNKNOWN"  # insufficient data: treated as blocked
    NOT_APPLICABLE = "NOT_APPLICABLE"  # outside the zone's altitude band or validity period


GROUP_OF: dict[EvaluationStatus, StatusGroup] = {
    EvaluationStatus.BLOCKED: StatusGroup.BLOCKED,
    EvaluationStatus.UNAVAILABLE_AUTHORIZATION: StatusGroup.BLOCKED,
    EvaluationStatus.UNAVAILABLE_TECHNICAL: StatusGroup.CONDITIONAL,
    EvaluationStatus.UNAVAILABLE_USPACE: StatusGroup.CONDITIONAL,
    EvaluationStatus.INFORMATION: StatusGroup.INFORMATIONAL,
    EvaluationStatus.UNVERIFIED: StatusGroup.UNKNOWN,
    EvaluationStatus.NOT_ACTIVE_TIME: StatusGroup.NOT_APPLICABLE,
    EvaluationStatus.NOT_APPLICABLE_ALTITUDE: StatusGroup.NOT_APPLICABLE,
}


class ZonesSummary(CamelModel):
    source: AirspaceSourceInfo
    flight_context: FlightContextInfo
    airspace_status: AirspaceStatus
    total_zones: int
    by_category: dict[str, int]  # P, R (R/RH/RM/RL), T, U, I, UNKNOWN
    by_status: dict[str, int]  # StatusGroup -> count, for this flight
    routing_obstacles: int
    warnings: list[str]


class AirspaceStatusResponse(CamelModel):
    source: AirspaceSourceInfo
    airspace_status: AirspaceStatus
    completeness: AirspaceCompleteness
    total_zones: int
    official_data_available: bool
    routing_uses_map_zones: bool  # the map and A* share one dataset and one evaluation
    safety_margin_m: float
    safety_margin_note: str
    warnings: list[str]


def _warnings(status: AirspaceStatus, total: int) -> list[str]:
    out = [] if status.official_data_available else [OFFICIAL_UNAVAILABLE]
    if total == 0:
        out.append("No zones are loaded: unknown airspace is not unrestricted airspace.")
    return out


def zones_summary(state: AirspaceState, ctx: FlightContext, coverage: Coverage) -> ZonesSummary:
    evals = state.evaluations(ctx)
    status = airspace_status(state, coverage)
    by_status = dict.fromkeys([g.value for g in StatusGroup], 0)
    for e in evals:
        by_status[GROUP_OF[e.status]] += 1
    return ZonesSummary(
        source=state.source_info(),
        flight_context=FlightContextInfo(flight_altitude_meters=int(ctx.altitude_agl_m), at=ctx.at),
        airspace_status=status,
        total_zones=len(state.zones),
        by_category=_totals(state, evals).by_group,
        by_status=by_status,
        routing_obstacles=sum(1 for e in evals if e.is_obstacle),
        warnings=_warnings(status, len(state.zones)),
    )


def status_report(state: AirspaceState, coverage: Coverage, margin_m: float = AIRSPACE_SAFETY_MARGIN_M) -> AirspaceStatusResponse:
    status = airspace_status(state, coverage)
    return AirspaceStatusResponse(
        source=state.source_info(),
        airspace_status=status,
        completeness=completeness(state, coverage),
        total_zones=len(state.zones),
        official_data_available=status.official_data_available,
        routing_uses_map_zones=True,
        safety_margin_m=margin_m,
        safety_margin_note=MARGIN_NOTE,
        warnings=_warnings(status, len(state.zones)),
    )
