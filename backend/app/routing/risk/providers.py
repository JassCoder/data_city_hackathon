"""Data interfaces of the cost model, plus generic array-backed implementations.

The cost terms depend only on these protocols, never on a data source. Every
layer is a raster on the routing grid ([row, col], row 0 = south, metric
cells), because per-point Python callbacks over ~1.4 M cells would be too slow.
Synthetic test worlds and the OSM-derived raster (osm.py) both use the Array*
classes below.

Assumption: layers are static for the lifetime of a provider; only wind and
the time-of-day multipliers (applied in terms.py) change per departure.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Protocol, runtime_checkable
from zoneinfo import ZoneInfo

import numpy as np


@dataclass(frozen=True)
class GridSpec:
    """Shape and metric size of the raster every provider must match."""

    rows: int
    cols: int
    cell_m: float
    min_x: float = 0.0  # metric coordinates of the south-west corner of cell (0, 0)
    min_y: float = 0.0

    @property
    def shape(self) -> tuple[int, int]:
        return self.rows, self.cols

    def cell_of(self, x: float, y: float) -> tuple[int, int] | None:
        row, col = math.floor((y - self.min_y) / self.cell_m), math.floor((x - self.min_x) / self.cell_m)
        return (row, col) if 0 <= row < self.rows and 0 <= col < self.cols else None

    def centre(self, row: float, col: float) -> tuple[float, float]:
        return self.min_x + (col + 0.5) * self.cell_m, self.min_y + (row + 0.5) * self.cell_m

    def check(self, name: str, array: np.ndarray) -> np.ndarray:
        if array.shape != self.shape:
            raise ValueError(f"{name}: raster shape {array.shape} does not match the grid {self.shape}")
        return array


@dataclass(frozen=True)
class CostContext:
    """Conditions a cost surface is built for. A new context = a new surface:
    this is the hook for recomputing costs when conditions change."""

    departure_time: datetime  # timezone-aware (naive values are treated as UTC)
    altitude_m: float
    payload_kg: float

    def local_hour(self, tz: str) -> int:
        t = self.departure_time
        if t.tzinfo is None:
            t = t.replace(tzinfo=timezone.utc)
        return t.astimezone(ZoneInfo(tz)).hour


@dataclass(frozen=True)
class WindVector:
    x: float  # metric position (EPSG:2180 in production, any metric frame in tests)
    y: float
    speed_kmh: float
    direction_deg: float  # meteorological: direction the wind blows FROM


@runtime_checkable
class PopulationDensityProvider(Protocol):
    def density_per_ha(self) -> np.ndarray:
        """Estimated people per hectare (>= 0) before the time-of-day multiplier."""


@runtime_checkable
class LandUseProvider(Protocol):
    def residential_share(self) -> np.ndarray:
        """Share of each cell (0..1) that is residential, for the noise term."""

    def open_space(self) -> np.ndarray:
        """True where an emergency landing is possible (parks, fields, meadows)."""

    def sensitive_sites(self) -> np.ndarray:
        """True on schools, hospitals, stadiums and similar sites."""


@runtime_checkable
class ObstacleProvider(Protocol):
    def heights_m(self) -> np.ndarray:
        """Tallest structure per cell in metres above ground (0 = none)."""


@runtime_checkable
class WindProvider(Protocol):
    def samples(self, ctx: CostContext) -> list[WindVector]:
        """Wind at the flight altitude for this departure; at least one sample."""


@dataclass
class Providers:
    """The four data sources a cost model is built from."""

    population: PopulationDensityProvider
    land_use: LandUseProvider
    obstacles: ObstacleProvider
    wind: WindProvider


# --- generic array-backed implementations ------------------------------------------

class ArrayPopulation:
    def __init__(self, density_per_ha: np.ndarray):
        self._density = np.asarray(density_per_ha, dtype=np.float32)

    def density_per_ha(self) -> np.ndarray:
        return self._density


class ArrayLandUse:
    def __init__(self, residential_share: np.ndarray, open_space: np.ndarray, sensitive_sites: np.ndarray):
        self._residential = np.asarray(residential_share, dtype=np.float32)
        self._open = np.asarray(open_space, dtype=bool)
        self._sensitive = np.asarray(sensitive_sites, dtype=bool)

    def residential_share(self) -> np.ndarray:
        return self._residential

    def open_space(self) -> np.ndarray:
        return self._open

    def sensitive_sites(self) -> np.ndarray:
        return self._sensitive


class ArrayObstacles:
    def __init__(self, heights_m: np.ndarray):
        self._heights = np.asarray(heights_m, dtype=np.float32)

    def heights_m(self) -> np.ndarray:
        return self._heights


class SampledWind:
    """Fixed wind samples (e.g. the planner's DEMO or Open-Meteo samples)."""

    def __init__(self, samples: list[WindVector]):
        if not samples:
            raise ValueError("SampledWind needs at least one sample")
        self._samples = list(samples)

    def samples(self, ctx: CostContext) -> list[WindVector]:
        return self._samples


def uniform_wind(speed_kmh: float, direction_deg: float) -> SampledWind:
    return SampledWind([WindVector(0.0, 0.0, speed_kmh, direction_deg)])
