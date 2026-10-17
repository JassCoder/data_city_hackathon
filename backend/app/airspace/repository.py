"""Holds the current airspace dataset plus its projected geometry and grid masks.

`refresh()` reloads when the provider's data changed; every request works on an
immutable `AirspaceState` snapshot, so a reload never affects a running plan.
"""

from __future__ import annotations

import logging
import threading
from dataclasses import dataclass

import numpy as np
from shapely.geometry import mapping
from shapely.geometry.base import BaseGeometry
from shapely.strtree import STRtree

from app.airspace.evaluation import FlightContext, evaluate
from app.airspace.geometry import as_area
from app.airspace.models import AirspaceSourceInfo, AirspaceZone, EvaluatedZone, ZoneEvaluation
from app.airspace.providers import AirspaceDataset, AirspaceLoadError, AirspaceProvider
from app.config import AIRSPACE_SAFETY_MARGIN_M
from app.routing.grid import Grid, cells_intersecting, to_metres

log = logging.getLogger(__name__)


@dataclass(frozen=True)
class AirspaceState:
    dataset: AirspaceDataset
    zones: list[AirspaceZone]
    geoms_m: list[BaseGeometry]  # exact zone areas, EPSG:2180
    cells: list[np.ndarray]  # flat grid indices touching the zone + safety margin
    tree: STRtree | None
    extent_m: BaseGeometry | None = None  # dataset extent, EPSG:2180

    @property
    def version(self) -> str:
        return self.dataset.version

    def evaluations(self, ctx: FlightContext) -> list[ZoneEvaluation]:
        return [evaluate(z, ctx) for z in self.zones]

    def evaluated(self, ctx: FlightContext) -> list[EvaluatedZone]:
        return [EvaluatedZone(**z.model_dump(), evaluation=e) for z, e in zip(self.zones, self.evaluations(ctx))]

    def zones_touching(self, geom_m: BaseGeometry) -> list[int]:
        if self.tree is None:
            return []
        return sorted(int(i) for i in self.tree.query(geom_m, predicate="intersects"))

    def source_info(self) -> AirspaceSourceInfo:
        d = self.dataset
        return AirspaceSourceInfo(
            provider=d.provider,
            source_type=d.source_type,
            label=d.label,
            source_timestamp=d.source_timestamp,
            dataset_version=d.version,
            loaded_at=d.loaded_at,
            disclaimer=d.disclaimer,
            extent=mapping(d.extent) if d.extent is not None else None,
            extent_label=d.extent_label,
        )


def build_state(dataset: AirspaceDataset, grid: Grid, margin_m: float = AIRSPACE_SAFETY_MARGIN_M) -> AirspaceState:
    geoms_m, cells = [], []
    for z in dataset.zones:
        g = to_metres(as_area(z.geojson_geometry))
        geoms_m.append(g)
        win, hit = cells_intersecting(grid, g.buffer(margin_m) if margin_m > 0 else g)
        rs, cs = win
        rr, cc = np.nonzero(hit)
        cells.append(((rr + rs.start) * grid.cols + (cc + cs.start)).astype(np.int64))
    extent_m = to_metres(dataset.extent) if dataset.extent is not None else None
    return AirspaceState(dataset, list(dataset.zones), geoms_m, cells, STRtree(geoms_m) if geoms_m else None, extent_m)


class AirspaceRepository:
    def __init__(self, provider: AirspaceProvider, grid: Grid, margin_m: float = AIRSPACE_SAFETY_MARGIN_M):
        self.provider = provider
        self.grid = grid
        self.margin_m = margin_m
        self._lock = threading.Lock()
        self.last_error: str | None = None
        self._state = build_state(provider.load(), grid, margin_m)

    @property
    def state(self) -> AirspaceState:
        return self._state

    def refresh(self) -> AirspaceState:
        """Reloads if the source changed. A broken update keeps the last good data."""
        with self._lock:
            try:
                if self.provider.has_changed(self._state.dataset):
                    self._state = build_state(self.provider.load(), self.grid, self.margin_m)
                    self.last_error = None
                    log.info("Airspace dataset reloaded: version %s", self._state.version)
            except AirspaceLoadError as exc:
                self.last_error = str(exc)
                log.error("Airspace reload failed, keeping version %s: %s", self._state.version, exc)
            return self._state
