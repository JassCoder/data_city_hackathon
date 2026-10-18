import json
import math

import numpy as np
import pytest

from app.config import COST_MODEL_FILE
from app.routing.grid import empty_grid
from app.routing.risk.config import load_cost_model
from app.routing.risk.osm import LAYERS, RiskRasterError, density_from_osm, load_osm_providers

PROXY = load_cost_model(COST_MODEL_FILE).density_proxy


def write_raster(path, grid, **overrides):
    shape = (grid.rows, grid.cols)
    layers = {name: np.zeros(shape, np.float32 if name.startswith("floor") else bool) for name in LAYERS}
    layers.update(overrides)
    meta = {"min_x": grid.min_x, "min_y": grid.min_y, "cell": grid.cell, "rows": grid.rows, "cols": grid.cols,
            "source": "test"}
    np.savez_compressed(path, meta=json.dumps(meta), **layers)
    return path


def test_density_from_floor_area():
    res = np.zeros((3, 3), np.float32)
    other = np.zeros((3, 3), np.float32)
    res[1, 1] = 625.0  # one full 25 m cell of residential floor (floor area ratio 1)
    other[0, 0] = 625.0
    d = density_from_osm(res, other, np.zeros((3, 3), bool), 25.0, PROXY)
    assert d[1, 1] == pytest.approx(625 / PROXY.residential_floor_m2_per_person / 0.0625)
    assert d[0, 0] == pytest.approx(625 / PROXY.other_floor_m2_per_person / 0.0625)
    assert d[2, 2] == 0


def test_transit_stops_add_people_within_their_radius():
    transit = np.zeros((20, 20), bool)
    transit[10, 10] = True
    zero = np.zeros((20, 20), np.float32)
    d = density_from_osm(zero, zero, transit, 25.0, PROXY)
    per_ha = PROXY.transit_stop_people / (math.pi * PROXY.transit_stop_radius_m ** 2 / 1e4)
    assert d[10, 10] == pytest.approx(per_ha) and d[10, 13] == pytest.approx(per_ha)  # 75 m away
    assert d[10, 14] == 0  # 100 m: outside


def test_load_osm_providers_matches_the_grid(tmp_path):
    grid = empty_grid(1000.0, 2000.0, 6, 8)
    grid.building_height[2, 3] = 42.0
    sensitive = np.zeros((6, 8), bool)
    sensitive[1, 1] = True
    providers, meta = load_osm_providers(write_raster(tmp_path / "r.npz", grid, sensitive=sensitive), grid, PROXY)
    assert meta["source"] == "test"
    assert providers.obstacles.heights_m()[2, 3] == 42.0
    assert providers.land_use.sensitive_sites()[1, 1]
    assert providers.population.density_per_ha().shape == (6, 8)


def test_mismatched_or_missing_raster_is_a_clear_error(tmp_path):
    grid = empty_grid(1000.0, 2000.0, 6, 8)
    other = empty_grid(1000.0, 2000.0, 6, 9)
    with pytest.raises(RiskRasterError, match="does not match the routing grid"):
        load_osm_providers(write_raster(tmp_path / "r.npz", other), grid, PROXY)
    with pytest.raises(RiskRasterError, match="Missing risk raster"):
        load_osm_providers(tmp_path / "none.npz", grid, PROXY)
