"""Routing cost configuration. Change weights here and nowhere else.

Cost is a multiplier per metre flown through a cell. BLOCKED cells are never
entered. Airspace rules are identical for both modes: EMERGENCY is a
preference profile only and never enters a zone evaluated as an obstacle.
"""

from enum import StrEnum

BLOCKED = float("inf")

CELL_SIZE_M = 25.0

# Max distance a start/destination inside a tall building is moved to the
# nearest flyable cell. Points inside a zone are never snapped out of it.
SNAP_RADIUS_M = 150.0

# Smoothing may replace a sub-path by a straight segment only if the segment
# costs at most this factor more, so preferences (river, parks) survive.
SMOOTHING_COST_TOLERANCE = 1.02


class FlightMode(StrEnum):
    NORMAL = "NORMAL"
    EMERGENCY = "EMERGENCY"


class RouteObjective(StrEnum):
    """What the route minimises, always under the same hard constraints."""

    CORRIDORS = "CORRIDORS"  # prefer river/parks (TERRAIN_COSTS per mode)
    SHORTEST = "SHORTEST"  # minimise distance
    FASTEST = "FASTEST"  # minimise flight time: cruise speed + wind per direction of travel


# Terrain costs (cells not blocked by a zone or a too-tall building).
TERRAIN_COSTS: dict[FlightMode, dict[str, float]] = {
    FlightMode.NORMAL: {"river": 1.0, "park": 2.0, "open": 5.0},
    # Shorter, more direct routes; still stays out of every zone.
    FlightMode.EMERGENCY: {"river": 1.0, "park": 1.0, "open": 2.0},
}



def min_cost(mode: FlightMode) -> float:
    """Smallest cell cost for a mode; keeps the A* heuristic admissible."""
    return min(TERRAIN_COSTS[mode].values())
