"""Metric routing grid (EPSG:2180) for the whole City of Warsaw.

Production loads a raster precomputed by scripts/fetch_osm.py (25 m cells,
~1.4 M cells covering the city): max building height, river and park masks.
The coverage mask (cell centre inside the official city polygon) is computed
at startup from the boundary. Airspace zones are evaluated per flight
(app/airspace). Routing searches a window of this grid (see planner.py).

Arrays are indexed [row, col], where row 0 is the southern edge (y grows north)
and col 0 the western edge.
"""

from __future__ import annotations

import json
import math
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
import shapely
from pyproj import Transformer
from shapely.geometry.base import BaseGeometry

from app.config import UNKNOWN_BUILDING_POLICY
from app.routing.costs import CELL_SIZE_M

_to_m = Transformer.from_crs("EPSG:4326", "EPSG:2180", always_xy=True).transform
_to_deg = Transformer.from_crs("EPSG:2180", "EPSG:4326", always_xy=True).transform


def to_metres(geom: BaseGeometry) -> BaseGeometry:
    return shapely.transform(geom, lambda x, y: _to_m(x, y), interleaved=False)


def lonlat_to_xy(lon: float, lat: float) -> tuple[float, float]:
    return _to_m(lon, lat)


def xy_to_lonlat(xs, ys):
    return _to_deg(xs, ys)


class GridLoadError(RuntimeError):
    pass


@dataclass
class Grid:
    min_x: float
    min_y: float
    cell: float
    rows: int
    cols: int
    coverage: np.ndarray  # bool: cell centre inside the routing coverage polygon
    river: np.ndarray  # bool
    park: np.ndarray  # bool
    building_height: np.ndarray  # float metres used for routing, 0 = no building (unknown-height policy applied)
    meta: dict = field(default_factory=dict)
    # Cells covered by a building of unknown height (None for synthetic test grids).
    unknown_height: np.ndarray | None = None
    unknown_policy: "UnknownHeightPolicy | None" = None

    # --- coordinates -----------------------------------------------------------
    def cell_of(self, x: float, y: float) -> tuple[int, int] | None:
        col = math.floor((x - self.min_x) / self.cell)
        row = math.floor((y - self.min_y) / self.cell)
        if 0 <= row < self.rows and 0 <= col < self.cols:
            return row, col
        return None

    def centre(self, row: float, col: float) -> tuple[float, float]:
        return self.min_x + (col + 0.5) * self.cell, self.min_y + (row + 0.5) * self.cell

    def window(self, bounds: tuple[float, float, float, float]) -> tuple[slice, slice]:
        minx, miny, maxx, maxy = bounds
        c0 = max(0, math.floor((minx - self.min_x) / self.cell))
        c1 = min(self.cols, math.ceil((maxx - self.min_x) / self.cell))
        r0 = max(0, math.floor((miny - self.min_y) / self.cell))
        r1 = min(self.rows, math.ceil((maxy - self.min_y) / self.cell))
        return slice(r0, r1), slice(c0, c1)

    def centres_in(self, win: tuple[slice, slice]) -> tuple[np.ndarray, np.ndarray]:
        rs, cs = win
        xs = self.min_x + (np.arange(cs.start, cs.stop) + 0.5) * self.cell
        ys = self.min_y + (np.arange(rs.start, rs.stop) + 0.5) * self.cell
        return np.meshgrid(xs, ys)


def empty_grid(min_x: float, min_y: float, rows: int, cols: int, cell: float = CELL_SIZE_M) -> Grid:
    return Grid(
        min_x=min_x, min_y=min_y, cell=cell, rows=rows, cols=cols,
        coverage=np.ones((rows, cols), bool),
        river=np.zeros((rows, cols), bool),
        park=np.zeros((rows, cols), bool),
        building_height=np.zeros((rows, cols), np.float32),
    )


def _centres_inside(grid: Grid, geom_m: BaseGeometry) -> tuple[tuple[slice, slice], np.ndarray]:
    win = grid.window(geom_m.bounds)
    xs, ys = grid.centres_in(win)
    return win, shapely.contains_xy(geom_m, xs, ys)


def cells_intersecting(grid: Grid, geom_m: BaseGeometry) -> tuple[tuple[slice, slice], np.ndarray]:
    """Conservative: any cell touching the polygon (used for airspace zones)."""
    win = grid.window(geom_m.bounds)
    rs, cs = win
    cc, rr = np.meshgrid(np.arange(cs.start, cs.stop), np.arange(rs.start, rs.stop))
    x0 = grid.min_x + cc * grid.cell
    y0 = grid.min_y + rr * grid.cell
    boxes = shapely.box(x0, y0, x0 + grid.cell, y0 + grid.cell)
    shapely.prepare(geom_m)
    return win, shapely.intersects(geom_m, boxes)


def coverage_mask(grid: Grid, area_wgs84: BaseGeometry) -> np.ndarray:
    area_m = to_metres(area_wgs84)
    shapely.prepare(area_m)
    mask = np.zeros((grid.rows, grid.cols), bool)
    win = grid.window(area_m.bounds)
    xs, ys = grid.centres_in(win)
    mask[win] = shapely.contains_xy(area_m, xs, ys)
    return mask


@dataclass(frozen=True)
class UnknownHeightPolicy:
    """How routing treats buildings whose height is unknown (see config.UNKNOWN_BUILDING_POLICY)."""

    mode: str  # "assume" | "block"
    height_m: float | None = None

    @classmethod
    def parse(cls, value: str) -> "UnknownHeightPolicy":
        v = value.strip().lower()
        if v == "block":
            return cls("block")
        if v.startswith("assume:"):
            try:
                h = float(v.split(":", 1)[1])
            except ValueError:
                h = -1
            if h > 0:
                return cls("assume", h)
        raise GridLoadError(f"Invalid unknown-building policy '{value}' (use 'assume:<metres>' or 'block').")

    @property
    def label(self) -> str:
        if self.mode == "block":
            return "Buildings of unknown height block every flight altitude (policy 'block')."
        return (f"Buildings of unknown height are treated as obstacles up to {self.height_m:g} m "
                f"(policy 'assume:{self.height_m:g}'; an assumption, not data).")

    def apply(self, heights: np.ndarray, unknown: np.ndarray) -> np.ndarray:
        if self.mode == "block":
            return np.where(unknown, np.float32(np.inf), heights).astype(np.float32)
        return np.where(unknown, np.maximum(heights, np.float32(self.height_m)), heights).astype(np.float32)


def load_city_grid(path: Path, area_wgs84: BaseGeometry | None, policy: UnknownHeightPolicy | None = None) -> Grid:
    """Loads the precomputed citywide raster; coverage from the official polygon.
    Unknown building heights stay a separate mask; `policy` decides how routing treats them."""
    policy = policy or UnknownHeightPolicy.parse(UNKNOWN_BUILDING_POLICY)
    if not path.is_file():
        raise GridLoadError(f"Missing routing raster {path}. Run `python scripts/fetch_osm.py` from the repo root.")
    with np.load(path) as z:
        meta = json.loads(str(z["meta"]))
        grid = Grid(
            min_x=meta["min_x"], min_y=meta["min_y"], cell=meta["cell"], rows=meta["rows"], cols=meta["cols"],
            coverage=np.zeros((meta["rows"], meta["cols"]), bool),
            river=z["river"], park=z["park"], building_height=z["building_height"].astype(np.float32),
            meta=meta,
        )
        if "building_unknown" in z.files:
            grid.unknown_height = z["building_unknown"]
            grid.unknown_policy = policy
            grid.building_height = policy.apply(grid.building_height, grid.unknown_height)
    if area_wgs84 is not None:
        grid.coverage = coverage_mask(grid, area_wgs84)
    return grid


def build_grid(corridors, buildings, area_wgs84: BaseGeometry, cell: float = CELL_SIZE_M) -> Grid:
    """Rasterises small synthetic worlds (tests): `corridors` / `buildings` are
    Layers with `properties` and WGS84 `geometries`."""
    area_m = to_metres(area_wgs84)
    minx, miny, maxx, maxy = area_m.bounds
    grid = empty_grid(minx, miny, math.ceil((maxy - miny) / cell), math.ceil((maxx - minx) / cell), cell)
    grid.coverage = coverage_mask(grid, area_wgs84)
    for props, geom in zip(corridors.properties, corridors.geometries):
        win, inside = _centres_inside(grid, to_metres(geom))
        layer = grid.river if props.corridor_type == "RIVER" else grid.park
        layer[win] |= inside
    # A cell takes the tallest building covering its centre; small footprints
    # still mark the cell holding their representative point.
    heights = grid.building_height
    for props, geom in zip(buildings.properties, buildings.geometries):
        geom_m = to_metres(geom)
        win, inside = _centres_inside(grid, geom_m)
        if inside.any():
            heights[win] = np.where(inside, np.maximum(heights[win], props.height_m), heights[win])
        else:
            p = geom_m.representative_point()
            rc = grid.cell_of(p.x, p.y)
            if rc:
                heights[rc] = max(heights[rc], props.height_m)
    return grid


def pool_blocked(cost: np.ndarray, factor: int) -> np.ndarray:
    """Coarsens a cost window by `factor`: a coarse cell is blocked if ANY of its
    fine cells is blocked (conservative), otherwise it takes their mean cost."""
    if factor == 1:
        return cost
    r, c = cost.shape
    pr, pc = (-r) % factor, (-c) % factor
    padded = np.pad(cost, ((0, pr), (0, pc)), constant_values=np.inf)
    blocks = padded.reshape(padded.shape[0] // factor, factor, padded.shape[1] // factor, factor).swapaxes(1, 2)
    blocked = ~np.isfinite(blocks).all(axis=(2, 3))
    with np.errstate(invalid="ignore"):
        mean = np.where(blocked, np.inf, blocks.mean(axis=(2, 3)))
    return mean
