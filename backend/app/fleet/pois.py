"""Real geographic records: OSM hospitals and restaurants (data/pois, scripts/fetch_pois.py).

Read-only. Nothing here says a facility hosts drones: simulated stations and
pads live in the fleet database and only reference these records by id.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from shapely.geometry import Point, box
from shapely.strtree import STRtree

from app.config import POI_DIR


@dataclass
class Poi:
    id: str
    name: str | None
    latitude: float
    longitude: float
    district: str | None
    props: dict[str, Any]


@dataclass
class PoiLayer:
    kind: str  # "hospitals" | "restaurants"
    available: bool
    items: list[Poi] = field(default_factory=list)
    metadata: dict[str, Any] = field(default_factory=dict)
    message: str = ""

    def __post_init__(self):
        self.by_id = {p.id: p for p in self.items}
        self._tree = STRtree([Point(p.longitude, p.latitude) for p in self.items]) if self.items else None

    def get(self, poi_id: str) -> Poi | None:
        return self.by_id.get(poi_id)

    def query(self, bbox: tuple[float, float, float, float] | None = None, district: str | None = None,
              ids: set[str] | None = None) -> list[Poi]:
        items = self.items
        if bbox is not None and self._tree is not None:
            items = [self.items[int(i)] for i in sorted(self._tree.query(box(*bbox)))]
        if district:
            items = [p for p in items if p.district == district]
        if ids is not None:
            items = [p for p in items if p.id in ids]
        return items


def load_layer(kind: str, poi_dir: Path = POI_DIR) -> PoiLayer:
    path = poi_dir / f"{kind}.geojson"
    if not path.is_file():
        return PoiLayer(kind, False, message=f"{path.name} missing: run scripts/fetch_pois.py (one-off OSM import).")
    try:
        doc = json.loads(path.read_text(encoding="utf-8"))
        items = [Poi(f["properties"]["id"], f["properties"].get("name"), f["properties"]["latitude"],
                     f["properties"]["longitude"], f["properties"].get("district"), f["properties"])
                 for f in doc["features"]]
    except (KeyError, TypeError, ValueError) as exc:
        return PoiLayer(kind, False, message=f"{path.name} is invalid ({exc}); re-run scripts/fetch_pois.py.")
    return PoiLayer(kind, True, items, doc.get("metadata", {}),
                    f"{len(items)} {kind} from OpenStreetMap (not guaranteed complete).")


@dataclass
class Pois:
    hospitals: PoiLayer
    restaurants: PoiLayer


def load_pois(poi_dir: Path = POI_DIR) -> Pois:
    return Pois(load_layer("hospitals", poi_dir), load_layer("restaurants", poi_dir))
