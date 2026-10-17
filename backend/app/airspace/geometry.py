from __future__ import annotations

import numpy as np
from pyproj import Geod
from shapely.geometry import Polygon, mapping, shape
from shapely.geometry.base import BaseGeometry

from app.config import AIRSPACE_CIRCLE_SEGMENTS

_GEOD = Geod(ellps="WGS84")


def geodesic_circle(lon: float, lat: float, radius_m: float, segments: int = AIRSPACE_CIRCLE_SEGMENTS) -> Polygon:
    """Polygon whose vertices lie exactly `radius_m` (geodesic) from the centre."""
    az = np.linspace(0.0, 360.0, segments, endpoint=False)
    lons, lats, _ = _GEOD.fwd(np.full(segments, lon), np.full(segments, lat), az, np.full(segments, radius_m))
    return Polygon(zip(lons, lats))


def geodesic_distance_m(lon1: float, lat1: float, lon2: float, lat2: float) -> float:
    return float(_GEOD.inv(lon1, lat1, lon2, lat2)[2])


def as_area(geojson: dict) -> BaseGeometry:
    geom = shape(geojson)
    if geom.geom_type not in ("Polygon", "MultiPolygon"):
        raise ValueError(f"expected Polygon or MultiPolygon, got {geom.geom_type}")
    if geom.is_empty:
        raise ValueError("empty geometry")
    return geom if geom.is_valid else geom.buffer(0)


def to_geojson(geom: BaseGeometry, decimals: int = 7) -> dict:
    def rnd(c):
        if c and isinstance(c[0], (int, float)):
            return [round(v, decimals) for v in c]
        return [rnd(v) for v in c]

    g = mapping(geom)
    return {"type": g["type"], "coordinates": rnd(g["coordinates"])}
