"""Rasterises terrain corridors and buildings onto a metric grid (EPSG:2180)
once at startup. Airspace zones are evaluated per flight (app/airspace).

Arrays are indexed [row, col], where row 0 is the southern edge (y grows north)
and col 0 the western edge.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np
import shapely
from pyproj import Transformer
from shapely.geometry import box
from shapely.geometry.base import BaseGeometry

from app.routing.costs import CELL_SIZE_M
from app.services.data_loader import DemoData

_to_m = Transformer.from_crs("EPSG:4326", "EPSG:2180", always_xy=True).transform
_to_deg = Transformer.from_crs("EPSG:2180", "EPSG:4326", always_xy=True).transform


def to_metres(geom: BaseGeometry) -> BaseGeometry:
    return shapely.transform(geom, lambda x, y: _to_m(x, y), interleaved=False)


def lonlat_to_xy(lon: float, lat: float) -> tuple[float, float]:
    return _to_m(lon, lat)


def xy_to_lonlat(xs, ys):
    return _to_deg(xs, ys)


@dataclass
class Grid:
    min_x: float
    min_y: float
    cell: float
    rows: int
    cols: int
    coverage: np.ndarray  # bool: cell centre inside the demo bbox
    river: np.ndarray  # bool
    park: np.ndarray  # bool
    building_height: np.ndarray  # float metres, 0 = no building

    # --- coordinates -----------------------------------------------------------
    def cell_of(self, x: float, y: float) -> tuple[int, int] | None:
        col = math.floor((x - self.min_x) / self.cell)
        row = math.floor((y - self.min_y) / self.cell)
        if 0 <= row < self.rows and 0 <= col < self.cols:
            return row, col
        return None

    def centre(self, row: int, col: int) -> tuple[float, float]:
        return self.min_x + (col + 0.5) * self.cell, self.min_y + (row + 0.5) * self.cell

    def centres(self) -> tuple[np.ndarray, np.ndarray]:
        xs = self.min_x + (np.arange(self.cols) + 0.5) * self.cell
        ys = self.min_y + (np.arange(self.rows) + 0.5) * self.cell
        return np.meshgrid(xs, ys)  # each [rows, cols]

    def window(self, bounds: tuple[float, float, float, float]) -> tuple[slice, slice]:
        minx, miny, maxx, maxy = bounds
        c0 = max(0, math.floor((minx - self.min_x) / self.cell))
        c1 = min(self.cols, math.ceil((maxx - self.min_x) / self.cell))
        r0 = max(0, math.floor((miny - self.min_y) / self.cell))
        r1 = min(self.rows, math.ceil((maxy - self.min_y) / self.cell))
        return slice(r0, r1), slice(c0, c1)


def empty_grid(min_x: float, min_y: float, rows: int, cols: int, cell: float = CELL_SIZE_M) -> Grid:
    """All-open grid; used by tests and as the base for rasterisation."""
    return Grid(
        min_x=min_x,
        min_y=min_y,
        cell=cell,
        rows=rows,
        cols=cols,
        coverage=np.ones((rows, cols), bool),
        river=np.zeros((rows, cols), bool),
        park=np.zeros((rows, cols), bool),
        building_height=np.zeros((rows, cols), np.float32),
    )


def _centres_inside(grid: Grid, geom_m: BaseGeometry) -> tuple[tuple[slice, slice], np.ndarray]:
    win = grid.window(geom_m.bounds)
    xs, ys = grid.centres()
    return win, shapely.contains_xy(geom_m, xs[win], ys[win])


def cells_intersecting(grid: Grid, geom_m: BaseGeometry) -> tuple[tuple[slice, slice], np.ndarray]:
    """Conservative: any cell touching the polygon (used for airspace zones)."""
    win = grid.window(geom_m.bounds)
    rs, cs = win
    rows = np.arange(rs.start, rs.stop)
    cols = np.arange(cs.start, cs.stop)
    cc, rr = np.meshgrid(cols, rows)
    x0 = grid.min_x + cc * grid.cell
    y0 = grid.min_y + rr * grid.cell
    boxes = shapely.box(x0, y0, x0 + grid.cell, y0 + grid.cell)
    shapely.prepare(geom_m)
    return win, shapely.intersects(geom_m, boxes)


def build_grid(data: DemoData, bbox: dict[str, float], cell: float = CELL_SIZE_M) -> Grid:
    bbox_m = to_metres(box(bbox["minLon"], bbox["minLat"], bbox["maxLon"], bbox["maxLat"]))
    minx, miny, maxx, maxy = bbox_m.bounds
    grid = empty_grid(minx, miny, math.ceil((maxy - miny) / cell), math.ceil((maxx - minx) / cell), cell)

    xs, ys = grid.centres()
    grid.coverage = shapely.contains_xy(bbox_m, xs, ys)

    for props, geom in zip(data.corridors.properties, data.corridors.geometries):
        win, inside = _centres_inside(grid, to_metres(geom))
        layer = grid.river if props.corridor_type == "RIVER" else grid.park
        layer[win] |= inside

    # Buildings: a cell takes the tallest building covering its centre. Small
    # footprints that cover no centre still mark the cell holding their
    # representative point, so no tall tower slips through the grid.
    heights = grid.building_height
    for props, geom in zip(data.buildings.properties, data.buildings.geometries):
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
