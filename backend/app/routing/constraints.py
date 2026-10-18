"""Optional NON-REGULATORY planning constraints.

When a request sets `planningConstraints: true`, the mapped OSM aerodrome
footprints (never circles), grown by PLANNING_CONSTRAINT_BUFFER_M, are avoided
like obstacles. This is a conservative planning assumption chosen by the user,
NOT an official UAS geographical zone: it is reported separately from airspace
zones and never shown as a DRA zone. Off by default.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
from shapely.geometry.base import BaseGeometry

from app.config import PLANNING_CONSTRAINT_BUFFER_M
from app.geo.airports import AirportData
from app.routing.grid import Grid, cells_intersecting, to_metres

LABEL = "NON-REGULATORY PLANNING CONSTRAINT"


@dataclass(frozen=True)
class PlanningConstraint:
    id: str
    name: str
    geom_m: BaseGeometry  # footprint + buffer, EPSG:2180
    cells: np.ndarray  # flat grid indices touching it


def assumption(buffer_m: float = PLANNING_CONSTRAINT_BUFFER_M) -> str:
    grown = f", grown by {buffer_m:g} m" if buffer_m > 0 else ""
    return (f"{LABEL}: mapped OpenStreetMap aerodrome footprints{grown} are avoided. A planning assumption, "
            "not an official drone zone.")


def build_constraints(airports: AirportData, grid: Grid, buffer_m: float = PLANNING_CONSTRAINT_BUFFER_M) -> list[PlanningConstraint]:
    out = []
    for a in airports.airports:
        g = to_metres(a.geom)
        if buffer_m > 0:
            g = g.buffer(buffer_m)
        win, hit = cells_intersecting(grid, g)
        rs, cs = win
        rr, cc = np.nonzero(hit)
        cells = ((rr + rs.start) * grid.cols + (cc + cs.start)).astype(np.int64)
        out.append(PlanningConstraint(a.id, a.name or a.id, g, cells))
    return out
