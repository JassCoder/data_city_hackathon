"""Turns a route request into a flight path on the rasterised grid.

Airspace zones are evaluated for this specific flight (time, altitude, category)
and only the resulting obstacles are rasterised into the cost array. Avoiding
the loaded zones does not establish real-world flight legality.
"""

from __future__ import annotations

import math
import time
from dataclasses import dataclass, field
from datetime import datetime

import numpy as np
from shapely.geometry import LineString, Point

from app.airspace.evaluation import FlightContext, evaluate
from app.airspace.models import EvaluationStatus, ZoneConflict, ZoneEvaluation
from app.airspace.repository import AirspaceRepository, AirspaceState
from app.config import AIRSPACE_NEAR_ROUTE_M, COVERAGE_LABEL, DEMO_BBOX
from app.routing import costs
from app.routing.astar import astar, smooth
from app.routing.costs import BLOCKED, FlightMode
from app.routing.grid import Grid, lonlat_to_xy, xy_to_lonlat
from app.schemas.planning import DroneProfile, RouteStatus, WeatherInfo
from app.services.geocoding import in_coverage

MIN_GROUND_SPEED_FACTOR = 0.3  # never assume less than 30 % of cruise speed


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


def _fmt(lon: float, lat: float) -> str:
    return f"({lat:.5f}, {lon:.5f})"


@dataclass
class _Endpoint:
    cell: tuple[int, int]
    xy: tuple[float, float]
    snapped: bool
    snapped_from_building: bool


class RoutePlanner:
    def __init__(self, grid: Grid, airspace: AirspaceRepository, bbox: dict[str, float] = DEMO_BBOX):
        self.grid = grid
        self.airspace = airspace
        self.bbox = bbox

    # --- cost model -----------------------------------------------------------
    def base_cost(self, mode: FlightMode, altitude_m: float, clearance_m: float) -> np.ndarray:
        g = self.grid
        t = costs.TERRAIN_COSTS[mode]
        cost = np.full((g.rows, g.cols), t["open"], dtype=np.float64)
        cost[g.park] = t["park"]
        cost[g.river] = t["river"]
        cost[g.building_height >= altitude_m - clearance_m] = BLOCKED
        cost[~g.coverage] = BLOCKED
        return cost

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
    ) -> PlanResult:
        state = self.airspace.refresh()
        ctx = FlightContext(altitude_agl_m=altitude_m, at=at, mode=mode)
        evals = state.evaluations(ctx)
        obstacles = [i for i, e in enumerate(evals) if e.is_obstacle]
        warnings: list[str] = []
        conflicts: list[ZoneConflict] = []

        def result(status, message, **kw) -> PlanResult:
            return PlanResult(status, message, warnings=warnings, conflicts=conflicts, airspace=state, **kw)

        # Coverage first, then endpoints inside zones: both fail before weather.
        for label, (lon, lat) in (("Start", start), ("Destination", destination)):
            if not in_coverage(lat, lon, self.bbox):
                return result(
                    RouteStatus.OUTSIDE_COVERAGE,
                    f"{label} point {_fmt(lon, lat)} is outside the supported routing area: {COVERAGE_LABEL}. "
                    "Choose a location inside the dashed demo area.",
                )
        for label, (lon, lat) in (("Start", start), ("Destination", destination)):
            blocked = self._endpoint_zone_check(label, lon, lat, state, ctx, warnings, conflicts)
            if blocked:
                status = RouteStatus.START_BLOCKED if label == "Start" else RouteStatus.DESTINATION_BLOCKED
                return result(status, blocked)

        if weather.wind_speed_kmh > profile.max_wind_kmh:
            return result(
                RouteStatus.BLOCKED_WEATHER,
                f"Wind {weather.wind_speed_kmh:.0f} km/h exceeds the {profile.name} limit of "
                f"{profile.max_wind_kmh:.0f} km/h. Flight not planned.",
            )
        if weather.wind_gust_kmh and weather.wind_gust_kmh > profile.max_wind_kmh:
            warnings.append(
                f"Gusts up to {weather.wind_gust_kmh:.0f} km/h exceed the profile limit of "
                f"{profile.max_wind_kmh:.0f} km/h."
            )

        ceiling = altitude_m - profile.vertical_clearance_m
        base = self.base_cost(mode, altitude_m, profile.vertical_clearance_m)
        cost = base.copy()
        flat = cost.reshape(-1)
        for i in obstacles:
            flat[state.cells[i]] = BLOCKED

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

        cells = astar(cost, s.cell, d.cell, costs.min_cost(mode))
        if cells is None:
            return result(
                RouteStatus.NO_ROUTE,
                "No route found: every path would enter a blocked or unavailable airspace zone "
                f"(incl. its {self.airspace.margin_m:.0f} m safety margin) or fly over buildings at or above "
                f"{ceiling:.0f} m ({altitude_m} m altitude − {profile.vertical_clearance_m:.0f} m clearance). "
                "Try other points or another altitude.",
            )

        hard = [state.geoms_m[i] for i in obstacles]
        line = self._safe_line(cells, cost, s, d, hard)
        if line is None:  # never return a path that crosses an obstacle zone
            return result(RouteStatus.NO_ROUTE, "No route found that stays clear of all blocked airspace zones.")

        self._route_zone_notes(line, state, evals, obstacles, warnings, conflicts)
        distance, eta = self._distance_and_eta(line, profile, weather)
        if distance > profile.max_range_km * 1000:
            warnings.append(
                f"Route length {distance / 1000:.1f} km exceeds the {profile.name} range of "
                f"{profile.max_range_km:.0f} km."
            )
        xs, ys = zip(*line.coords)
        lons, lats = xy_to_lonlat(np.array(xs), np.array(ys))
        path = [(round(float(lo), 6), round(float(la), 6)) for lo, la in zip(lons, lats)]
        avoided = sum(1 for c in conflicts if c.relation == "DIRECT_LINE_BLOCKED")
        msg = f"Route calculated ({mode.value}, {altitude_m} m)"
        msg += f", avoiding {avoided} blocked zone{'s' if avoided != 1 else ''} on the direct line." if avoided else "."
        return result(RouteStatus.OK, msg, path_lonlat=path, distance_m=round(distance, 1), eta_s=round(eta, 1))

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
                f"(buildings at or above {ceiling:.0f} m or zone safety margins). "
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

    def _safe_line(self, cells, cost, s: _Endpoint, d: _Endpoint, hard) -> LineString | None:
        """Smoothed line from the exact selected points where possible. Every
        candidate is checked against the exact obstacle polygons; the first
        clean one wins, otherwise None."""

        def crosses(line: LineString) -> bool:
            return any(line.intersects(g) for g in hard)

        for variant in (smooth(cost, cells, costs.SMOOTHING_COST_TOLERANCE), cells):
            pts = [self.grid.centre(r, c) for r, c in variant]
            # Exact endpoints: replace the cell centre when not snapped; when snapped
            # out of a zone margin, prepend the selected point (it is outside the zone).
            exact = list(pts)
            if not s.snapped:
                exact[0] = s.xy
            elif not s.snapped_from_building:
                exact.insert(0, s.xy)
            if not d.snapped:
                exact[-1] = d.xy
            elif not d.snapped_from_building:
                exact.append(d.xy)
            for coords in (exact, pts):
                if len(coords) == 1:
                    coords = coords * 2
                line = LineString(coords)
                if not crosses(line):
                    return line
        return None

    @staticmethod
    def _distance_and_eta(line: LineString, profile: DroneProfile, weather: WeatherInfo) -> tuple[float, float]:
        v = profile.cruise_speed_mps
        wind = weather.wind_speed_kmh / 3.6
        to_rad = math.radians((weather.wind_direction_deg + 180.0) % 360.0)  # direction wind blows TO
        wx, wy = wind * math.sin(to_rad), wind * math.cos(to_rad)  # x east, y north
        distance = eta = 0.0
        coords = list(line.coords)
        for (x0, y0), (x1, y1) in zip(coords, coords[1:]):
            seg = math.hypot(x1 - x0, y1 - y0)
            if seg == 0:
                continue
            ux, uy = (x1 - x0) / seg, (y1 - y0) / seg
            along = wx * ux + wy * uy
            cross = abs(wx * uy - wy * ux)
            # Crab into the crosswind, then add the head/tailwind component.
            ground = math.sqrt(max(v * v - cross * cross, 0.0)) + along
            ground = max(ground, v * MIN_GROUND_SPEED_FACTOR)
            distance += seg
            eta += seg / ground
        return distance, eta


def plan_timed(planner: RoutePlanner, *args) -> tuple[PlanResult, float]:
    t0 = time.perf_counter()
    result = planner.plan(*args)
    return result, (time.perf_counter() - t0) * 1000
