"""Cell-based soft cost terms, each normalized to 0..1 on the routing grid.

Each function takes provider rasters plus its config block and returns a
float32 array. Distances are exact Euclidean distances between cell centres
(a feature anywhere in a cell counts as at its centre), capped at the radius
where the term saturates.
"""

from __future__ import annotations

import math

import numpy as np

from app.routing.risk.config import NoiseParams, ObstacleProximityParams, PopulationParams, RadiusParams


def distance_within(mask: np.ndarray, cell_m: float, radius_m: float) -> np.ndarray:
    """Distance (m) from each cell centre to the nearest True cell, capped at radius_m.

    Visits every cell offset inside the radius in order of distance, so each
    cell gets the exact nearest distance; cost is O(cells x offsets), which
    stays small for the radii used (a few hundred metres on 25 m cells).
    """
    rows, cols = mask.shape
    out = np.full(mask.shape, radius_m, np.float32)
    if not mask.any():
        return out
    unreached = np.ones(mask.shape, bool)
    reach = int(math.floor(radius_m / cell_m))
    offsets = sorted(
        (math.hypot(dr, dc) * cell_m, dr, dc)
        for dr in range(-reach, reach + 1)
        for dc in range(-reach, reach + 1)
        if math.hypot(dr, dc) * cell_m < radius_m and abs(dr) < rows and abs(dc) < cols
    )
    for d, dr, dc in offsets:
        # target[r, c] is reached if mask[r + dr, c + dc] is True
        tr = slice(max(0, -dr), rows - max(0, dr))
        tc = slice(max(0, -dc), cols - max(0, dc))
        sr = slice(max(0, dr), rows - max(0, -dr))
        sc = slice(max(0, dc), cols - max(0, -dc))
        hit = mask[sr, sc] & unreached[tr, tc]
        if hit.any():
            out[tr, tc][hit] = d
            unreached[tr, tc] &= ~hit
    return out


def falloff(mask: np.ndarray, cell_m: float, radius_m: float) -> np.ndarray:
    """1.0 on a feature, falling linearly to 0 at radius_m."""
    return 1.0 - distance_within(mask, cell_m, radius_m) / np.float32(radius_m)


def population_term(density_per_ha: np.ndarray, hour: int, p: PopulationParams) -> np.ndarray:
    """(density x time-of-day multiplier / reference) ** exponent, clipped to 1.
    The exponent makes a crowded block cost far more than two half-crowded ones."""
    scaled = np.clip(density_per_ha * np.float32(p.hourly_multiplier[hour] / p.reference_density_per_ha), 0.0, 1.0)
    return (scaled ** np.float32(p.exponent)).astype(np.float32)


def obstacle_proximity_term(heights_m: np.ndarray, cell_m: float, p: ObstacleProximityParams) -> np.ndarray:
    """Small penalty near buildings at least minHeightM tall (flyable ones too)."""
    return falloff(heights_m >= p.min_height_m, cell_m, p.radius_m)


def is_night(hour: int, p: NoiseParams) -> bool:
    start, end = p.night_start_hour, p.night_end_hour
    return (hour >= start or hour < end) if start > end else (start <= hour < end)


def noise_term(residential_share: np.ndarray, hour: int, p: NoiseParams) -> np.ndarray:
    factor = p.night_factor if is_night(hour, p) else p.day_factor
    return (np.clip(residential_share, 0.0, 1.0) * np.float32(factor)).astype(np.float32)


def emergency_landing_term(open_space: np.ndarray, cell_m: float, p: RadiusParams) -> np.ndarray:
    """0 over open space, rising to 1.0 at radiusM from the nearest one. Summed
    along a route this penalises long stretches without a landing option."""
    return distance_within(open_space, cell_m, p.radius_m) / np.float32(p.radius_m)


def sensitive_term(sites: np.ndarray, cell_m: float, p: RadiusParams) -> np.ndarray:
    """Soft avoidance of schools, hospitals, stadiums (on top of legal zones)."""
    return falloff(sites, cell_m, p.radius_m)
