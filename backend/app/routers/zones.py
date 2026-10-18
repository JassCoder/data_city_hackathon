from datetime import datetime, timezone
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import JSONResponse
from shapely.geometry import box

from app.airspace.diagnostics import AirspaceDiagnostics, diagnostics
from app.airspace.status import airspace_status
from app.airspace.summary import AirspaceStatusResponse, ZonesSummary, status_report, zones_summary
from app.airspace.evaluation import FlightContext
from app.airspace.models import FlightContextInfo, ZoneResponse, ZonesResponse
from app.airspace.repository import AirspaceRepository
from app.dependencies import get_airspace, get_coverage
from app.geo.bbox import parse_bbox
from app.geo.coverage import Coverage
from app.routing.costs import FlightMode
from app.routing.grid import to_metres
from app.schemas.planning import ALTITUDE_MAX_M, ALTITUDE_MIN_M, ALTITUDE_STEP_M

router = APIRouter(prefix="/zones", tags=["airspace"])

AltitudeQ = Annotated[
    int,
    Query(alias="altitudeM", ge=ALTITUDE_MIN_M, le=ALTITUDE_MAX_M, multiple_of=ALTITUDE_STEP_M,
          description="Planned flight altitude AGL used to evaluate each zone"),
]
AtQ = Annotated[datetime | None, Query(description="Evaluation time (ISO 8601); default now")]
BboxQ = Annotated[
    str | None,
    Query(description="minLon,minLat,maxLon,maxLat (WGS84). Returns every zone whose geometry intersects the box, "
                      "not only zones whose centre lies inside it. Default: the whole dataset (all of Warsaw)."),
]


def _context(altitude: int, at: datetime | None, mode: FlightMode) -> FlightContext:
    when = at or datetime.now(timezone.utc)
    if when.tzinfo is None:
        when = when.replace(tzinfo=timezone.utc)
    return FlightContext(altitude_agl_m=altitude, at=when, mode=mode)


@router.get("", response_model=ZonesResponse,
            summary="Zones (all of Warsaw by default, or those intersecting a bbox), evaluated for a planned flight")
def list_zones(
    airspace: Annotated[AirspaceRepository, Depends(get_airspace)],
    coverage: Annotated[Coverage, Depends(get_coverage)],
    altitude: AltitudeQ = 80,
    at: AtQ = None,
    mode: FlightMode = FlightMode.NORMAL,
    bbox: BboxQ = None,
    format: Annotated[Literal["json", "geojson"], Query(description="geojson: a FeatureCollection")] = "json",
):
    state = airspace.refresh()
    ctx = _context(altitude, at, mode)
    zones = state.evaluated(ctx)
    query_box = parse_bbox(bbox) if bbox else None
    if query_box:
        keep = set(state.zones_touching(to_metres(box(*query_box))))  # STRtree, exact intersects
        zones = [z for i, z in enumerate(zones) if i in keep]
    resp = ZonesResponse(
        source=state.source_info(),
        flight_context=FlightContextInfo(flight_altitude_meters=altitude, at=ctx.at),
        airspace_status=airspace_status(state, coverage),
        total_zones=len(state.zones),
        bbox=list(query_box) if query_box else None,
        zones=zones,
    )
    if format == "json":
        return resp
    body = resp.model_dump(mode="json", by_alias=True)
    features = [
        {"type": "Feature", "id": z["id"], "geometry": z.pop("geojsonGeometry"), "properties": z}
        for z in body.pop("zones")
    ]
    return JSONResponse({"type": "FeatureCollection", "metadata": body, "features": features},
                        media_type="application/geo+json")


@router.get("/diagnostics", response_model=AirspaceDiagnostics,
            summary="Coverage diagnostics: feature counts, completeness and per-district coverage")
def zone_diagnostics(
    airspace: Annotated[AirspaceRepository, Depends(get_airspace)],
    coverage: Annotated[Coverage, Depends(get_coverage)],
    altitude: AltitudeQ = 80,
    at: AtQ = None,
    mode: FlightMode = FlightMode.NORMAL,
) -> AirspaceDiagnostics:
    state = airspace.refresh()
    return diagnostics(state, _context(altitude, at, mode), coverage, airspace.last_error)


@router.get("/summary", response_model=ZonesSummary,
            summary="Dynamic zone counts by DRA category and by status for a planned flight")
def zone_summary(
    airspace: Annotated[AirspaceRepository, Depends(get_airspace)],
    coverage: Annotated[Coverage, Depends(get_coverage)],
    altitude: AltitudeQ = 80,
    at: AtQ = None,
    mode: FlightMode = FlightMode.NORMAL,
) -> ZonesSummary:
    return zones_summary(airspace.refresh(), _context(altitude, at, mode), coverage)


status_router = APIRouter(prefix="/airspace", tags=["airspace"])


@status_router.get("/status", response_model=AirspaceStatusResponse,
                   summary="Airspace data source, official coverage, routing margin and warnings")
def get_airspace_status(
    airspace: Annotated[AirspaceRepository, Depends(get_airspace)],
    coverage: Annotated[Coverage, Depends(get_coverage)],
) -> AirspaceStatusResponse:
    return status_report(airspace.refresh(), coverage, airspace.margin_m)


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
