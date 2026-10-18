"""Direction-dependent energy and time costs from wind, speed and payload.

Model (a deliberately simple DEMO assumption, documented so it can be replaced):
the drone holds its cruise airspeed v and draws electrical power
P = cruisePowerW + payloadPowerWPerKg * payload. Wind changes only the ground
speed g (wind triangle: crab into the crosswind, add the along-track
component), so energy per metre over ground is P / g and time per metre 1 / g.
A headwind lowers g and costs more; a tailwind raises g and costs less.

Normalisation: each term is divided by its worst case that the hard
constraints still allow (maximum payload, a headwind at the drone's wind
limit), so values lie in (0, 1] without clipping. Stronger winds than that
never reach the cost model: they block the flight (BLOCKED_WEATHER).
"""

from __future__ import annotations

import math
from collections.abc import Sequence
from dataclasses import dataclass

from app.routing.costs import MIN_GROUND_SPEED_FACTOR
from app.routing.risk.config import Weights
from app.routing.risk.providers import WindVector

Move = tuple[int, int, float]  # (d_row = north, d_col = east, length in cells)


@dataclass(frozen=True)
class DroneEnergy:
    cruise_speed_mps: float
    cruise_power_w: float  # electrical power at cruise without payload
    payload_power_w_per_kg: float  # extra power per kg of payload
    battery_wh: float
    max_wind_kmh: float
    max_payload_kg: float

    def power_w(self, payload_kg: float) -> float:
        return self.cruise_power_w + self.payload_power_w_per_kg * payload_kg

    def usable_wh(self, reserve_fraction: float) -> float:
        return self.battery_wh * (1.0 - reserve_fraction)


def wind_vector_to(speed_kmh: float, from_deg: float) -> tuple[float, float]:
    """(east, north) wind velocity in m/s; meteorological direction is where it blows FROM."""
    w = speed_kmh / 3.6
    to_rad = math.radians((from_deg + 180.0) % 360.0)
    return w * math.sin(to_rad), w * math.cos(to_rad)


def ground_speed(v: float, speed_kmh: float, from_deg: float, ux: float, uy: float) -> float:
    """Ground speed (m/s) along unit heading (ux east, uy north) at airspeed v."""
    wx, wy = wind_vector_to(speed_kmh, from_deg)
    along = wx * ux + wy * uy
    cross = abs(wx * uy - wy * ux)
    return max(math.sqrt(max(v * v - cross * cross, 0.0)) + along, v * MIN_GROUND_SPEED_FACTOR)


def worst_ground_speed(drone: DroneEnergy) -> float:
    """A pure headwind at the wind limit is the slowest case (for wind < v the
    wind triangle's minimum is head-on; the floor covers stronger winds)."""
    v = drone.cruise_speed_mps
    return max(v - drone.max_wind_kmh / 3.6, v * MIN_GROUND_SPEED_FACTOR)


def energy_j_per_m(drone: DroneEnergy, payload_kg: float, ground_mps: float) -> float:
    return drone.power_w(payload_kg) / ground_mps


def energy_term(drone: DroneEnergy, payload_kg: float, ground_mps: float) -> float:
    worst = energy_j_per_m(drone, drone.max_payload_kg, worst_ground_speed(drone))
    return energy_j_per_m(drone, payload_kg, ground_mps) / worst


def time_term(drone: DroneEnergy, ground_mps: float) -> float:
    return worst_ground_speed(drone) / ground_mps


def unit_heading(move: Move) -> tuple[float, float]:
    dr, dc, ln = move
    return dc / ln, dr / ln  # grid columns grow east, rows grow north


def direction_table(drone: DroneEnergy, payload_kg: float, samples: Sequence[WindVector],
                    moves: Sequence[Move], weights: Weights) -> list[list[float]]:
    """table[sample][move] = weighted energy + time cost per metre for that heading."""
    table = []
    for s in samples:
        row = []
        for move in moves:
            g = ground_speed(drone.cruise_speed_mps, s.speed_kmh, s.direction_deg, *unit_heading(move))
            row.append(weights.energy * energy_term(drone, payload_kg, g) + weights.time * time_term(drone, g))
        table.append(row)
    return table
