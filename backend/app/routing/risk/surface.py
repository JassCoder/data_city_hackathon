"""Combines the providers and the config into a cost surface for one departure.

Edge cost (per A* step of `length` metres entering cell v with move k):

    length * (1 + sum_i weight_i * term_i[v])                  cell part
  + length * (w_energy * energy[k] + w_time * time[k])         direction part

Cell terms (population, obstacle proximity, noise, emergency landing,
sensitive areas) are 0..1 rasters; the direction part depends on the heading
relative to the nearest wind sample. Hard constraints are not costs: callers
set blocked cells to inf before searching.

Heuristic admissibility: every term and weight is >= 0, so a metre can never
cost less than 1 + min(direction table) (zero risk, best tailwind). The octile
distance is the length of the shortest possible 8-connected path, so octile x
that minimum never exceeds the true remaining cost and A* stays optimal.
"""

from __future__ import annotations

import math
from collections.abc import Sequence
from dataclasses import dataclass, field

import numpy as np

from app.routing.astar import MOVES
from app.routing.risk import terms
from app.routing.risk.config import CostModelConfig, Weights
from app.routing.risk.energy import DroneEnergy, direction_table, energy_j_per_m, energy_term, ground_speed, time_term
from app.routing.risk.providers import CostContext, GridSpec, Providers, WindProvider

CELL_TERMS = ("population", "obstacle_proximity", "noise", "emergency_landing", "sensitive_areas")
# Terms that are all zero without the OSM risk raster (grid_only_providers).
RASTER_TERMS = ("population", "noise", "sensitive_areas")
DIRECTION_TERMS = ("energy", "time")
Point = tuple[float, float]


@dataclass(frozen=True)
class TermCost:
    weight: float
    mean: float  # length-weighted mean of the normalized term along the route (0..1)
    cost: float  # weight x integral of the term over the route (cost units = metres)


@dataclass(frozen=True)
class RouteBreakdown:
    length_m: float
    total_cost: float  # length + sum of term costs
    terms: dict[str, TermCost]
    energy_wh: float
    flight_time_s: float
    population_exposure: float  # integral of density along the route: people/ha x km
    max_density_per_ha: float


@dataclass(frozen=True)
class CostSurface:
    """Everything A* needs for one CostContext; rebuild it when conditions change."""

    spec: GridSpec
    ctx: CostContext
    weights: Weights
    drone: DroneEnergy
    cell_cost: np.ndarray  # 1 + weighted cell terms (float32, >= 1, never inf)
    cell_terms: dict[str, np.ndarray]
    density_per_ha: np.ndarray  # after the time-of-day multiplier (for exposure)
    wind_xy: list[Point]
    wind: list[tuple[float, float]]  # (speed km/h, from deg) per sample
    table: list[list[float]]  # [sample][move] weighted direction cost per metre
    key: tuple  # everything the surface was built from (cache key)
    min_cost_per_m: float = field(init=False)

    def __post_init__(self):
        object.__setattr__(self, "min_cost_per_m", 1.0 + min(min(row) for row in self.table))

    # --- search inputs -------------------------------------------------------------
    def nearest_sample(self, xs: np.ndarray, ys: np.ndarray) -> np.ndarray:
        pts = np.asarray(self.wind_xy, dtype=np.float64)
        d2 = (xs[..., None] - pts[:, 0]) ** 2 + (ys[..., None] - pts[:, 1]) ** 2
        return np.argmin(d2, axis=-1)

    def regions(self, r0: int = 0, c0: int = 0, shape: tuple[int, int] | None = None, factor: int = 1) -> list[int]:
        """Nearest wind sample per (possibly coarsened) cell of a window, flattened."""
        rows, cols = shape or self.spec.shape
        s = self.spec
        xs = s.min_x + (c0 + (np.arange(cols) + 0.5) * factor) * s.cell_m
        ys = s.min_y + (r0 + (np.arange(rows) + 0.5) * factor) * s.cell_m
        gx, gy = np.meshgrid(xs, ys)
        return self.nearest_sample(gx, gy).ravel().tolist()

    def search_cost(self, blocked: np.ndarray) -> np.ndarray:
        cost = self.cell_cost.copy()
        cost[self.spec.check("blocked", blocked)] = np.inf
        return cost

    # --- explanation ---------------------------------------------------------------
    def breakdown(self, points: Sequence[Point]) -> RouteBreakdown:
        """Cost per term along a polyline in grid metric coordinates.

        Each segment is sampled every third of a cell; cell terms are read at the
        sample midpoint, direction terms use the exact segment heading and the
        nearest wind sample (not the 8 grid moves), so the numbers describe the
        route actually flown."""
        w = self.weights.model_dump()
        acc = dict.fromkeys(CELL_TERMS + DIRECTION_TERMS, 0.0)
        length = energy_j = time_s = exposure = max_density = 0.0
        payload, v = self.ctx.payload_kg, self.drone.cruise_speed_mps
        step = self.spec.cell_m / 3
        for (x0, y0), (x1, y1) in zip(points, points[1:]):
            seg = math.hypot(x1 - x0, y1 - y0)
            if seg == 0:
                continue
            ux, uy = (x1 - x0) / seg, (y1 - y0) / seg
            n = max(1, math.ceil(seg / step))
            ds = seg / n
            for i in range(n):
                t = (i + 0.5) / n
                x, y = x0 + (x1 - x0) * t, y0 + (y1 - y0) * t
                cell = self.spec.cell_of(x, y)
                if cell is not None:
                    for name in CELL_TERMS:
                        acc[name] += float(self.cell_terms[name][cell]) * ds
                    d = float(self.density_per_ha[cell])
                    exposure += d * ds / 1000
                    max_density = max(max_density, d)
                speed, direction = self.wind[int(self.nearest_sample(np.array(x), np.array(y)))]
                g = ground_speed(v, speed, direction, ux, uy)
                acc["energy"] += energy_term(self.drone, payload, g) * ds
                acc["time"] += time_term(self.drone, g) * ds
                energy_j += energy_j_per_m(self.drone, payload, g) * ds
                time_s += ds / g
            length += seg
        costs = {k: TermCost(w[k], acc[k] / length if length else 0.0, w[k] * acc[k]) for k in acc}
        return RouteBreakdown(
            length_m=length, total_cost=length + sum(c.cost for c in costs.values()), terms=costs,
            energy_wh=energy_j / 3600, flight_time_s=time_s, population_exposure=exposure,
            max_density_per_ha=max_density,
        )

    def breakdown_cells(self, path: Sequence[tuple[int, int]]) -> RouteBreakdown:
        return self.breakdown([self.spec.centre(r, c) for r, c in path])


class CostModel:
    """Static layers of one data source; builds a CostSurface per context.

    Static terms (proximity, landing, sensitive sites) are computed once and
    cached; time-dependent ones (population multiplier, night noise) and wind
    are applied per surface. Surfaces are cached by their full input key."""

    def __init__(self, cfg: CostModelConfig, spec: GridSpec, providers: Providers, cache_size: int = 8,
                 unavailable_reason: str | None = None):
        self.cfg = cfg
        self.spec = spec
        self.providers = providers
        # Set when the providers are a degraded fallback (no crowd/noise/sensitive data).
        self.unavailable_reason = unavailable_reason
        self._density = spec.check("density", providers.population.density_per_ha())
        self._residential = spec.check("residential", providers.land_use.residential_share())
        self.heights_m = spec.check("heights", providers.obstacles.heights_m())
        c = spec.cell_m
        self._static = {
            "obstacle_proximity": terms.obstacle_proximity_term(self.heights_m, c, cfg.obstacle_proximity),
            "emergency_landing": terms.emergency_landing_term(
                spec.check("open space", providers.land_use.open_space()), c, cfg.emergency_landing),
            "sensitive_areas": terms.sensitive_term(
                spec.check("sensitive", providers.land_use.sensitive_sites()), c, cfg.sensitive_areas),
        }
        self._cache: dict[tuple, CostSurface] = {}
        self._cache_size = cache_size

    @property
    def data_available(self) -> bool:
        return self.unavailable_reason is None

    def needs_raster(self, weights: Weights) -> bool:
        """True if these weights rely on terms the grid-only fallback cannot provide."""
        w = weights.model_dump()
        return any(w[t] > 0 for t in RASTER_TERMS)

    def obstacle_mask(self, altitude_m: float, clearance_m: float) -> np.ndarray:
        """Hard constraint: structures reaching into the flight band block the cell."""
        return self.heights_m >= altitude_m - clearance_m

    def surface(self, ctx: CostContext, drone: DroneEnergy, weights: Weights | None = None,
                wind: WindProvider | None = None) -> CostSurface:
        """`weights`/`wind` override the configured weights and the model's wind
        provider (the planner passes the request's forecast)."""
        weights = weights or self.cfg.weights
        hour = ctx.local_hour(self.cfg.timezone)
        samples = (wind or self.providers.wind).samples(ctx)
        wind = [(s.speed_kmh, s.direction_deg) for s in samples]
        key = (hour, ctx.payload_kg, drone, tuple(weights.model_dump().values()),
               tuple((s.x, s.y) for s in samples), tuple(wind))
        hit = self._cache.get(key)
        if hit is not None:
            return hit
        p = self.cfg.population
        cell_terms = {
            "population": terms.population_term(self._density, hour, p),
            "noise": terms.noise_term(self._residential, hour, self.cfg.noise),
            **self._static,
        }
        w = weights.model_dump()
        cell_cost = np.ones(self.spec.shape, np.float32)
        for name in CELL_TERMS:
            if w[name]:
                cell_cost += np.float32(w[name]) * cell_terms[name]
        surface = CostSurface(
            spec=self.spec, ctx=ctx, weights=weights, drone=drone, cell_cost=cell_cost, cell_terms=cell_terms,
            density_per_ha=self._density * np.float32(p.hourly_multiplier[hour]),
            wind_xy=[(s.x, s.y) for s in samples], wind=wind,
            table=direction_table(drone, ctx.payload_kg, samples, MOVES, weights), key=key,
        )
        if len(self._cache) >= self._cache_size:
            self._cache.pop(next(iter(self._cache)))
        self._cache[key] = surface
        return surface
