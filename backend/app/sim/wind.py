"""Simulation wind: scenario wind (or the DEMO weather), changed by events, optional seeded gusts."""

from __future__ import annotations

import random

from app.schemas.planning import WeatherInfo, WeatherMode, WeatherSource


class SimWind:
    def __init__(self, speed_kmh: float, direction_deg: float, gust_std_kmh: float, rng: random.Random):
        self.base_speed_kmh = speed_kmh
        self.direction_deg = direction_deg
        self.gust_std_kmh = gust_std_kmh
        self._rng = rng
        self.current_speed_kmh = speed_kmh

    def set(self, speed_kmh: float, direction_deg: float) -> None:
        self.base_speed_kmh, self.direction_deg = speed_kmh, direction_deg
        self.current_speed_kmh = speed_kmh

    def draw(self) -> None:
        """Once per tick: the gusty speed for this tick (no draw at all when gusts are off)."""
        if self.gust_std_kmh > 0:
            self.current_speed_kmh = max(0.0, self._rng.gauss(self.base_speed_kmh, self.gust_std_kmh))
        else:
            self.current_speed_kmh = self.base_speed_kmh

    def at(self, x: float, y: float) -> tuple[float, float]:
        """Wind felt by a drone this tick (uniform in space)."""
        return self.current_speed_kmh, self.direction_deg

    def weather(self, altitude_m: float) -> WeatherInfo:
        """What the planner plans with: the steady wind, without gust noise."""
        return WeatherInfo(
            mode=WeatherMode.DEMO,
            source=WeatherSource.DEMO,
            wind_speed_kmh=self.base_speed_kmh,
            wind_direction_deg=self.direction_deg,
            altitude_m=altitude_m,
            samples=[],
            message="Simulation wind (scenario or DEMO value; no network).",
        )

    def snapshot(self) -> dict:
        return {"speedKmh": round(self.current_speed_kmh, 2), "baseSpeedKmh": round(self.base_speed_kmh, 2),
                "directionDeg": round(self.direction_deg, 1)}
