"""Citywide geographic context layers (GeoJSON): building footprints and airports.

Contextual data only: neither layer is a legal drone restriction.
"""

from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException, Query

from app.config import UNKNOWN_BUILDING_POLICY
from app.dependencies import get_airports, get_planner
from app.geo.airports import AirportData
from app.geo.bbox import parse_bbox
from app.geo.buildings import BboxTooLarge, buildings_in_bbox
from app.routing.planner import RoutePlanner

router = APIRouter(tags=["geodata"])

BboxQ = Annotated[str, Query(description="minLon,minLat,maxLon,maxLat (WGS84)")]


@router.get("/buildings", summary="OSM building footprints intersecting a bbox (GeoJSON, heights as mapped)")
def buildings(bbox: BboxQ, planner: Annotated[RoutePlanner, Depends(get_planner)]) -> dict[str, Any]:
    box_ = parse_bbox(bbox)
    try:
        features = buildings_in_bbox(box_)
    except BboxTooLarge as exc:
        raise HTTPException(422, str(exc)) from exc
    meta = planner.grid.meta or {}
    unknown = sum(1 for f in features if f["properties"]["height_m"] is None)
    return {
        "type": "FeatureCollection",
        "metadata": {
            "source": meta.get("source"),
            "fetchedAt": meta.get("fetched_at"),
            "bbox": list(box_),
            "count": len(features),
            "unknownHeights": unknown,
            "heightNote": "height_m is null when OSM has no height or level count (height_source 'unknown'); "
                          "levels_x3 = building:levels x 3 m (estimate).",
            "routingPolicyForUnknownHeights": planner.grid.unknown_policy.label if planner.grid.unknown_policy
            else UNKNOWN_BUILDING_POLICY,
        },
        "features": features,
    }


@router.get("/airports", summary="Airport locations and mapped boundaries (informative, not drone zones)")
def airports(airports: Annotated[AirportData, Depends(get_airports)],
             bbox: Annotated[str | None, Query(description="minLon,minLat,maxLon,maxLat (optional)")] = None) -> dict[str, Any]:
    if not airports.available:
        raise HTTPException(503, airports.message)
    return airports.feature_collection(parse_bbox(bbox) if bbox else None)
