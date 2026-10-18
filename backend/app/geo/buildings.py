"""Building footprints for a bounding box, read from the cached z14 tiles
(data/osm/tiles, written by scripts/fetch_osm.py).

Heights are as mapped: `height_m` is null when OSM has neither a height nor a
level count (`height_source: "unknown"`). The routing raster treats those with
the configured unknown-height policy; this endpoint never fills them in.
"""

from __future__ import annotations

import gzip
import json
import math
from functools import lru_cache
from pathlib import Path
from typing import Any

from shapely.geometry import box, shape

from app.config import BUILDING_TILE_ZOOM, BUILDING_TILES_DIR, BUILDINGS_MAX_QUERY_KM2
from app.routing.grid import to_metres


class BboxTooLarge(ValueError):
    pass


def tile_of(lon: float, lat: float, z: int = BUILDING_TILE_ZOOM) -> tuple[int, int]:
    n = 2 ** z
    x = int((lon + 180.0) / 360.0 * n)
    y = int((1.0 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2.0 * n)
    return x, y


@lru_cache(maxsize=64)
def _tile(path: Path) -> tuple[dict, ...]:
    if not path.is_file():
        return ()
    return tuple(json.loads(gzip.decompress(path.read_bytes()))["features"])


def buildings_in_bbox(bbox: tuple[float, float, float, float], tiles_dir: Path = BUILDING_TILES_DIR,
                      max_km2: float = BUILDINGS_MAX_QUERY_KM2) -> list[dict[str, Any]]:
    """Every footprint whose geometry intersects the bbox (not just those centred in it)."""
    area_km2 = to_metres(box(*bbox)).area / 1e6
    if area_km2 > max_km2:
        raise BboxTooLarge(f"bbox covers {area_km2:.1f} km²; the limit is {max_km2:g} km² "
                           f"(use the tiles at /map/buildings/{BUILDING_TILE_ZOOM}/{{x}}/{{y}} for larger areas).")
    q = box(*bbox)
    x0, y1 = tile_of(bbox[0], bbox[1])  # south-west -> larger y
    x1, y0 = tile_of(bbox[2], bbox[3])
    out = []
    # Footprints are filed under the tile of their representative point, so look one tile further out.
    for x in range(x0 - 1, x1 + 2):
        for y in range(y0 - 1, y1 + 2):
            for f in _tile(tiles_dir / str(BUILDING_TILE_ZOOM) / str(x) / f"{y}.json.gz"):
                if shape(f["geometry"]).intersects(q):
                    out.append(f)
    return out
