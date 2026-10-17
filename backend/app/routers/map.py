from functools import lru_cache
from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException, Path, Request, Response

from app.config import (
    BUILDING_TILE_ZOOM,
    BUILDING_TILES_DIR,
    FALLBACK_VIEW,
    ROUTE_MAX_EXPANSIONS,
    ROUTE_MAX_FINE_CELLS,
    ROUTE_TIME_LIMIT_S,
)
from app.dependencies import get_coverage, get_planner
from app.geo.coverage import Coverage, geometry_geojson
from app.routing.planner import RoutePlanner

router = APIRouter(prefix="/map", tags=["map"])


@router.get("/warsaw-boundary", summary="Official City of Warsaw boundary and its 18 districts (GeoJSON)")
def warsaw_boundary(coverage: Annotated[Coverage, Depends(get_coverage)]) -> dict[str, Any]:
    if not coverage.available:
        raise HTTPException(503, coverage.message)
    return {
        "city": coverage.raw_city["features"][0],
        "districts": coverage.raw_districts or {"type": "FeatureCollection", "features": []},
        "bounds": coverage.bounds,  # [minLon, minLat, maxLon, maxLat]
        "source": coverage.source,
    }


@router.get("/coverage", summary="Supported routing coverage: geometry, source, status and limits")
def coverage_info(
    coverage: Annotated[Coverage, Depends(get_coverage)],
    planner: Annotated[RoutePlanner, Depends(get_planner)],
) -> dict[str, Any]:
    state = planner.airspace.state
    g = planner.grid
    return {
        "status": "AVAILABLE" if coverage.available else "MISSING",
        "message": coverage.message,
        "area": coverage.label,
        "geometry": geometry_geojson(coverage.geom),
        "bounds": coverage.bounds,
        "districts": [d.name for d in coverage.districts],
        "source": coverage.source,
        "fallbackView": None if coverage.available else FALLBACK_VIEW,
        "routing": {
            "cellSizeM": g.cell,
            "gridCells": g.rows * g.cols,
            "maxFineCells": ROUTE_MAX_FINE_CELLS,
            "maxExpansions": ROUTE_MAX_EXPANSIONS,
            "timeLimitS": ROUTE_TIME_LIMIT_S,
            "buildingData": g.meta.get("source"),
            "buildingDataFetchedAt": g.meta.get("fetched_at"),
        },
        "airspace": {
            "label": state.dataset.label,
            "sourceType": state.dataset.source_type,
            "extent": geometry_geojson(state.dataset.extent),
            "extentLabel": state.dataset.extent_label,
        },
    }


@lru_cache(maxsize=512)
def _tile_bytes(z: int, x: int, y: int) -> bytes | None:
    path = BUILDING_TILES_DIR / str(z) / str(x) / f"{y}.json.gz"
    return path.read_bytes() if path.is_file() else None


_EMPTY = b'{"type":"FeatureCollection","features":[]}'


@router.get("/buildings/{z}/{x}/{y}", summary="Building footprints for one web-mercator tile (display only)")
def building_tile(
    request: Request,
    z: Annotated[int, Path(ge=BUILDING_TILE_ZOOM, le=BUILDING_TILE_ZOOM)],
    x: Annotated[int, Path(ge=0)],
    y: Annotated[int, Path(ge=0)],
) -> Response:
    data = _tile_bytes(z, x, y)
    headers = {"Cache-Control": "public, max-age=86400"}
    if data is None:  # tile outside Warsaw or without buildings
        return Response(_EMPTY, media_type="application/json", headers=headers)
    if "gzip" in request.headers.get("accept-encoding", ""):
        return Response(data, media_type="application/json", headers={**headers, "Content-Encoding": "gzip"})
    import gzip

    return Response(gzip.decompress(data), media_type="application/json", headers=headers)
