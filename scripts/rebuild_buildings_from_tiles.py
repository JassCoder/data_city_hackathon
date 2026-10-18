"""Rebuilds the building layers of the routing raster from the cached building
tiles, without downloading anything (the river/park layers are kept).

    backend/.venv/Scripts/python scripts/rebuild_buildings_from_tiles.py

Used to migrate a snapshot written before unknown heights were kept unknown:
footprints tagged `default_15m` (no OSM height or levels) become
`height_m: null, height_source: "unknown"`, and the raster gets a separate
`building_unknown` mask instead of an invented 15 m height. Routing applies the
configured unknown-height policy at load time (SKYROUTE_UNKNOWN_BUILDING_POLICY).
"""

from __future__ import annotations

import gzip
import json
import sys
import time
from pathlib import Path

import numpy as np
from shapely.geometry import shape

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT / "scripts"))
sys.path.insert(0, str(REPO_ROOT / "backend"))
from fetch_osm import Raster, reproject  # noqa: E402

from app.config import BOUNDARY_CITY_FILE, BUILDING_TILES_DIR, BUILDINGS_INDEX_FILE, CITY_GRID_FILE  # noqa: E402

LEGACY_DEFAULT = "default_15m"


def main() -> int:
    t0 = time.time()
    city = shape(json.loads(BOUNDARY_CITY_FILE.read_text(encoding="utf-8"))["features"][0]["geometry"])
    raster = Raster(reproject(city))
    with np.load(CITY_GRID_FILE) as z:
        meta = json.loads(str(z["meta"]))
        river, park = z["river"], z["park"]
    if (raster.rows, raster.cols, raster.min_x, raster.min_y) != (meta["rows"], meta["cols"], meta["min_x"], meta["min_y"]):
        print("ERROR: raster geometry differs from the existing grid; run scripts/fetch_osm.py instead.", file=sys.stderr)
        return 1

    sources: dict[str, int] = {}
    tiles = sorted(BUILDING_TILES_DIR.glob("*/*/*.json.gz"))
    rewritten = {}
    for path in tiles:
        doc = json.loads(gzip.decompress(path.read_bytes()))
        for f in doc["features"]:
            p = f["properties"]
            if p["height_source"] == LEGACY_DEFAULT:
                p["height_m"], p["height_source"] = None, "unknown"
            sources[p["height_source"]] = sources.get(p["height_source"], 0) + 1
            raster.add_building(reproject(shape(f["geometry"])), p["height_m"])
        rewritten[path] = doc

    n = sum(sources.values())
    if n < 50000:
        print(f"ERROR: only {n} buildings in the tiles; nothing written.", file=sys.stderr)
        return 1
    for path, doc in rewritten.items():
        path.write_bytes(gzip.compress(json.dumps(doc, separators=(",", ":")).encode("utf-8"), 6))

    stats = dict(meta["stats"])
    stats.pop("estimatedHeights", None)
    stats.update({"buildings": n, "unknownHeights": sources.get("unknown", 0), "heightSources": sources})
    meta["stats"] = stats
    np.savez_compressed(CITY_GRID_FILE, building_height=raster.height, building_unknown=raster.unknown,
                        river=river, park=park, meta=np.array(json.dumps(meta)))
    index = json.loads(BUILDINGS_INDEX_FILE.read_text(encoding="utf-8"))
    index["stats"] = stats
    BUILDINGS_INDEX_FILE.write_text(json.dumps(index), encoding="utf-8")
    print(f"rebuilt from {len(tiles)} tiles: {n} buildings, sources {sources}; "
          f"unknown-height cells {int(raster.unknown.sum())}; {time.time() - t0:.0f}s")
    return 0


if __name__ == "__main__":
    sys.exit(main())
