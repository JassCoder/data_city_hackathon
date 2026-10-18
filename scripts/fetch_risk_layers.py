"""One-off build of the risk raster used by the SAFEST route objective.

Needs data/boundaries/warsaw_city.geojson, data/osm/grid_warsaw_25m.npz and the
building tiles (scripts/fetch_osm.py). Run from the repo root with the backend venv:

    backend/.venv/bin/python scripts/fetch_risk_layers.py

Writes data/osm/risk_warsaw_25m.npz (committed; the backend never calls Overpass)
on exactly the routing grid's cells. It stores facts only; turning them into a
population-density proxy and cost terms happens at runtime from
data/cost_model.json:
  floor_residential_m2  building floor area per cell inside landuse=residential
  floor_other_m2        all other building floor area per cell
  residential           cell centre inside landuse=residential (noise term)
  open_space            emergency landing possible: parks, grass, meadows, fields, pitches
  sensitive             schools, kindergartens, universities, hospitals, stadiums
  transit               public transport stops and stations

Data assumptions (documented, not hidden):
  - Floor area = footprint area x floors, floors = max(1, round(height / 3 m)),
    with the heights already estimated in the building tiles.
  - The tiles carry no building type, so a building counts as residential when
    its area lies inside an OSM landuse=residential polygon.
  - Forests are not open space (unsafe to land); small patches are dropped.
Nothing is written unless every Overpass request succeeds. Tile responses are
cached in scripts/.cache/overpass (gitignored); delete it to force a fresh download.
"""

from __future__ import annotations

import gzip
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import shapely
from shapely.geometry import Point, shape

sys.path.insert(0, str(Path(__file__).resolve().parent))
from fetch_osm import (  # noqa: E402
    BOUNDARY_CITY_FILE,
    BUILDING_TILES_DIR,
    BUILDINGS_INDEX_FILE,
    CITY_GRID_FILE,
    LEVEL_HEIGHT_M,
    element_polygon,
    reproject,
    tiled_query,
)

from app.config import OSM_DIR  # noqa: E402

RISK_FILE = OSM_DIR / "risk_warsaw_25m.npz"
# Per-tile Overpass responses (gitignored): a rerun after an outage resumes instead of starting over.
CACHE_DIR = Path(__file__).resolve().parent / ".cache" / "overpass"
SUBSAMPLES = 4  # 4 x 4 sample points per cell to split footprints across cells
MIN_OPEN_SPACE_M2 = 2000.0  # data filter: ~45 x 45 m, room for an emergency landing

LANDUSE_BODY = """
  way["landuse"="residential"]; relation["landuse"="residential"];
  way["landuse"~"^(grass|meadow|farmland|recreation_ground|village_green|greenfield)$"];
  relation["landuse"~"^(grass|meadow|farmland|recreation_ground|village_green|greenfield)$"];
  way["leisure"~"^(park|pitch|common|golf_course)$"]; relation["leisure"~"^(park|pitch|common|golf_course)$"];
  way["natural"~"^(grassland|heath)$"]; relation["natural"~"^(grassland|heath)$"];
"""
SENSITIVE_BODY = """
  nwr["amenity"~"^(school|kindergarten|college|university|hospital)$"];
  nwr["leisure"="stadium"]; nwr["building"="stadium"];
"""
TRANSIT_BODY = """
  node["highway"="bus_stop"]; node["railway"~"^(tram_stop|station|halt)$"];
  nwr["station"="subway"]; nwr["public_transport"="station"];
"""


class Grid:
    """The routing grid's cell layout, read from its npz meta."""

    def __init__(self, path: Path):
        with np.load(path) as z:
            meta = json.loads(str(z["meta"]))
        self.min_x, self.min_y, self.cell = meta["min_x"], meta["min_y"], meta["cell"]
        self.rows, self.cols = meta["rows"], meta["cols"]

    def zeros(self, dtype):
        return np.zeros((self.rows, self.cols), dtype)

    def window(self, b):
        c = self.cell
        c0 = max(0, int((b[0] - self.min_x) // c)); c1 = min(self.cols, int((b[2] - self.min_x) // c) + 1)
        r0 = max(0, int((b[1] - self.min_y) // c)); r1 = min(self.rows, int((b[3] - self.min_y) // c) + 1)
        return slice(r0, r1), slice(c0, c1)

    def cell_of(self, x, y):
        r, c = int((y - self.min_y) // self.cell), int((x - self.min_x) // self.cell)
        return (r, c) if 0 <= r < self.rows and 0 <= c < self.cols else None

    def mark(self, layer, geom_m):
        """Cells whose centre lies inside geom_m; tiny shapes mark their own cell."""
        rs, cs = self.window(geom_m.bounds)
        if rs.stop > rs.start and cs.stop > cs.start:
            xs = self.min_x + (np.arange(cs.start, cs.stop) + 0.5) * self.cell
            ys = self.min_y + (np.arange(rs.start, rs.stop) + 0.5) * self.cell
            inside = shapely.contains_xy(geom_m, *np.meshgrid(xs, ys))
            if inside.any():
                layer[rs, cs] |= inside
                return
        p = geom_m.representative_point()
        rc = self.cell_of(p.x, p.y)
        if rc:
            layer[rc] = True

    def coverage_fraction(self, geom_m):
        """(window, share of each cell covered by geom_m) from sub-cell samples."""
        rs, cs = self.window(geom_m.bounds)
        n = SUBSAMPLES
        offs = (np.arange(n) + 0.5) / n
        xs = self.min_x + (np.repeat(np.arange(cs.start, cs.stop), n) + np.tile(offs, cs.stop - cs.start)) * self.cell
        ys = self.min_y + (np.repeat(np.arange(rs.start, rs.stop), n) + np.tile(offs, rs.stop - rs.start)) * self.cell
        inside = shapely.contains_xy(geom_m, *np.meshgrid(xs, ys))
        frac = inside.reshape(rs.stop - rs.start, n, cs.stop - cs.start, n).mean(axis=(1, 3))
        return (rs, cs), frac


def element_geometry(el):
    """Polygon for areas, Point for nodes (and unclosed ways), in WGS84."""
    if el["type"] == "node":
        return Point(el["lon"], el["lat"])
    poly = element_polygon(el)
    if poly is not None and not poly.is_empty:
        return poly
    pts = el.get("geometry") or []
    return Point(pts[0]["lon"], pts[0]["lat"]) if pts else None


def floor_area(grid: Grid, residential_m) -> tuple[np.ndarray, np.ndarray, int]:
    """Floor area per cell from the building tiles, split by residential land use."""
    res, other = grid.zeros(np.float32), grid.zeros(np.float32)
    shapely.prepare(residential_m)
    tiles = json.loads(BUILDINGS_INDEX_FILE.read_text(encoding="utf-8"))["tiles"]
    count = 0
    for i, key in enumerate(tiles):
        with gzip.open(BUILDING_TILES_DIR / "14" / f"{key}.json.gz", "rt", encoding="utf-8") as f:
            features = json.load(f)["features"]
        for feat in features:
            geom_m = reproject(shape(feat["geometry"]))
            if geom_m.is_empty or geom_m.area <= 0:
                continue
            floors = max(1, round(feat["properties"]["height_m"] / LEVEL_HEIGHT_M))
            target = res if residential_m.intersects(geom_m.representative_point()) else other
            win, frac = grid.coverage_fraction(geom_m)
            covered = frac.sum()
            if covered > 0:  # split the true footprint area in proportion to sampled coverage
                target[win] += (frac / covered * geom_m.area * floors).astype(np.float32)
            else:
                p = geom_m.representative_point()
                rc = grid.cell_of(p.x, p.y)
                if rc:
                    target[rc] += geom_m.area * floors
            count += 1
        if (i + 1) % 25 == 0:
            print(f"  floor area: {i + 1}/{len(tiles)} tiles, {count:,} buildings", flush=True)
    return res, other, count


def main() -> int:
    for path in (BOUNDARY_CITY_FILE, CITY_GRID_FILE, BUILDINGS_INDEX_FILE):
        if not path.is_file():
            print(f"ERROR: missing {path}; run scripts/fetch_boundaries.py and scripts/fetch_osm.py first",
                  file=sys.stderr)
            return 1
    city = shape(json.loads(BOUNDARY_CITY_FILE.read_text(encoding="utf-8"))["features"][0]["geometry"])
    bounds = city.bounds
    grid = Grid(CITY_GRID_FILE)

    print("Overpass: land use and open space", flush=True)
    landuse = tiled_query(LANDUSE_BODY, "landuse", bounds, CACHE_DIR)
    print("Overpass: sensitive sites", flush=True)
    sensitive_els = tiled_query(SENSITIVE_BODY, "sensitive", bounds, CACHE_DIR)
    print("Overpass: transit stops", flush=True)
    transit_els = tiled_query(TRANSIT_BODY, "transit", bounds, CACHE_DIR)

    residential, open_space = grid.zeros(bool), grid.zeros(bool)
    residential_polys = []
    for el in landuse:
        tags = el.get("tags", {})
        poly = element_polygon(el)
        if poly is None or poly.is_empty:
            continue
        poly_m = reproject(poly)
        if tags.get("landuse") == "residential":
            residential_polys.append(poly_m)
            grid.mark(residential, poly_m)
        elif poly_m.area >= MIN_OPEN_SPACE_M2:
            grid.mark(open_space, poly_m)

    sensitive, transit = grid.zeros(bool), grid.zeros(bool)
    for layer, elements in ((sensitive, sensitive_els), (transit, transit_els)):
        for el in elements:
            geom = element_geometry(el)
            if geom is not None:
                grid.mark(layer, reproject(geom))

    print("Floor area from building tiles", flush=True)
    floor_res, floor_other, buildings = floor_area(grid, shapely.union_all(residential_polys))

    stats = {
        "buildings": buildings,
        "residentialPolygons": len(residential_polys),
        "residentialCells": int(residential.sum()),
        "openSpaceCells": int(open_space.sum()),
        "sensitiveSites": len(sensitive_els),
        "sensitiveCells": int(sensitive.sum()),
        "transitStops": len(transit_els),
        "transitCells": int(transit.sum()),
        "floorResidentialKm2": round(float(floor_res.sum()) / 1e6, 2),
        "floorOtherKm2": round(float(floor_other.sum()) / 1e6, 2),
    }
    meta = {
        "crs": "EPSG:2180", "min_x": grid.min_x, "min_y": grid.min_y, "cell": grid.cell,
        "rows": grid.rows, "cols": grid.cols,
        "source": "OpenStreetMap contributors (ODbL), via Overpass API; floor area from data/osm/tiles",
        "fetched_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "stats": stats,
    }
    np.savez_compressed(RISK_FILE, floor_residential_m2=floor_res, floor_other_m2=floor_other,
                        residential=residential, open_space=open_space, sensitive=sensitive, transit=transit,
                        meta=json.dumps(meta))
    print(f"Wrote {RISK_FILE} ({RISK_FILE.stat().st_size / 1e6:.1f} MB): {json.dumps(stats)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
