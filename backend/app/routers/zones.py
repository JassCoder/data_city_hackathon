from datetime import datetime, timezone
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query

from app.airspace.evaluation import FlightContext
from app.airspace.models import FlightContextInfo, ZoneResponse, ZonesResponse
from app.airspace.repository import AirspaceRepository
from app.dependencies import get_airspace
from app.routing.costs import FlightMode
from app.schemas.planning import ALTITUDE_MAX_M, ALTITUDE_MIN_M, ALTITUDE_STEP_M

router = APIRouter(prefix="/zones", tags=["airspace"])

AltitudeQ = Annotated[
    int,
    Query(alias="altitudeM", ge=ALTITUDE_MIN_M, le=ALTITUDE_MAX_M, multiple_of=ALTITUDE_STEP_M,
          description="Planned flight altitude AGL used to evaluate each zone"),
]
AtQ = Annotated[datetime | None, Query(description="Evaluation time (ISO 8601); default now")]


def _context(altitude: int, at: datetime | None, mode: FlightMode) -> FlightContext:
    when = at or datetime.now(timezone.utc)
    if when.tzinfo is None:
        when = when.replace(tzinfo=timezone.utc)
    return FlightContext(altitude_agl_m=altitude, at=when, mode=mode)


@router.get("", response_model=ZonesResponse, summary="All loaded zones, evaluated for a planned flight")
def list_zones(
    airspace: Annotated[AirspaceRepository, Depends(get_airspace)],
    altitude: AltitudeQ = 80,
    at: AtQ = None,
    mode: FlightMode = FlightMode.NORMAL,
) -> ZonesResponse:
    state = airspace.refresh()
    ctx = _context(altitude, at, mode)
    return ZonesResponse(
        source=state.source_info(),
        flight_context=FlightContextInfo(flight_altitude_meters=altitude, at=ctx.at),
        zones=state.evaluated(ctx),
    )


@router.get("/{zone_id}", response_model=ZoneResponse, summary="One zone, evaluated for a planned flight")
def get_zone(
    zone_id: str,
    airspace: Annotated[AirspaceRepository, Depends(get_airspace)],
    altitude: AltitudeQ = 80,
    at: AtQ = None,
    mode: FlightMode = FlightMode.NORMAL,
) -> ZoneResponse:
    state = airspace.refresh()
    ctx = _context(altitude, at, mode)
    for z in state.evaluated(ctx):
        if z.id == zone_id:
            return ZoneResponse(
                source=state.source_info(),
                flight_context=FlightContextInfo(flight_altitude_meters=altitude, at=ctx.at),
                zone=z,
            )
    raise HTTPException(404, f"Zone '{zone_id}' not found in the loaded airspace dataset.")
