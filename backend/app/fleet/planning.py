"""Reproducible depot-site planning and demand-based capacity recommendations.

SIMULATION. Inputs are real geography (official boundary and districts, OSM
restaurants and hospitals, the OSM building raster, loaded obstacle zones) plus
EXPLICIT ASSUMPTIONS (config.SIMULATED_DISTRICT_DEMAND, weights below, service
radius). Outputs are proposed planning sites, never verified landing locations.

Algorithm: greedy p-median with a coverage penalty. Demand points carry weights;
candidate sites lie on a regular grid inside Warsaw, each snapped to the nearest
25 m cell that is routable, has no mapped building (unknown heights count as
buildings) and is outside every obstacle zone. Existing depots are fixed. Each
step adds the candidate that most reduces sum(weight * cost(distance to nearest
depot)), where cost = distance within the service radius and 2 x radius beyond it
(uncovered demand). Straight-line distance is a planning proxy; dispatch uses
real routed distances.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field

import numpy as np

from app.config import (
    DEPOT_CANDIDATE_SPACING_M,
    DEPOT_CAPACITY_HIGH_DEMAND,
    DEPOT_CAPACITY_STANDARD,
    DEPOT_HIGH_DEMAND_COUNT,
    DEPOT_SERVICE_RADIUS_M,
    SIMULATED_DISTRICT_DEMAND,
)
from app.fleet.pois import Pois
from app.geo.coverage import Coverage
from app.routing.grid import Grid, lonlat_to_xy, xy_to_lonlat

WEIGHT_RESTAURANT = 1.0
WEIGHT_SUBSCRIBED_RESTAURANT = 3.0
WEIGHT_HOSPITAL = 4.0
WEIGHT_DISTRICT_BASE = 10.0  # every district gets some base demand at its centroid (residential deliveries)
SNAP_RADIUS_M = 400.0

ASSUMPTIONS = [
    "Demand is SIMULATED: real OSM restaurant and hospital locations weighted by assumed factors "
    f"(restaurant {WEIGHT_RESTAURANT}, subscribed partner {WEIGHT_SUBSCRIBED_RESTAURANT}, hospital {WEIGHT_HOSPITAL}, "
    f"district base {WEIGHT_DISTRICT_BASE}) times an assumed district multiplier.",
    "District multipliers are assumptions (central districts higher), not measured order data.",
    f"Service radius {DEPOT_SERVICE_RADIUS_M / 1000:.0f} km straight line; dispatch uses routed distances.",
    "Candidate sites are open 25 m cells without mapped buildings and outside loaded obstacle zones; "
    "physical suitability, ownership and permissions are NOT verified.",
]


@dataclass(frozen=True)
class DemandPoint:
    x: float
    y: float
    weight: float
    district: str | None


@dataclass
class PlannedSite:
    latitude: float
    longitude: float
    district: str | None
    fixed: bool
    ref: str | None = None  # id of an existing depot
    demand: float = 0.0
    share: float = 0.0
    depot_type: str = "STANDARD"
    capacity: int = DEPOT_CAPACITY_STANDARD


@dataclass
class PlanResult:
    sites: list[PlannedSite]
    covered_pct: float
    mean_distance_m: float
    candidates: int
    demand_total: float
    assumptions: list[str] = field(default_factory=lambda: list(ASSUMPTIONS))


def demand_points(pois: Pois, coverage: Coverage, subscribed: set[str] = frozenset(),
                  weights: dict[str, float] | None = None) -> list[DemandPoint]:
    weights = weights or SIMULATED_DISTRICT_DEMAND
    pts = []
    for r in pois.restaurants.items:
        w = WEIGHT_SUBSCRIBED_RESTAURANT if r.id in subscribed else WEIGHT_RESTAURANT
        pts.append(DemandPoint(*lonlat_to_xy(r.longitude, r.latitude), w * weights.get(r.district, 1.0), r.district))
    for h in pois.hospitals.items:
        pts.append(DemandPoint(*lonlat_to_xy(h.longitude, h.latitude), WEIGHT_HOSPITAL * weights.get(h.district, 1.0),
                               h.district))
    for d in coverage.districts:
        c = d.geom.representative_point()
        pts.append(DemandPoint(*lonlat_to_xy(c.x, c.y), WEIGHT_DISTRICT_BASE * weights.get(d.name, 1.0), d.name))
    return pts


def candidate_sites(coverage: Coverage, grid: Grid, obstacle_cells: np.ndarray | None = None,
                    spacing_m: float = DEPOT_CANDIDATE_SPACING_M) -> list[tuple[float, float]]:
    """Grid points inside Warsaw snapped to the nearest open, routable, obstacle-free cell (metres)."""
    free = grid.coverage & (grid.building_height <= 0)
    if grid.unknown_height is not None:
        free &= ~grid.unknown_height
    if obstacle_cells is not None and len(obstacle_cells):
        flat = free.reshape(-1)
        flat[obstacle_cells] = False
    w, s, e, n = coverage.bounds
    x0, y0 = lonlat_to_xy(w, s)
    x1, y1 = lonlat_to_xy(e, n)
    r = int(math.ceil(SNAP_RADIUS_M / grid.cell))
    out = []
    for y in np.arange(y0 + spacing_m / 2, y1, spacing_m):
        for x in np.arange(x0 + spacing_m / 2, x1, spacing_m):
            cell = grid.cell_of(x, y)
            if cell is None or not grid.coverage[cell]:
                continue
            row, col = cell
            win = free[max(0, row - r): row + r + 1, max(0, col - r): col + r + 1]
            rr, cc = np.nonzero(win)
            if not len(rr):
                continue
            rr, cc = rr + max(0, row - r), cc + max(0, col - r)
            k = int(np.argmin((rr - row) ** 2 + (cc - col) ** 2))
            out.append(grid.centre(int(rr[k]), int(cc[k])))
    return out


def _cost(d: np.ndarray, radius: float) -> np.ndarray:
    return np.where(d <= radius, d, 2 * radius)


def plan_depots(demand: list[DemandPoint], candidates: list[tuple[float, float]],
                fixed: list[tuple[str, float, float]], k: int, coverage: Coverage,
                radius: float = DEPOT_SERVICE_RADIUS_M, high_demand_count: int = DEPOT_HIGH_DEMAND_COUNT) -> PlanResult:
    """fixed: [(id, lon, lat)] existing depots that are kept. Returns k sites in total."""
    dxy = np.array([(p.x, p.y) for p in demand])
    w = np.array([p.weight for p in demand])
    cxy = np.array(candidates) if candidates else np.zeros((0, 2))
    fxy = np.array([lonlat_to_xy(lon, lat) for _, lon, lat in fixed]) if fixed else np.zeros((0, 2))

    def dist(points):
        return np.hypot(dxy[:, None, 0] - points[None, :, 0], dxy[:, None, 1] - points[None, :, 1])

    cand_d = dist(cxy) if len(cxy) else np.zeros((len(dxy), 0))
    best = _cost(dist(fxy).min(axis=1), radius) if len(fxy) else np.full(len(dxy), 2 * radius)
    chosen: list[int] = []
    for _ in range(max(0, k - len(fixed))):
        if not cand_d.shape[1]:
            break
        totals = (w[:, None] * np.minimum(best[:, None], _cost(cand_d, radius))).sum(axis=0)
        totals[chosen] = np.inf
        j = int(np.argmin(totals))
        if not math.isfinite(totals[j]):
            break
        chosen.append(j)
        best = np.minimum(best, _cost(cand_d[:, j], radius))

    site_xy = np.vstack([fxy, cxy[chosen]]) if chosen else fxy
    sites = [PlannedSite(lat, lon, coverage.district_of(lon, lat), True, ref) for ref, lon, lat in fixed]
    for j in chosen:
        lons, lats = xy_to_lonlat(np.array([cxy[j, 0]]), np.array([cxy[j, 1]]))
        lon, lat = round(float(lons[0]), 6), round(float(lats[0]), 6)
        sites.append(PlannedSite(lat, lon, coverage.district_of(lon, lat), False))

    d_all = dist(site_xy)
    nearest = d_all.argmin(axis=1)
    nearest_d = d_all.min(axis=1)
    total = float(w.sum())
    for i, s in enumerate(sites):
        s.demand = round(float(w[nearest == i].sum()), 1)
        s.share = round(s.demand / total, 4) if total else 0.0
    planned = sorted((s for s in sites if not s.fixed), key=lambda s: -s.demand)
    for s in planned[:high_demand_count]:
        s.depot_type, s.capacity = "HIGH_DEMAND", DEPOT_CAPACITY_HIGH_DEMAND
    covered = float(w[nearest_d <= radius].sum()) / total * 100 if total else 0.0
    return PlanResult(sites, round(covered, 1), round(float((w * nearest_d).sum() / total), 1) if total else 0.0,
                      len(candidates), round(total, 1))


# --- capacity recommendation ---------------------------------------------------------

PEAK_CONCURRENT_DELIVERIES = 40  # assumed citywide peak of simultaneous deliveries (baseline scenario)
SCENARIOS = {
    "BASELINE": ({}, 1.0, "Baseline simulated demand."),
    "CENTRAL_PEAK": ({"Śródmieście": 3.0, "Wola": 2.0, "Mokotów": 1.8, "Ochota": 1.6, "Praga-Północ": 1.6},
                     1.5, "SIMULATED lunchtime peak concentrated in central Warsaw (not measured data)."),
}


def recommend(share: float, installed: int, peak: float) -> dict:
    """Expected simultaneous drone demand at a depot vs its installed simulated capacity."""
    expected = share * peak
    ratio = expected / installed if installed else math.inf
    if ratio > 1.0:
        extra = math.ceil(expected - installed)
        option = (f"upgrade to a {DEPOT_CAPACITY_HIGH_DEMAND}-space depot" if installed + extra <= DEPOT_CAPACITY_HIGH_DEMAND
                  else "add an additional nearby depot")
        level, text = "HIGH", (f"Expected peak ~{expected:.1f} drones exceeds {installed} spaces: about {extra} more "
                               f"space(s) needed – {option}.")
    elif ratio > 0.6:
        level, text = "MEDIUM", ("Close to capacity at peak: keep a 6-space depot and plan a second small site "
                                 "nearby if demand grows.")
    else:
        level, text = "LOW", f"A standard {DEPOT_CAPACITY_STANDARD}-space depot is sufficient for the simulated demand."
    return {"expectedPeakDrones": round(expected, 1), "utilizationAtPeak": round(ratio, 2) if math.isfinite(ratio) else None,
            "level": level, "recommendation": text}
