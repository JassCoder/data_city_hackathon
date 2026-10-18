"""One-off download of OSM data for the whole City of Warsaw.

Needs data/boundaries/warsaw_city.geojson (scripts/fetch_boundaries.py). Run from
the repo root with the backend venv:

    backend/.venv/Scripts/python scripts/fetch_osm.py

Writes (all committed; the backend never calls Overpass):
  data/osm/grid_warsaw_25m.npz   routing raster: max KNOWN building height, unknown-height mask, river, park
  data/osm/tiles/14/x/y.json.gz  building footprints per z14 tile (display at street zoom)
  data/osm/buildings_index.json  tile list + building statistics
  data/corridors.geojson         river + parks/green >= 5000 m² for display
  data/tall_buildings.geojson    buildings >= 50 m (citywide overview layer)

The city is queried in tiles so each Overpass request stays small. Nothing is
written unless every tile succeeds, so a failed run never clobbers the snapshot.
"""

from __future__ import annotations

import gzip
import json
import math
import os
import re
import shutil
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import httpx
import numpy as np
import shapely
from pyproj import Transformer
from shapely.geometry import LineString, Polygon, box, mapping, shape
from shapely.ops import linemerge, polygonize, unary_union

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT / "backend"))
from app.config import (  # noqa: E402
    BOUNDARY_CITY_FILE,
    BUILDING_TILE_ZOOM,
    BUILDING_TILES_DIR,
    BUILDINGS_INDEX_FILE,
    CITY_GRID_FILE,
    DATA_DIR,
    DATA_FILES,
    USER_AGENT,
)
from app.routing.costs import CELL_SIZE_M  # noqa: E402

OVERPASS_ENDPOINTS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
]
TIMEOUT_S = 300
QUERY_TILES = 4  # 4 x 4 Overpass requests per layer
LEVEL_HEIGHT_M = 3.0
MIN_PARK_AREA_M2 = 1000.0  # raster: drop traffic-island grass etc.
MIN_DISPLAY_PARK_AREA_M2 = 5000.0  # display layer only
TALL_BUILDING_M = 50.0
COORD_DECIMALS = 6

_to_m = Transformer.from_crs("EPSG:4326", "EPSG:2180", always_xy=True).transform


def reproject(geom, fn=_to_m):
    return shapely.transform(geom, lambda x, y: fn(x, y), interleaved=False)


class FetchError(RuntimeError):
    pass


# --- Overpass ------------------------------------------------------------------

def overpass(query: str, label: str) -> list[dict]:
    errors = []
    headers = {"User-Agent": USER_AGENT}
    for attempt in range(3):
        for url in OVERPASS_ENDPOINTS:
            try:
                res = httpx.post(url, data={"data": query}, headers=headers, timeout=TIMEOUT_S + 60)
                if res.status_code in (429, 504):
                    raise httpx.HTTPStatusError("busy", request=res.request, response=res)
                res.raise_for_status()
                elements = res.json().get("elements", [])
                print(f"  [{label}] {len(elements)} elements from {url.split('/')[2]}", flush=True)
                return elements
            except (httpx.HTTPError, ValueError) as exc:
                errors.append(f"{url}: {type(exc).__name__}: {exc}")
        time.sleep(15 * (attempt + 1))
    raise FetchError(f"All Overpass endpoints failed for {label}:\n  " + "\n  ".join(errors[-3:]))


def tiled_query(body: str, label: str, bounds) -> list[dict]:
    w, s, e, n = bounds
    seen: dict[tuple[str, int], dict] = {}
    for i in range(QUERY_TILES):
        for j in range(QUERY_TILES):
            ts, tn = s + (n - s) * i / QUERY_TILES, s + (n - s) * (i + 1) / QUERY_TILES
            tw, te = w + (e - w) * j / QUERY_TILES, w + (e - w) * (j + 1) / QUERY_TILES
            q = f"[out:json][timeout:{TIMEOUT_S}][bbox:{ts:.5f},{tw:.5f},{tn:.5f},{te:.5f}];\n({body});\nout geom;"
            for el in overpass(q, f"{label} {i * QUERY_TILES + j + 1}/{QUERY_TILES ** 2}"):
                seen[(el["type"], el["id"])] = el
            time.sleep(2)
    return list(seen.values())


BUILDINGS_BODY = 'way["building"]["building"!="no"]; relation["building"]["building"!="no"]["type"="multipolygon"];'
CORRIDORS_BODY = """
  way["natural"="water"]["water"="river"]; relation["natural"="water"]["water"="river"];
  way["waterway"="riverbank"]; relation["waterway"="riverbank"];
  way["leisure"="park"]; relation["leisure"="park"];
  way["landuse"~"^(forest|grass)$"]; relation["landuse"~"^(forest|grass)$"];
  way["natural"="wood"]; relation["natural"="wood"];
"""


# --- geometry ------------------------------------------------------------------

def _coords(way_geom):
    return [(p["lon"], p["lat"]) for p in way_geom]


def element_polygon(el: dict):
    if el["type"] == "way":
        pts = _coords(el.get("geometry", []))
        if len(pts) < 4 or pts[0] != pts[-1]:
            return None
        poly = Polygon(pts)
        return poly if poly.is_valid else poly.buffer(0)
    if el["type"] == "relation":
        outer, inner = [], []
        for m in el.get("members", []):
            if m.get("type") != "way" or "geometry" not in m:
                continue
            (inner if m.get("role") == "inner" else outer).append(LineString(_coords(m["geometry"])))
        if not outer:
            return None
        shell = unary_union(list(polygonize(linemerge(outer))))
        if shell.is_empty:
            return None
        if inner:
            shell = shell.difference(unary_union(list(polygonize(linemerge(inner)))))
        return shell if shell.is_valid else shell.buffer(0)
    return None


def round_coords(obj, nd=COORD_DECIMALS):
    if isinstance(obj, (list, tuple)):
        if obj and isinstance(obj[0], (int, float)):
            return [round(v, nd) for v in obj]
        return [round_coords(v, nd) for v in obj]
    return obj


def feature(geom, props: dict) -> dict | None:
    """GeoJSON feature with rounded coordinates; rounding/simplifying can break
    validity, so the result is re-validated (None if nothing valid remains)."""
    g = mapping(geom)
    rounded = shape({"type": g["type"], "coordinates": round_coords(g["coordinates"])})
    if not rounded.is_valid:
        rounded = shapely.make_valid(rounded)
        polys = [p for p in getattr(rounded, "geoms", [rounded]) if p.geom_type in ("Polygon", "MultiPolygon")]
        if not polys:
            return None
        rounded = unary_union(polys)
    if rounded.is_empty:
        return None
    g = mapping(rounded)
    return {"type": "Feature", "properties": props, "geometry": {"type": g["type"], "coordinates": round_coords(g["coordinates"])}}


_NUM = re.compile(r"-?\d+(?:[.,]\d+)?")


def _parse_number(raw):
    if not raw:
        return None
    m = _NUM.search(raw)
    if not m:
        return None
    val = float(m.group().replace(",", "."))
    if "'" in raw or "ft" in raw.lower():
        val *= 0.3048
    return val if val > 0 else None


def building_height(tags: dict) -> tuple[float | None, str]:
    """Height from OSM `height`, else estimated from `building:levels` x 3 m.
    Without either the height is UNKNOWN (None): it is never invented here. How
    routing treats unknown heights is a configured policy (app/config.py)."""
    h = _parse_number(tags.get("height"))
    if h is not None:
        return round(h, 1), "osm_height"
    levels = _parse_number(tags.get("building:levels"))
    if levels is not None:
        return round(levels * LEVEL_HEIGHT_M, 1), "levels_x3"
    return None, "unknown"


def tile_of(lon: float, lat: float, z: int) -> tuple[int, int]:
    n = 2 ** z
    x = int((lon + 180.0) / 360.0 * n)
    y = int((1.0 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2.0 * n)
    return x, y


# --- raster --------------------------------------------------------------------

class Raster:
    def __init__(self, city_m):
        minx, miny, maxx, maxy = city_m.bounds
        c = CELL_SIZE_M
        self.min_x, self.min_y = math.floor(minx / c) * c, math.floor(miny / c) * c
        self.cols = math.ceil((maxx - self.min_x) / c)
        self.rows = math.ceil((maxy - self.min_y) / c)
        self.height = np.zeros((self.rows, self.cols), np.float32)  # known heights only
        self.unknown = np.zeros((self.rows, self.cols), bool)  # covered by a building of unknown height
        self.river = np.zeros((self.rows, self.cols), bool)
        self.park = np.zeros((self.rows, self.cols), bool)

    def window(self, b):
        c = CELL_SIZE_M
        c0 = max(0, math.floor((b[0] - self.min_x) / c)); c1 = min(self.cols, math.ceil((b[2] - self.min_x) / c))
        r0 = max(0, math.floor((b[1] - self.min_y) / c)); r1 = min(self.rows, math.ceil((b[3] - self.min_y) / c))
        return slice(r0, r1), slice(c0, c1)

    def centres_inside(self, geom_m):
        rs, cs = self.window(geom_m.bounds)
        xs = self.min_x + (np.arange(cs.start, cs.stop) + 0.5) * CELL_SIZE_M
        ys = self.min_y + (np.arange(rs.start, rs.stop) + 0.5) * CELL_SIZE_M
        gx, gy = np.meshgrid(xs, ys)
        return (rs, cs), shapely.contains_xy(geom_m, gx, gy)

    def add_building(self, geom_m, h: float | None):
        win, inside = self.centres_inside(geom_m)
        if inside.any():
            if h is None:
                self.unknown[win] |= inside
            else:
                self.height[win] = np.where(inside, np.maximum(self.height[win], h), self.height[win])
        else:  # small footprint: mark the cell of its representative point
            p = geom_m.representative_point()
            c, r = int((p.x - self.min_x) // CELL_SIZE_M), int((p.y - self.min_y) // CELL_SIZE_M)
            if 0 <= r < self.rows and 0 <= c < self.cols:
                if h is None:
                    self.unknown[r, c] = True
                else:
                    self.height[r, c] = max(self.height[r, c], h)

    def add_area(self, geom_m, layer):
        win, inside = self.centres_inside(geom_m)
        layer[win] |= inside


# --- main ----------------------------------------------------------------------

def main() -> int:
    if not BOUNDARY_CITY_FILE.is_file():
        print("ERROR: run scripts/fetch_boundaries.py first", file=sys.stderr)
        return 1
    city = shape(json.loads(BOUNDARY_CITY_FILE.read_text(encoding="utf-8"))["features"][0]["geometry"])
    city_m = reproject(city)
    shapely.prepare(city)
    bounds = city.bounds
    t0 = time.time()
    try:
        print("Buildings:")
        b_elements = tiled_query(BUILDINGS_BODY, "buildings", bounds)
        print("Corridors:")
        c_elements = tiled_query(CORRIDORS_BODY, "corridors", bounds)
    except FetchError as exc:
        print(f"\nERROR: {exc}\nExisting files were left untouched.", file=sys.stderr)
        return 1
    print(f"downloaded in {time.time() - t0:.0f}s; processing...", flush=True)

    raster = Raster(city_m)
    tiles: dict[tuple[int, int], list[dict]] = {}
    tall, sources, n_buildings = [], {}, 0
    for el in b_elements:
        geom = element_polygon(el)
        if geom is None or geom.is_empty:
            continue
        rp = geom.representative_point()
        if not city.contains(rp):
            continue
        h, src = building_height(el.get("tags", {}))
        n_buildings += 1
        sources[src] = sources.get(src, 0) + 1
        raster.add_building(reproject(geom), h)
        f = feature(geom, {"id": f"osm_{el['type']}_{el['id']}", "height_m": h, "height_source": src})
        if f is None:
            continue
        tiles.setdefault(tile_of(rp.x, rp.y, BUILDING_TILE_ZOOM), []).append(f)
        if h is not None and h >= TALL_BUILDING_M:
            tall.append(f)

    river_polys, display = [], []
    for el in c_elements:
        tags = el.get("tags", {})
        geom = element_polygon(el)
        if geom is None or geom.is_empty or not geom.intersects(city):
            continue
        geom = geom.intersection(city)
        if geom.is_empty or geom.geom_type not in ("Polygon", "MultiPolygon"):
            continue
        is_river = tags.get("waterway") == "riverbank" or (tags.get("natural") == "water" and tags.get("water") == "river")
        if is_river:
            river_polys.append(geom)
            continue
        geom_m = reproject(geom)
        area = geom_m.area
        if area < MIN_PARK_AREA_M2:
            continue
        raster.add_area(geom_m, raster.park)
        if area >= MIN_DISPLAY_PARK_AREA_M2:
            display.append(feature(geom.simplify(0.00002, preserve_topology=True), {
                "id": f"osm_{el['type']}_{el['id']}", "name": tags.get("name"), "corridor_type": "PARK",
                "osm_tag": next((f"{k}={tags[k]}" for k in ("leisure", "landuse", "natural") if k in tags), None),
            }))
    if not river_polys or n_buildings < 50000:
        print(f"ERROR: implausible result (river parts {len(river_polys)}, buildings {n_buildings}); nothing written.",
              file=sys.stderr)
        return 1
    river = unary_union(river_polys)
    raster.add_area(reproject(river), raster.river)
    display.insert(0, feature(river, {"id": "vistula", "name": "Wisła (Vistula) and river water", "corridor_type": "RIVER",
                                      "geometry_source": "osm_riverbank"}))

    # --- write (temp dir, then swap) ---
    fetched = datetime.now(timezone.utc).isoformat(timespec="seconds")
    stats = {"buildings": n_buildings, "tallBuildings": len(tall), "unknownHeights": sources.get("unknown", 0),
             "heightSources": sources, "parks": len(display) - 1, "tiles": len(tiles)}
    meta = {"source": "OpenStreetMap contributors (ODbL), via Overpass API", "fetched_at": fetched,
            "coverage": "City of Warsaw (GUGiK PRG boundary, TERYT 1465)"}
    tmp_tiles = BUILDING_TILES_DIR.with_name("tiles.tmp")
    shutil.rmtree(tmp_tiles, ignore_errors=True)
    for (x, y), feats in tiles.items():
        d = tmp_tiles / str(BUILDING_TILE_ZOOM) / str(x)
        d.mkdir(parents=True, exist_ok=True)
        (d / f"{y}.json.gz").write_bytes(gzip.compress(json.dumps(
            {"type": "FeatureCollection", "features": feats}, separators=(",", ":")).encode("utf-8"), 6))
    shutil.rmtree(BUILDING_TILES_DIR, ignore_errors=True)
    os.replace(tmp_tiles, BUILDING_TILES_DIR)

    CITY_GRID_FILE.parent.mkdir(parents=True, exist_ok=True)
    grid_meta = {"crs": "EPSG:2180", "min_x": raster.min_x, "min_y": raster.min_y, "cell": CELL_SIZE_M,
                 "rows": raster.rows, "cols": raster.cols, **meta, "stats": stats}
    np.savez_compressed(CITY_GRID_FILE, building_height=raster.height, building_unknown=raster.unknown,
                        river=raster.river, park=raster.park,
                        meta=np.array(json.dumps(grid_meta)))
    BUILDINGS_INDEX_FILE.write_text(json.dumps({**meta, "zoom": BUILDING_TILE_ZOOM, "stats": stats,
                                                "tiles": sorted(f"{x}/{y}" for x, y in tiles)}), encoding="utf-8")
    display = [f for f in display if f is not None]
    for path, layer, feats in ((DATA_DIR / DATA_FILES["corridors"], "corridors", display),
                               (DATA_DIR / "tall_buildings.geojson", "tall_buildings", tall)):
        path.write_text(json.dumps({"type": "FeatureCollection", "metadata": {"layer": layer, **meta}, "features": feats},
                                   ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    old = DATA_DIR / "buildings.geojson"
    if old.exists():
        old.unlink()  # replaced by the citywide tiles
    print(f"\nbuildings: {n_buildings} ({len(tall)} >= {TALL_BUILDING_M:.0f} m), sources {sources}, {len(tiles)} tiles")
    print(f"raster: {raster.rows} x {raster.cols} cells of {CELL_SIZE_M:.0f} m; river cells {int(raster.river.sum())}, "
          f"park cells {int(raster.park.sum())}")
    print(f"corridors.geojson: {len(display) - 1} parks/green (>= {MIN_DISPLAY_PARK_AREA_M2:.0f} m²) + river; "
          f"done in {time.time() - t0:.0f}s")
    return 0


if __name__ == "__main__":
    sys.exit(main())
