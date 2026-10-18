"""Synthetic provider sets for tests and experiments (no real data)."""

from __future__ import annotations

import numpy as np

from app.routing.risk.providers import (
    ArrayLandUse,
    ArrayObstacles,
    ArrayPopulation,
    GridSpec,
    Providers,
    uniform_wind,
)

Block = tuple[slice, slice]  # [rows, cols]


def synthetic_world(
    spec: GridSpec,
    crowded: list[tuple[Block, float]] = (),
    residential: list[Block] = (),
    open_space: list[Block] = (),
    sensitive: list[Block] = (),
    buildings: list[tuple[Block, float]] = (),
    wind: tuple[float, float] = (0.0, 0.0),
    open_everywhere: bool = True,
) -> Providers:
    """Hand-placed blocks on an otherwise empty grid.

    `crowded`/`buildings` take (block, people per ha / height m); `wind` is
    (speed km/h, from-direction deg). With `open_everywhere` (default) every cell
    counts as open space unless `open_space` lists blocks explicitly, so the
    emergency-landing term stays 0 in tests that do not exercise it.
    """
    density = np.zeros(spec.shape, np.float32)
    for block, value in crowded:
        density[block] = value
    res = np.zeros(spec.shape, np.float32)
    for block in residential:
        res[block] = 1.0
    open_mask = np.zeros(spec.shape, bool) if open_space or not open_everywhere else np.ones(spec.shape, bool)
    for block in open_space:
        open_mask[block] = True
    sens = np.zeros(spec.shape, bool)
    for block in sensitive:
        sens[block] = True
    heights = np.zeros(spec.shape, np.float32)
    for block, h in buildings:
        heights[block] = h
    return Providers(ArrayPopulation(density), ArrayLandUse(res, open_mask, sens), ArrayObstacles(heights),
                     uniform_wind(*wind))
