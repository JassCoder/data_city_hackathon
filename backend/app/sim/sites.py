"""Emergency landing sites: open green space near a point.

Open space comes from the planner's land-use provider (parks, grass, meadows, fields
from the OSM risk raster; the park mask in the grid-only fallback). Cells with a
building on them or outside Warsaw are excluded. Whether a site is actually
reachable (zones, buildings, battery) is decided by planning a route to it.
"""

from __future__ import annotations

import numpy as np

from app.routing.grid import lonlat_to_xy, xy_to_lonlat
from app.routing.planner import RoutePlanner


def open_space_sites(planner: RoutePlanner, lon: float, lat: float, radius_m: float, limit: int) -> list[tuple[float, float, float]]:
    """Up to `limit` open-space cell centres within radius_m, nearest first: (lon, lat, distance m)."""
    grid = planner.grid
    mask = planner.risk.providers.land_use.open_space()
    x, y = lonlat_to_xy(lon, lat)
    rs, cs = grid.window((x - radius_m, y - radius_m, x + radius_m, y + radius_m))
    if rs.stop <= rs.start or cs.stop <= cs.start:
        return []
    ok = mask[rs, cs] & grid.coverage[rs, cs] & (grid.building_height[rs, cs] <= 0)
    rows, cols = np.nonzero(ok)
    if not len(rows):
        return []
    cx = grid.min_x + (cs.start + cols + 0.5) * grid.cell
    cy = grid.min_y + (rs.start + rows + 0.5) * grid.cell
    dist = np.hypot(cx - x, cy - y)
    keep = dist <= radius_m
    order = np.lexsort((cols[keep], rows[keep], dist[keep]))[:limit]  # distance, then row/col: deterministic
    lons, lats = xy_to_lonlat(cx[keep][order], cy[keep][order])
    return [(float(a), float(b), float(d)) for a, b, d in zip(np.atleast_1d(lons), np.atleast_1d(lats), dist[keep][order])]
