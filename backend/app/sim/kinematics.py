"""Movement along a route polyline and the energy it takes.

A leg is the planner's lon/lat polyline converted to metres (EPSG:2180, the
planner's projection) with cumulative distances. Each tick the drone advances by
ground speed x dt along it (never jumping between vertices). Ground speed and
power come from the planner's energy model (app/routing/risk/energy.py), so the
energy of a simulated cruise equals the energy the planner reported for it.
"""

from __future__ import annotations

import bisect
import math
from collections.abc import Callable, Sequence
from dataclasses import dataclass

from app.routing.grid import lonlat_to_xy, xy_to_lonlat
from app.routing.risk.energy import DroneEnergy, ground_speed, landing_energy_wh

XY = tuple[float, float]
LonLat = tuple[float, float]
#: Wind at a metric position: (speed km/h, meteorological from-direction deg).
WindAt = Callable[[float, float], tuple[float, float]]


@dataclass
class Leg:
    """A polyline being flown, the progress along it, and what it is for."""

    kind: str  # "outbound" | "return" | "divert" | "emergency"
    target: str  # human-readable destination (station name, "Point B", ...)
    points: list[XY]
    cum: list[float]  # cumulative distance at each vertex, cum[0] == 0
    progress_m: float = 0.0
    planned_energy_wh: float | None = None  # cruise energy the planner reported for this leg
    lonlat: list[LonLat] | None = None  # the same vertices in WGS84 (for the true heading)
    id: str = ""  # unique within a run (the engine numbers legs), so clients can cache the geometry

    @classmethod
    def from_lonlat(cls, kind: str, target: str, path: Sequence[LonLat], planned_energy_wh: float | None = None,
                    leg_id: str = "") -> Leg:
        pts = [lonlat_to_xy(lon, lat) for lon, lat in path]
        if len(pts) == 1:
            pts = pts * 2
        cum = [0.0]
        for (x0, y0), (x1, y1) in zip(pts, pts[1:]):
            cum.append(cum[-1] + math.hypot(x1 - x0, y1 - y0))
        lonlat = list(path) if len(path) > 1 else list(path) * 2
        return cls(kind, target, pts, cum, 0.0, planned_energy_wh, lonlat, leg_id)

    @property
    def length_m(self) -> float:
        return self.cum[-1]

    @property
    def remaining_m(self) -> float:
        return max(0.0, self.length_m - self.progress_m)

    @property
    def done(self) -> bool:
        return self.remaining_m <= 1e-6

    def _segment(self, d: float) -> int:
        """Index i of the segment [i, i+1] that contains distance d."""
        i = bisect.bisect_right(self.cum, d) - 1
        return min(max(i, 0), len(self.points) - 2)

    def heading_at(self, d: float) -> tuple[float, float, float]:
        """(unit east, unit north) of the segment at distance d in the planner's metric grid
        (used in the wind triangle exactly as the planner does; grid north is ~1.6 deg off true
        north in Warsaw) and the TRUE heading in degrees clockwise from north (for display)."""
        i = self._segment(d)
        (x0, y0), (x1, y1) = self.points[i], self.points[i + 1]
        seg = math.hypot(x1 - x0, y1 - y0)
        if seg == 0:
            return 0.0, 1.0, 0.0
        ux, uy = (x1 - x0) / seg, (y1 - y0) / seg
        if self.lonlat:
            (lon0, lat0), (lon1, lat1) = self.lonlat[i], self.lonlat[i + 1]
            east = (lon1 - lon0) * math.cos(math.radians((lat0 + lat1) / 2))
            heading = math.degrees(math.atan2(east, lat1 - lat0)) % 360
        else:
            heading = math.degrees(math.atan2(ux, uy)) % 360
        return ux, uy, heading

    def xy_at(self, d: float) -> XY:
        d = min(max(d, 0.0), self.length_m)
        i = self._segment(d)
        (x0, y0), (x1, y1) = self.points[i], self.points[i + 1]
        seg = self.cum[i + 1] - self.cum[i]
        t = (d - self.cum[i]) / seg if seg else 0.0
        return x0 + (x1 - x0) * t, y0 + (y1 - y0) * t

    def lonlat_at(self, d: float) -> LonLat:
        x, y = self.xy_at(d)
        lon, lat = xy_to_lonlat(x, y)
        return float(lon), float(lat)

    def advance(self, distance_m: float) -> float:
        """Moves forward (never past the end); returns the distance actually travelled."""
        step = min(max(distance_m, 0.0), self.remaining_m)
        self.progress_m += step
        return step

    def remaining_path(self) -> list[LonLat]:
        """Current position followed by the vertices still ahead (for replanning)."""
        i = self._segment(self.progress_m)
        ahead = [xy_to_lonlat(*p) for p in self.points[i + 1:]]
        return [self.lonlat_at(self.progress_m)] + [(float(a), float(b)) for a, b in ahead]

    def snapshot(self) -> dict:
        return {"id": self.id, "kind": self.kind, "target": self.target, "lengthM": round(self.length_m, 1),
                "progressM": round(self.progress_m, 1), "remainingM": round(self.remaining_m, 1)}

    def geometry(self) -> dict:
        """The polyline ([lon, lat], like GeoJSON) with the cumulative distance at each vertex in the
        planner's metric frame, so a client can split it at progressM exactly as the engine does."""
        path = self.lonlat or [xy_to_lonlat(*p) for p in self.points]
        return {"id": self.id, "kind": self.kind, "target": self.target,
                "path": [[round(float(lon), 6), round(float(lat), 6)] for lon, lat in path],
                "cumM": [round(c, 1) for c in self.cum]}


def cruise_step(drone: DroneEnergy, payload_kg: float, leg: Leg, wind_at: WindAt, dt_s: float) -> tuple[float, float, float]:
    """Flies one tick along the leg at cruise airspeed.

    Returns (distance moved m, energy used Wh, ground speed m/s). The drone draws
    cruise power for the time it flies; a headwind lowers the ground speed, so the
    same distance takes longer and costs more energy.
    """
    ux, uy, _ = leg.heading_at(leg.progress_m)
    x, y = leg.xy_at(leg.progress_m)
    speed, direction = wind_at(x, y)
    g = ground_speed(drone.cruise_speed_mps, speed, direction, ux, uy)
    moved = leg.advance(g * dt_s)
    flown_s = moved / g if g else dt_s
    return moved, drone.power_w(payload_kg) * flown_s / 3600, g


def leg_energy_wh(drone: DroneEnergy, payload_kg: float, leg: Leg, wind_at: WindAt, from_m: float | None = None) -> float:
    """Cruise energy for the rest of the leg (segment by segment, wind at each segment's midpoint)."""
    start = leg.progress_m if from_m is None else from_m
    total = 0.0
    for i in range(len(leg.points) - 1):
        a, b = leg.cum[i], leg.cum[i + 1]
        if b <= start or b == a:
            continue
        lo = max(a, start)
        ux, uy, _ = leg.heading_at((lo + b) / 2)
        speed, direction = wind_at(*leg.xy_at((lo + b) / 2))
        g = ground_speed(drone.cruise_speed_mps, speed, direction, ux, uy)
        total += drone.power_w(payload_kg) * (b - lo) / g
    return total / 3600


def energy_to_finish_wh(drone: DroneEnergy, payload_kg: float, leg: Leg, wind_at: WindAt, altitude_m: float) -> float:
    """What the drone still needs for this leg: the rest of the cruise plus the landing descent."""
    return leg_energy_wh(drone, payload_kg, leg, wind_at) + landing_energy_wh(drone, payload_kg, altitude_m)
