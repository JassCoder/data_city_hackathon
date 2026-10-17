"""Decides, per planned flight, whether each zone is an obstacle.

Conservative by design: unknown validity = active, unknown altitude limits =
the zone covers that side without limit, unknown reference = applies, unknown
category/restriction = obstacle. Nothing here establishes real-world legality.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime

from app.airspace.models import (
    RESTRICTED_CATEGORIES,
    AirspaceZone,
    AltitudeReference,
    DisplayClass,
    DraCategory,
    EvaluationStatus,
    RestrictionType,
    ZoneEvaluation,
)
from app.config import AIRSPACE_VERTICAL_MARGIN_M, TERRAIN_ELEVATION_RANGE_M_AMSL
from app.routing.costs import FlightMode

LIKELIHOOD = {
    DraCategory.RH: "consent is highly likely to be granted",
    DraCategory.RM: "consent has a medium likelihood of being granted",
    DraCategory.RL: "consent has a low likelihood of being granted",
}


@dataclass(frozen=True)
class FlightContext:
    altitude_agl_m: float
    at: datetime
    mode: FlightMode = FlightMode.NORMAL
    # Authorizations/verified capabilities held by the simulated operation.
    # None are modelled yet, so every conditional zone stays unavailable.
    authorizations: frozenset[str] = field(default_factory=frozenset)


def is_active(zone: AirspaceZone, at: datetime) -> bool:
    if zone.validity_start and at < zone.validity_start:
        return False
    if zone.validity_end and at > zone.validity_end:
        return False
    return True


def vertical_overlap(zone: AirspaceZone, low_agl: float, high_agl: float) -> tuple[bool, str | None]:
    """Does the flight band [low_agl, high_agl] (+ margin) meet the zone's band?"""
    lo = zone.lower_altitude if zone.lower_altitude is not None else float("-inf")
    hi = zone.upper_altitude if zone.upper_altitude is not None else float("inf")
    m = AIRSPACE_VERTICAL_MARGIN_M
    if zone.altitude_reference == AltitudeReference.AGL:
        f_lo, f_hi = low_agl - m, high_agl + m
    elif zone.altitude_reference == AltitudeReference.AMSL:
        g_min, g_max = TERRAIN_ELEVATION_RANGE_M_AMSL  # no DEM: use the area's terrain range
        f_lo, f_hi = g_min + low_agl - m, g_max + high_agl + m
    else:
        if zone.lower_altitude is None and zone.upper_altitude is None:
            return True, None
        return True, "Altitude reference unknown: zone assumed to apply at all altitudes."
    return (f_lo <= hi and f_hi >= lo), None


def evaluate(zone: AirspaceZone, ctx: FlightContext, *, endpoint: bool = False) -> ZoneEvaluation:
    """`endpoint=True` evaluates take-off/landing: the drone passes every
    altitude from the ground up to cruise altitude at that location."""
    reasons: list[str] = []
    if not is_active(zone, ctx.at):
        return ZoneEvaluation(
            status=EvaluationStatus.NOT_ACTIVE_TIME,
            display_class=DisplayClass.INACTIVE,
            is_obstacle=False,
            reasons=[f"Not active at {ctx.at:%Y-%m-%d %H:%M} UTC (outside its validity period)."],
        )
    low = 0.0 if endpoint else ctx.altitude_agl_m
    applies, note = vertical_overlap(zone, low, ctx.altitude_agl_m)
    if note:
        reasons.append(note)
    if not applies:
        return ZoneEvaluation(
            status=EvaluationStatus.NOT_APPLICABLE_ALTITUDE,
            display_class=DisplayClass.INACTIVE,
            is_obstacle=False,
            reasons=[f"Flight at {ctx.altitude_agl_m:.0f} m AGL is outside the zone's vertical limits."],
        )
    if not zone.source:
        reasons.append("No source metadata: zone cannot be verified.")
        return ZoneEvaluation(
            status=EvaluationStatus.UNVERIFIED, display_class=DisplayClass.GRAY, is_obstacle=True, reasons=reasons
        )

    cat, rt = zone.dra_category, zone.restriction_type
    if cat == DraCategory.P or rt == RestrictionType.PROHIBITED:
        reasons.append("Prohibited zone (DRA-P): only narrowly defined authorized operations are permitted.")
        return ZoneEvaluation(
            status=EvaluationStatus.BLOCKED, display_class=DisplayClass.RED, is_obstacle=True, reasons=reasons
        )
    if cat in RESTRICTED_CATEGORIES or rt in (RestrictionType.AUTHORIZATION_REQUIRED, RestrictionType.CONDITIONAL):
        if "AUTHORIZATION:" + zone.id in ctx.authorizations:
            reasons.append("Authorization recorded for this simulated operation.")
            return ZoneEvaluation(
                status=EvaluationStatus.INFORMATION, display_class=DisplayClass.ORANGE, is_obstacle=False, reasons=reasons
            )
        detail = f" ({LIKELIHOOD[cat]})" if cat in LIKELIHOOD else ""
        reasons.append(
            f"Restricted zone: consent and conditions are required{detail}. "
            "No authorization is recorded, so it is unavailable for this route."
        )
        return ZoneEvaluation(
            status=EvaluationStatus.UNAVAILABLE_AUTHORIZATION,
            display_class=DisplayClass.ORANGE,
            is_obstacle=True,
            reasons=reasons,
        )
    if cat == DraCategory.T or rt == RestrictionType.TECHNICAL_REQUIREMENTS:
        reasons.append(
            "Technical requirements apply (consent may also be required). "
            "They are not verified for this drone, so the zone is unavailable."
        )
        return ZoneEvaluation(
            status=EvaluationStatus.UNAVAILABLE_TECHNICAL,
            display_class=DisplayClass.YELLOW,
            is_obstacle=True,
            reasons=reasons,
        )
    if cat == DraCategory.U or rt == RestrictionType.USPACE_SERVICES_REQUIRED:
        reasons.append("U-space zone: verified U-space services are required and not available in this simulation.")
        return ZoneEvaluation(
            status=EvaluationStatus.UNAVAILABLE_USPACE,
            display_class=DisplayClass.ORANGE,
            is_obstacle=True,
            reasons=reasons,
        )
    if cat == DraCategory.I or rt == RestrictionType.INFORMATION:
        reasons.append("Information zone: read the operational conditions before flying.")
        return ZoneEvaluation(
            status=EvaluationStatus.INFORMATION, display_class=DisplayClass.YELLOW, is_obstacle=False, reasons=reasons
        )
    reasons.append("Unknown zone category or restriction: treated as blocked until verified.")
    return ZoneEvaluation(
        status=EvaluationStatus.UNVERIFIED, display_class=DisplayClass.GRAY, is_obstacle=True, reasons=reasons
    )
