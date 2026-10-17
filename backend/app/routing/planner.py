"""Turns a route request into a flight path anywhere in Warsaw.

Corridor search: A* runs on a window of the citywide 25 m grid around A-B.
If no path exists inside the window it is widened (up to the whole city);
windows larger than ROUTE_MAX_FINE_CELLS are coarsened conservatively (a
coarse cell is blocked if any 25 m cell in it is blocked). Node and time
budgets give an explicit SEARCH_LIMIT result instead of a fake route.

Airspace zones are evaluated for this flight (time, altitude, category) and
only obstacles are rasterised. Every returned segment is checked against the
exact obstacle polygons and the 25 m building raster. Avoiding the loaded zones
does not establish real-world flight legality.
"""

from __future__ import annotations

import math
import time
from collections import OrderedDict
from dataclasses import dataclass, field, replace
from datetime import datetime

import numpy as np
from shapely.geometry import LineString, Point

from app.airspace.evaluation import FlightContext, evaluate
from app.airspace.models import EvaluationStatus, ZoneConflict, ZoneEvaluation
from app.airspace.repository import AirspaceRepository, AirspaceState
from app.config import (
    AIRSPACE_NEAR_ROUTE_M,
    ROUTE_CACHE_SIZE,
    ROUTE_MARGIN_FACTOR,
    ROUTE_MARGIN_GROWTH,
    ROUTE_MAX_EXPANSIONS,
    ROUTE_MAX_FINE_CELLS,
    ROUTE_MIN_MARGIN_M,
    ROUTE_TIME_LIMIT_S,
)
from app.geo.coverage import Coverage
from app.routing import costs
from app.routing.astar import MOVES, SearchLimitExceeded, astar, smooth
from app.routing.costs import BLOCKED, FlightMode, RouteObjective
from app.routing.grid import Grid, lonlat_to_xy, pool_blocked, xy_to_lonlat
from app.schemas.planning import DroneProfile, RouteStatus, WeatherInfo
from app.services.weather import WindField

MIN_GROUND_SPEED_FACTOR = 0.3  # never assume less than 30 % of cruise speed


@dataclass
class SearchInfo:
    attempts: int = 0
    resolution_m: float = 0.0
    window_km2: float = 0.0
    expansions: int = 0
    whole_city: bool = False
    limited_by: str | None = None
    elapsed_ms: float = 0.0
    cached: bool = False


@dataclass
class PlanResult:
    status: RouteStatus
    message: str
    path_lonlat: list[tuple[float, float]] | None = None
    distance_m: float | None = None
    eta_s: float | None = None
    warnings: list[str] = field(default_factory=list)
    conflicts: list[ZoneConflict] = field(default_factory=list)
    airspace: AirspaceState | None = None
    search: SearchInfo | None = None
    start_district: str | None = None
    destination_district: str | None = None
    airspace_outside_extent_m: float = 0.0


def _fmt(lon: float, lat: float) -> str:
    return f"({lat:.5f}, {lon:.5f})"


@dataclass
class _Endpoint:
    cell: tuple[int, int]
    xy: tuple[float, float]
    snapped: bool
    snapped_from_building: bool


class RoutePlanner:
    def __init__(self, grid: Grid, airspace: AirspaceRepository, coverage: Coverage):
        self.grid = grid
        self.airspace = airspace
        self.coverage = coverage
        self._cost_cache: OrderedDict[tuple, np.ndarray] = OrderedDict()
        self._route_cache: OrderedDict[tuple, PlanResult] = OrderedDict()

    # --- cost model -----------------------------------------------------------
    def base_cost(self, mode: FlightMode, altitude_m: float, clearance_m: float,
                  objective: RouteObjective = RouteObjective.CORRIDORS) -> np.ndarray:
        g = self.grid
        if objective == RouteObjective.CORRIDORS:
            t = costs.TERRAIN_COSTS[mode]
            cost = np.full((g.rows, g.cols), t["open"], dtype=np.float32)
            cost[g.park] = t["park"]
            cost[g.river] = t["river"]
        else:  # SHORTEST / FASTEST: no terrain preference (FASTEST adds wind per move)
            cost = np.ones((g.rows, g.cols), dtype=np.float32)
        cost[g.building_height >= altitude_m - clearance_m] = BLOCKED
        cost[~g.coverage] = BLOCKED
        return cost

    def _costs(self, mode, altitude_m, clearance_m, state: AirspaceState, obstacles: list[int], objective):
        key = (mode, altitude_m, clearance_m, state.version, tuple(obstacles), objective)
        hit = self._cost_cache.get(key)
        if hit is not None:
            self._cost_cache.move_to_end(key)
            return hit
        base = self.base_cost(mode, altitude_m, clearance_m, objective)
        cost = base.copy()
        flat = cost.reshape(-1)
        for i in obstacles:
            flat[state.cells[i]] = BLOCKED
        self._cost_cache[key] = (base, cost)
        while len(self._cost_cache) > 6:
            self._cost_cache.popitem(last=False)
        return base, cost

    # --- planning -------------------------------------------------------------
    def plan(
        self,
        start: tuple[float, float],  # lon, lat
        destination: tuple[float, float],
        mode: FlightMode,
        altitude_m: int,
        profile: DroneProfile,
        weather: WeatherInfo,
        at: datetime,
        objective: RouteObjective = RouteObjective.CORRIDORS,
    ) -> PlanResult:
        state = self.airspace.refresh()
        key = (objective, start, destination, mode, altitude_m, profile.id, profile.vertical_clearance_m,
               profile.cruise_speed_mps, profile.max_wind_kmh,
               tuple((s.latitude, s.longitude, s.wind_speed_kmh, s.wind_direction_deg) for s in weather.samples),
               weather.wind_speed_kmh, weather.wind_direction_deg, weather.wind_gust_kmh,
               state.version, at.replace(second=0, microsecond=0))
        hit = self._route_cache.get(key)
        if hit is not None:
            self._route_cache.move_to_end(key)
            return replace(hit, search=replace(hit.search, cached=True) if hit.search else None)
        result = self._plan(start, destination, mode, altitude_m, profile, weather, at, state, objective)
        if result.status not in (RouteStatus.SEARCH_LIMIT, RouteStatus.COVERAGE_UNAVAILABLE):
            self._route_cache[key] = result
            while len(self._route_cache) > ROUTE_CACHE_SIZE:
                self._route_cache.popitem(last=False)
        return result

    def _plan(self, start, destination, mode, altitude_m, profile, weather, at, state, objective) -> PlanResult:
        t0 = time.perf_counter()
        ctx = FlightContext(altitude_agl_m=altitude_m, at=at, mode=mode)
        evals = state.evaluations(ctx)
        obstacles = [i for i, e in enumerate(evals) if e.is_obstacle]
        warnings: list[str] = []
        conflicts: list[ZoneConflict] = []
        districts = {"start_district": None, "destination_district": None}

        def result(status, message, **kw) -> PlanResult:
            return PlanResult(status, message, warnings=warnings, conflicts=conflicts, airspace=state,
                              **districts, **kw)

        if not self.coverage.available:
            return result(RouteStatus.COVERAGE_UNAVAILABLE, self.coverage.message)
        for label, (lon, lat) in (("Start", start), ("Destination", destination)):
            if not self.coverage.contains(lon, lat):
                return result(
                    RouteStatus.OUTSIDE_COVERAGE,
                    f"{label} point {_fmt(lon, lat)} is outside the supported area: {self.coverage.label}. "
                    "Choose a location inside the Warsaw boundary.",
                )
        districts = {"start_district": self.coverage.district_of(*start),
                     "destination_district": self.coverage.district_of(*destination)}
        for label, (lon, lat) in (("Start", start), ("Destination", destination)):
            blocked = self._endpoint_zone_check(label, lon, lat, state, ctx, warnings, conflicts)
            if blocked:
                status = RouteStatus.START_BLOCKED if label == "Start" else RouteStatus.DESTINATION_BLOCKED
                return result(status, blocked)

        wind = WindField(weather.samples) if weather.samples else None
        max_wind = max(weather.wind_speed_kmh, wind.max_speed if wind else 0.0)
        if max_wind > profile.max_wind_kmh:
            return result(
                RouteStatus.BLOCKED_WEATHER,
                f"Wind up to {max_wind:.0f} km/h along the route exceeds the {profile.name} limit of "
                f"{profile.max_wind_kmh:.0f} km/h. Flight not planned.",
            )
        gust = max(filter(None, [weather.wind_gust_kmh, wind.max_gust if wind else None]), default=None)
        if gust and gust > profile.max_wind_kmh:
            warnings.append(f"Gusts up to {gust:.0f} km/h exceed the profile limit of {profile.max_wind_kmh:.0f} km/h.")

        ceiling = altitude_m - profile.vertical_clearance_m
        base, cost = self._costs(mode, altitude_m, profile.vertical_clearance_m, state, obstacles, objective)
        s = self._resolve_endpoint("Start", *start, cost, base, ceiling, warnings)
        if isinstance(s, PlanResult):
            return result(s.status, s.message)
        d = self._resolve_endpoint("Destination", *destination, cost, base, ceiling, warnings)
        if isinstance(d, PlanResult):
            return result(d.status, d.message)

        direct = LineString([lonlat_to_xy(*start), lonlat_to_xy(*destination)])
        for i in state.zones_touching(direct):
            if i in obstacles:
                z = state.zones[i]
                conflicts.append(self._conflict(z, evals[i], "DIRECT_LINE_BLOCKED",
                                                f"The direct line crosses '{z.name}' ({z.dra_category}); "
                                                f"{evals[i].status.value.replace('_', ' ').lower()}."))

        search = SearchInfo()
        wind_model = self._wind_model(profile, weather, wind) if objective == RouteObjective.FASTEST else None
        if wind_model:
            min_cost = wind_model[1]
        elif objective == RouteObjective.CORRIDORS:
            min_cost = costs.min_cost(mode)
        else:
            min_cost = 1.0
        found = self._corridor_search(cost, s, d, min_cost, search, t0, wind_model)
        search.elapsed_ms = round((time.perf_counter() - t0) * 1000, 1)
        if isinstance(found, str):  # budget exhausted
            return result(RouteStatus.SEARCH_LIMIT,
                          f"Route could not be calculated within the supported limits ({found}). "
                          "No route is shown. Try closer points or retry.", search=search)
        if found is None:
            scope = "anywhere in the Warsaw coverage" if search.whole_city else "inside the search corridor"
            return result(
                RouteStatus.NO_ROUTE,
                f"No route found {scope} (searched at {search.resolution_m:.0f} m resolution): every path would "
                f"enter a blocked or unavailable airspace zone (incl. its {self.airspace.margin_m:.0f} m safety "
                f"margin) or fly over buildings at or above {ceiling:.0f} m ({altitude_m} m altitude − "
                f"{profile.vertical_clearance_m:.0f} m clearance). Try other points or another altitude.",
                search=search,
            )
        coarse, window, factor, cells = found

        hard = [state.geoms_m[i] for i in obstacles]
        line = self._safe_line(cells, coarse, window, factor, s, d, hard, base, ceiling)
        if line is None:  # never return a path that crosses an obstacle
            return result(RouteStatus.NO_ROUTE, "No route found that stays clear of all blocked zones and buildings.",
                          search=search)

        self._route_zone_notes(line, state, evals, obstacles, warnings, conflicts)
        outside = self._outside_airspace_extent(line, state, warnings)
        distance, eta = self._distance_and_eta(line, profile, weather, wind)
        if distance > profile.max_range_km * 1000:
            warnings.append(f"Route length {distance / 1000:.1f} km exceeds the {profile.name} range of "
                            f"{profile.max_range_km:.0f} km.")
        xs, ys = zip(*line.coords)
        lons, lats = xy_to_lonlat(np.array(xs), np.array(ys))
        path = [(round(float(lo), 6), round(float(la), 6)) for lo, la in zip(lons, lats)]
        avoided = sum(1 for c in conflicts if c.relation == "DIRECT_LINE_BLOCKED")
        label = {RouteObjective.CORRIDORS: "safe corridors", RouteObjective.SHORTEST: "shortest",
                 RouteObjective.FASTEST: "fastest, wind-aware"}[objective]
        msg = f"Route calculated ({label}, {mode.value}, {altitude_m} m)"
        msg += f", avoiding {avoided} blocked zone{'s' if avoided != 1 else ''} on the direct line." if avoided else "."
        search.elapsed_ms = round((time.perf_counter() - t0) * 1000, 1)
        return result(RouteStatus.OK, msg, path_lonlat=path, distance_m=round(distance, 1), eta_s=round(eta, 1),
                      search=search, airspace_outside_extent_m=round(outside, 1))

    # --- corridor search ----------------------------------------------------------
    # --- FASTEST: direction-dependent time cost -----------------------------------
    @staticmethod
    def _time_factor(v: float, speed_kmh: float, direction_deg: float, ux: float, uy: float) -> float:
        """Seconds per metre relative to still-air cruise (v / ground speed)."""
        w = speed_kmh / 3.6
        to_rad = math.radians((direction_deg + 180.0) % 360.0)
        wx, wy = w * math.sin(to_rad), w * math.cos(to_rad)
        along = wx * ux + wy * uy
        cross = abs(wx * uy - wy * ux)
        ground = max(math.sqrt(max(v * v - cross * cross, 0.0)) + along, v * MIN_GROUND_SPEED_FACTOR)
        return v / ground

    def _wind_model(self, profile, weather, wind):
        """(sample xy list, smallest factor, table[sample][move]) for wind-aware A*."""
        samples = wind.samples if wind else []
        winds = [(s.wind_speed_kmh, s.wind_direction_deg) for s in samples]
        if not winds:
            winds = [(weather.wind_speed_kmh, weather.wind_direction_deg)]
        xy = [lonlat_to_xy(s.longitude, s.latitude) for s in samples] or [(0.0, 0.0)]
        v = profile.cruise_speed_mps
        table = []
        for speed, direction in winds:
            # Grid rows grow north (y), columns grow east (x).
            table.append([self._time_factor(v, speed, direction, dc / ln, dr / ln) for dr, dc, ln in MOVES])
        return xy, min(min(r) for r in table), table

    def _move_cost(self, wind_model, window, factor, shape):
        xy, _, table = wind_model
        g = self.grid
        (r0, c0), (rows, cols) = window, shape
        xs = g.min_x + (c0 + (np.arange(cols) + 0.5) * factor) * g.cell
        ys = g.min_y + (r0 + (np.arange(rows) + 0.5) * factor) * g.cell
        gx, gy = np.meshgrid(xs, ys)
        pts = np.array(xy)
        d2 = (gx[..., None] - pts[:, 0]) ** 2 + (gy[..., None] - pts[:, 1]) ** 2
        return np.argmin(d2, axis=-1).ravel().tolist(), table

    def _corridor_search(self, cost, s: _Endpoint, d: _Endpoint, min_cost, search: SearchInfo, t0: float,
                         wind_model=None):
        """Returns (coarse_cost, window, factor, coarse_path), None (proven: no path
        in the whole coverage at the final resolution) or a str (budget exhausted)."""
        g = self.grid
        (sr, sc), (dr, dc) = s.cell, d.cell
        margin = max(ROUTE_MIN_MARGIN_M, ROUTE_MARGIN_FACTOR * math.hypot(sr - dr, sc - dc) * g.cell) / g.cell
        while True:
            search.attempts += 1
            m = int(math.ceil(margin))
            r0, r1 = max(0, min(sr, dr) - m), min(g.rows, max(sr, dr) + m + 1)
            c0, c1 = max(0, min(sc, dc) - m), min(g.cols, max(sc, dc) + m + 1)
            whole = r0 == 0 and c0 == 0 and r1 == g.rows and c1 == g.cols
            sub = cost[r0:r1, c0:c1]
            factor = 1 if sub.size <= ROUTE_MAX_FINE_CELLS else math.ceil(math.sqrt(sub.size / ROUTE_MAX_FINE_CELLS))
            coarse = pool_blocked(sub, factor)
            search.resolution_m = g.cell * factor
            search.window_km2 = round(sub.size * g.cell * g.cell / 1e6, 1)
            search.whole_city = whole
            cs = self._coarse_endpoint(coarse, ((sr - r0) // factor, (sc - c0) // factor), factor)
            cd = self._coarse_endpoint(coarse, ((dr - r0) // factor, (dc - c0) // factor), factor)
            path = None
            if cs and cd:
                remaining = ROUTE_TIME_LIMIT_S - (time.perf_counter() - t0)
                if remaining <= 0:
                    search.limited_by = f"time limit of {ROUTE_TIME_LIMIT_S:.0f} s reached"
                    return search.limited_by
                stats: dict = {}
                move_cost = self._move_cost(wind_model, (r0, c0), factor, coarse.shape) if wind_model else None
                try:
                    path = astar(coarse, cs, cd, min_cost, ROUTE_MAX_EXPANSIONS, remaining, stats, move_cost)
                except SearchLimitExceeded as exc:
                    search.expansions += exc.expansions
                    search.limited_by = exc.reason
                    return exc.reason
                search.expansions += stats.get("expansions", 0)
            if path:
                return coarse, (r0, c0), factor, path
            if whole:
                return None
            margin *= ROUTE_MARGIN_GROWTH

    def _coarse_endpoint(self, coarse, cell, factor):
        r, c = cell
        if 0 <= r < coarse.shape[0] and 0 <= c < coarse.shape[1] and math.isfinite(coarse[r, c]):
            return (r, c)
        radius = max(1, int(math.ceil(costs.SNAP_RADIUS_M / (self.grid.cell * factor))))
        best, best_d = None, math.inf
        for rr in range(max(0, r - radius), min(coarse.shape[0], r + radius + 1)):
            for cc in range(max(0, c - radius), min(coarse.shape[1], c + radius + 1)):
                dd = (rr - r) ** 2 + (cc - c) ** 2
                if dd < best_d and math.isfinite(coarse[rr, cc]):
                    best, best_d = (rr, cc), dd
        return best

    # --- zones ----------------------------------------------------------------
    @staticmethod
    def _conflict(zone, ev: ZoneEvaluation, relation, message) -> ZoneConflict:
        return ZoneConflict(
            zone_id=zone.id, name=zone.name, dra_category=zone.dra_category, display_class=ev.display_class,
            evaluation_status=ev.status, relation=relation, message=message,
        )

    def _endpoint_zone_check(self, label, lon, lat, state, ctx, warnings, conflicts) -> str | None:
        """Error message if the point lies inside a zone that blocks take-off/landing.
        Points are never moved out of a zone."""
        p = Point(lonlat_to_xy(lon, lat))
        for i in state.zones_touching(p):
            z = state.zones[i]
            ev = evaluate(z, ctx, endpoint=True)
            if ev.is_obstacle:
                rel = "START_INSIDE" if label == "Start" else "DESTINATION_INSIDE"
                msg = (f"{label} point {_fmt(lon, lat)} lies inside '{z.name}' ({z.dra_category}). "
                       f"{ev.reasons[-1]} A drone may not take off or land there; choose another point.")
                conflicts.append(self._conflict(z, ev, rel, msg))
                return msg
            if ev.status == EvaluationStatus.INFORMATION:
                warnings.append(f"{label} point is inside information zone '{z.name}': "
                                f"{z.operational_conditions or 'see zone details'}")
        return None

    def _route_zone_notes(self, line, state, evals, obstacles, warnings, conflicts) -> None:
        for i in state.zones_touching(line):
            if i in obstacles:
                continue
            z, ev = state.zones[i], evals[i]
            if ev.status == EvaluationStatus.INFORMATION:
                msg = f"Route crosses information zone '{z.name}' ({z.dra_category}): {z.operational_conditions or 'see zone details'}"
                conflicts.append(self._conflict(z, ev, "ROUTE_CROSSES_INFO", msg))
                warnings.append(msg)
        near = line.buffer(AIRSPACE_NEAR_ROUTE_M)
        for i in state.zones_touching(near):
            if i in obstacles and not any(c.zone_id == state.zones[i].id and c.relation != "DIRECT_LINE_BLOCKED" for c in conflicts):
                z = state.zones[i]
                d = line.distance(state.geoms_m[i])
                conflicts.append(self._conflict(z, evals[i], "NEAR_ROUTE",
                                                f"Route passes {d:.0f} m from blocked zone '{z.name}' ({z.dra_category})."))

    @staticmethod
    def _outside_airspace_extent(line, state: AirspaceState, warnings) -> float:
        """Length of route outside the area the loaded zone dataset covers."""
        if state.extent_m is None:
            return 0.0
        outside = line.difference(state.extent_m).length
        if outside > 1.0:
            warnings.append(
                f"{outside / 1000:.1f} km of this route lies outside the extent of the loaded airspace dataset "
                f"({state.dataset.label}): zones there are not loaded and were NOT checked."
            )
        return outside

    # --- endpoints ------------------------------------------------------------
    def _resolve_endpoint(self, label, lon, lat, cost, base, ceiling, warnings) -> _Endpoint | PlanResult:
        blocked_status = RouteStatus.START_BLOCKED if label == "Start" else RouteStatus.DESTINATION_BLOCKED
        x, y = lonlat_to_xy(lon, lat)
        cell = self.grid.cell_of(x, y)
        if cell and math.isfinite(cost[cell]):
            return _Endpoint(cell, (x, y), False, False)
        from_building = cell is not None and not math.isfinite(base[cell])
        nearest = self._nearest_free(x, y, cost)
        if nearest is None:
            return PlanResult(
                blocked_status,
                f"{label} point {_fmt(lon, lat)} is blocked: no flyable cell within {costs.SNAP_RADIUS_M:.0f} m "
                f"(buildings at or above {ceiling:.0f} m, zone safety margins or the city edge). "
                "Raise the flight altitude or choose another location.",
            )
        cx, cy = self.grid.centre(*nearest)
        reason = ("is at a building at or above the flight ceiling" if from_building
                  else f"is within the {self.airspace.margin_m:.0f} m safety margin of a blocked zone")
        warnings.append(f"{label} point {reason}; the route joins the nearest flyable cell "
                        f"{math.hypot(cx - x, cy - y):.0f} m away.")
        return _Endpoint(nearest, (x, y), True, from_building)

    def _nearest_free(self, x: float, y: float, cost: np.ndarray) -> tuple[int, int] | None:
        g = self.grid
        radius = int(math.ceil(costs.SNAP_RADIUS_M / g.cell))
        col0 = math.floor((x - g.min_x) / g.cell)
        row0 = math.floor((y - g.min_y) / g.cell)
        best, best_d = None, math.inf
        for r in range(max(0, row0 - radius), min(g.rows, row0 + radius + 1)):
            for c in range(max(0, col0 - radius), min(g.cols, col0 + radius + 1)):
                if not math.isfinite(cost[r, c]):
                    continue
                cx, cy = g.centre(r, c)
                dist = math.hypot(cx - x, cy - y)
                if dist < best_d and dist <= costs.SNAP_RADIUS_M:
                    best, best_d = (r, c), dist
        return best

    # --- geometry checks ---------------------------------------------------------
    def _coarse_centre(self, window, factor, cell) -> tuple[float, float]:
        (r0, c0), (r, c) = window, cell
        g = self.grid
        return g.min_x + (c0 + c * factor + factor / 2) * g.cell, g.min_y + (r0 + r * factor + factor / 2) * g.cell

    def _clear_of_buildings(self, line: LineString, base: np.ndarray) -> bool:
        """Hard check on the 25 m raster: no sampled cell may be blocked by a
        building (or lie outside coverage)."""
        g = self.grid
        n = max(2, int(line.length / (g.cell / 3)) + 1)
        for i in range(n):
            p = line.interpolate(i / (n - 1), normalized=True)
            rc = g.cell_of(p.x, p.y)
            if rc is None or not math.isfinite(base[rc]):
                return False
        return True

    def _safe_line(self, cells, coarse, window, factor, s: _Endpoint, d: _Endpoint, hard, base, ceiling):
        """Smoothed line from the exact selected points where possible. Each
        candidate must clear the exact obstacle polygons and the building raster;
        the first clean one wins, otherwise None."""

        def own(e: _Endpoint) -> tuple[int, int]:
            return ((e.cell[0] - window[0]) // factor, (e.cell[1] - window[1]) // factor)

        def clean(line: LineString) -> bool:
            if any(line.intersects(gm) for gm in hard):
                return False
            # A route snapped off a building starts/ends at the snapped cell, so
            # the whole line must be building-clear.
            return self._clear_of_buildings(line, base)

        for variant in (smooth(coarse, cells, costs.SMOOTHING_COST_TOLERANCE), cells):
            pts = [self._coarse_centre(window, factor, c) for c in variant]
            exact = list(pts)
            # Exact endpoints when the selected point is flyable: it replaces the
            # centre of its own cell, otherwise (snapped out of a zone margin) it
            # is joined to the path.
            if not s.snapped or not s.snapped_from_building:
                if variant[0] == own(s):
                    exact[0] = s.xy
                else:
                    exact.insert(0, s.xy)
            if not d.snapped or not d.snapped_from_building:
                if variant[-1] == own(d):
                    exact[-1] = d.xy
                else:
                    exact.append(d.xy)
            for coords in (exact, pts):
                if len(coords) == 1:
                    coords = coords * 2
                line = LineString(coords)
                if clean(line):
                    return line
        return None

    @staticmethod
    def _distance_and_eta(line: LineString, profile: DroneProfile, weather: WeatherInfo,
                          wind: WindField | None) -> tuple[float, float]:
        """Per segment: crab into the crosswind and add the head/tailwind component,
        using the nearest wind sample to the segment's midpoint."""
        v = profile.cruise_speed_mps
        distance = eta = 0.0
        coords = list(line.coords)
        for (x0, y0), (x1, y1) in zip(coords, coords[1:]):
            seg = math.hypot(x1 - x0, y1 - y0)
            if seg == 0:
                continue
            if wind is not None:
                mlon, mlat = xy_to_lonlat((x0 + x1) / 2, (y0 + y1) / 2)
                sample = wind.at(float(mlon), float(mlat))
                speed_kmh, direction = sample.wind_speed_kmh, sample.wind_direction_deg
            else:
                speed_kmh, direction = weather.wind_speed_kmh, weather.wind_direction_deg
            w = speed_kmh / 3.6
            to_rad = math.radians((direction + 180.0) % 360.0)  # direction the wind blows TO
            wx, wy = w * math.sin(to_rad), w * math.cos(to_rad)  # x east, y north
            ux, uy = (x1 - x0) / seg, (y1 - y0) / seg
            along = wx * ux + wy * uy
            cross = abs(wx * uy - wy * ux)
            ground = max(math.sqrt(max(v * v - cross * cross, 0.0)) + along, v * MIN_GROUND_SPEED_FACTOR)
            distance += seg
            eta += seg / ground
        return distance, eta


def plan_timed(planner: RoutePlanner, *args) -> tuple[PlanResult, float]:
    t0 = time.perf_counter()
    result = planner.plan(*args)
    return result, (time.perf_counter() - t0) * 1000
