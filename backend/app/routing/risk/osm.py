"""Providers built from OpenStreetMap: the risk raster written by
scripts/fetch_risk_layers.py plus the routing grid's building heights.

Population density is a proxy, not a census: people per hectare are estimated
from building floor area (residential and other) and public transport stops,
with coefficients from the cost model's `densityProxy` block. The raster must
have exactly the routing grid's cell layout.
"""

from __future__ import annotations

import json
import math
from pathlib import Path

import numpy as np

from app.routing.grid import Grid
from app.routing.risk.config import DensityProxyParams
from app.routing.risk.providers import ArrayLandUse, ArrayObstacles, ArrayPopulation, Providers, uniform_wind
from app.routing.risk.terms import distance_within

LAYERS = ("floor_residential_m2", "floor_other_m2", "residential", "open_space", "sensitive", "transit")


class RiskRasterError(RuntimeError):
    pass


def density_from_osm(floor_residential_m2: np.ndarray, floor_other_m2: np.ndarray, transit: np.ndarray,
                     cell_m: float, p: DensityProxyParams) -> np.ndarray:
    """People per hectare: floor area / m² per person, plus people waiting
    around stops (spread evenly over the stop radius; overlapping stops count
    once, a deliberate simplification)."""
    cell_ha = cell_m * cell_m / 1e4
    people = floor_residential_m2 / p.residential_floor_m2_per_person + floor_other_m2 / p.other_floor_m2_per_person
    density = (people / cell_ha).astype(np.float32)
    if transit.any() and p.transit_stop_people:
        near_stop = distance_within(transit, cell_m, p.transit_stop_radius_m) < p.transit_stop_radius_m
        disk_ha = math.pi * p.transit_stop_radius_m ** 2 / 1e4
        density += np.where(near_stop, np.float32(p.transit_stop_people / disk_ha), np.float32(0.0))
    return density


def grid_only_providers(grid: Grid) -> Providers:
    """Fallback when the risk raster is missing or misaligned: obstacles from the
    routing grid, open space = its park/green mask, and NO population, residential
    or sensitive-site data. The planner refuses SAFEST in this state
    (RISK_DATA_UNAVAILABLE); other objectives still get energy and battery checks."""
    shape = (grid.rows, grid.cols)
    return Providers(
        population=ArrayPopulation(np.zeros(shape, np.float32)),
        land_use=ArrayLandUse(np.zeros(shape, np.float32), grid.park, np.zeros(shape, bool)),
        obstacles=ArrayObstacles(grid.building_height),
        wind=uniform_wind(0.0, 0.0),
    )


def load_osm_providers(path: Path, grid: Grid, proxy: DensityProxyParams) -> tuple[Providers, dict]:
    """Providers on the routing grid, plus the raster's meta (source, date, stats).
    Wind is a calm placeholder: the planner passes each request's forecast."""
    if not path.is_file():
        raise RiskRasterError(f"Missing risk raster {path}. Run `python scripts/fetch_risk_layers.py` "
                              "from the repo root.")
    try:
        with np.load(path) as z:
            meta = json.loads(str(z["meta"]))
            layers = {name: z[name] for name in LAYERS}
    except (KeyError, ValueError, OSError) as exc:
        raise RiskRasterError(f"Invalid risk raster {path.name}: {exc}") from exc
    expected = (grid.min_x, grid.min_y, grid.cell, grid.rows, grid.cols)
    found = (meta.get("min_x"), meta.get("min_y"), meta.get("cell"), meta.get("rows"), meta.get("cols"))
    if found != expected:
        raise RiskRasterError(f"{path.name} does not match the routing grid (expected origin/cell/shape {expected}, "
                              f"found {found}). Rerun scripts/fetch_risk_layers.py.")
    density = density_from_osm(layers["floor_residential_m2"], layers["floor_other_m2"], layers["transit"],
                               grid.cell, proxy)
    providers = Providers(
        population=ArrayPopulation(density),
        land_use=ArrayLandUse(layers["residential"].astype(np.float32), layers["open_space"], layers["sensitive"]),
        obstacles=ArrayObstacles(grid.building_height),
        wind=uniform_wind(0.0, 0.0),
    )
    return providers, meta
