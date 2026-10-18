"""Risk-aware A* on a single grid, with a structured result instead of
exceptions or empty lists. The citywide planner (app/routing/planner.py) uses
the same CostSurface inside its corridor search; this module is the
standalone, UI-free entry point (tests, experiments)."""

from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum

import numpy as np

from app.routing.astar import MOVES, Cell, astar
from app.routing.risk.surface import CostSurface, RouteBreakdown

_MOVE_INDEX = {(dr, dc): k for k, (dr, dc, _) in enumerate(MOVES)}


class RouteFailure(StrEnum):
    WIND_LIMIT = "WIND_LIMIT"
    START_BLOCKED = "START_BLOCKED"
    GOAL_BLOCKED = "GOAL_BLOCKED"
    NO_ROUTE = "NO_ROUTE"
    BATTERY_RESERVE = "BATTERY_RESERVE"


@dataclass(frozen=True)
class RiskRoute:
    reason: RouteFailure | None  # None = feasible
    message: str
    path: list[Cell] | None = None
    search_cost: float | None = None  # A* cost of the cell path (cost units = metres)
    breakdown: RouteBreakdown | None = None  # also set for BATTERY_RESERVE, to show the shortfall

    @property
    def feasible(self) -> bool:
        return self.reason is None


def path_cost(surface: CostSurface, cost: np.ndarray, path: list[Cell]) -> float:
    """Exact A* step-cost sum of a cell path (same formula the search minimises)."""
    regions = surface.regions()
    cols = surface.spec.cols
    total = 0.0
    for (r0, c0), (r1, c1) in zip(path, path[1:]):
        k = _MOVE_INDEX[(r1 - r0, c1 - c0)]
        v = r1 * cols + c1
        total += MOVES[k][2] * surface.spec.cell_m * (float(cost[r1, c1]) + surface.table[regions[v]][k])
    return total


def find_route(surface: CostSurface, hard: dict[str, np.ndarray], start: Cell, goal: Cell,
               battery_reserve_fraction: float) -> RiskRoute:
    """Cheapest route from start to goal on surface, never entering a cell that
    any `hard` mask ({reason label: bool raster}) blocks.

    Checks, in order: wind limit, start, goal, path existence, battery reserve.
    Assumption: the battery check applies to the cheapest route under the
    current weights; with a low energy weight a lower-energy route may exist."""
    drone = surface.drone
    strongest = max(speed for speed, _ in surface.wind)
    if strongest > drone.max_wind_kmh:
        return RiskRoute(RouteFailure.WIND_LIMIT, f"Wind {strongest:.0f} km/h exceeds the drone limit of "
                                                  f"{drone.max_wind_kmh:.0f} km/h.")
    blocked = np.zeros(surface.spec.shape, bool)
    for mask in hard.values():
        blocked |= surface.spec.check("hard constraint", mask)
    for label, cell, reason in (("Start", start, RouteFailure.START_BLOCKED), ("Goal", goal, RouteFailure.GOAL_BLOCKED)):
        causes = [name for name, mask in hard.items() if mask[cell]]
        if causes:
            return RiskRoute(reason, f"{label} cell {cell} is blocked by: {', '.join(causes)}.")
    cost = surface.search_cost(blocked)
    path = astar(cost, start, goal, surface.min_cost_per_m, move_cost=(surface.regions(), surface.table),
                 additive=True)
    if path is None:
        active = [name for name, mask in hard.items() if mask.any()]
        return RiskRoute(RouteFailure.NO_ROUTE, "No route: every path is blocked by "
                         f"{', '.join(active) or 'the grid edge'}.")
    breakdown = surface.breakdown_cells(path)
    usable = drone.usable_wh(battery_reserve_fraction)
    if breakdown.energy_wh > usable:
        return RiskRoute(RouteFailure.BATTERY_RESERVE,
                         f"Route needs {breakdown.energy_wh:.1f} Wh but only {usable:.1f} Wh is usable while keeping "
                         f"a {battery_reserve_fraction:.0%} battery reserve.", breakdown=breakdown)
    return RiskRoute(None, "OK", path, path_cost(surface, cost, path), breakdown)
