"""What a simulation runs against: the planner, drone profiles, landing stations, config.

Production loads everything from data/ (no network). Tests inject a small
synthetic world (tests/conftest.py: make_sim_world).
"""

from __future__ import annotations

import json
import math
from dataclasses import dataclass
from pathlib import Path

from app.airspace.factory import make_provider
from app.airspace.repository import AirspaceRepository
from app.config import DATA_DIR, DATA_FILES, SIM_CONFIG_FILE
from app.routing.grid import lonlat_to_xy
from app.routing.planner import RoutePlanner
from app.routing.risk.config import CostModelConfig
from app.services.drone_profiles import DroneProfileRegistry, load_drone_profiles
from app.sim.config import SimConfig, load_sim_config


@dataclass(frozen=True)
class Station:
    id: str
    name: str
    longitude: float
    latitude: float
    capacity: int
    available: bool  # status AVAILABLE in the station file


@dataclass
class SimWorld:
    planner: RoutePlanner
    profiles: DroneProfileRegistry
    stations: list[Station]
    config: SimConfig

    @property
    def cost_model(self) -> CostModelConfig:
        return self.planner.risk.cfg

    def station(self, station_id: str) -> Station | None:
        return next((s for s in self.stations if s.id == station_id), None)

    def contains(self, lon: float, lat: float) -> bool:
        return self.planner.coverage.contains(lon, lat)

    def station_at(self, lon: float, lat: float, tolerance_m: float) -> Station | None:
        """The landing station within tolerance of a point, if any."""
        x, y = lonlat_to_xy(lon, lat)
        best = None
        for s in self.stations:
            sx, sy = lonlat_to_xy(s.longitude, s.latitude)
            d = math.hypot(sx - x, sy - y)
            if d <= tolerance_m and (best is None or d < best[0]):
                best = (d, s)
        return best[1] if best else None


def load_stations(path: Path = DATA_DIR / DATA_FILES["stations"]) -> list[Station]:
    raw = json.loads(path.read_text(encoding="utf-8"))
    out = []
    for f in raw["features"]:
        p = f["properties"]
        lon, lat = f["geometry"]["coordinates"]
        out.append(Station(p["id"], p["name"], float(lon), float(lat), int(p["capacity"]), p["status"] == "AVAILABLE"))
    return out


def load_world(config: SimConfig | None = None, planner: RoutePlanner | None = None) -> SimWorld:
    """The real DEMO world from data/ (about 1–2 s, mostly the routing grid)."""
    if planner is None:
        from app.main import build_planner, load_validated_cost_model  # lazy: keeps sim importable without FastAPI start-up

        planner = build_planner(load_validated_cost_model())
    return SimWorld(planner, load_drone_profiles(), load_stations(), config or load_sim_config(SIM_CONFIG_FILE))


def sim_world_beside(planner: RoutePlanner, config: SimConfig | None = None) -> SimWorld:
    """A world for API simulation sessions next to the routing API's planner.

    It gets its own RoutePlanner (own airspace repository, cost and route caches), so the
    temporary zones an engine installs never reach /routes/calculate, while the read-only
    grid, coverage and cost model are shared instead of loaded twice.
    """
    own = RoutePlanner(planner.grid, AirspaceRepository(make_provider(), planner.grid, planner.airspace.margin_m),
                       planner.coverage, planner.risk)
    return SimWorld(own, load_drone_profiles(), load_stations(), config or load_sim_config(SIM_CONFIG_FILE))
