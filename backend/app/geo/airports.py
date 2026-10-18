"""Airport locations from OpenStreetMap (data/airports.geojson, scripts/fetch_airports.py).

INFORMATIVE ONLY. An aerodrome footprint is not a UAS geographical zone and is
never turned into a drone no-fly zone here. The only routing use is the
optional, clearly labelled NON-REGULATORY planning constraint (see
app/routing/constraints.py), which is off unless a request asks for it.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from shapely.geometry import box, shape
from shapely.geometry.base import BaseGeometry
from shapely.strtree import STRtree

from app.config import AIRPORTS_FILE


@dataclass
class Airport:
    id: str
    name: str | None
    icao: str | None
    geom: BaseGeometry  # WGS84 mapped aerodrome area
    feature: dict[str, Any]


@dataclass
class AirportData:
    available: bool
    airports: list[Airport] = field(default_factory=list)
    metadata: dict[str, Any] = field(default_factory=dict)
    message: str = ""
    _tree: STRtree | None = None

    def __post_init__(self):
        if self.airports:
            self._tree = STRtree([a.geom for a in self.airports])

    def query(self, bbox: tuple[float, float, float, float] | None = None) -> list[Airport]:
        if bbox is None or self._tree is None:
            return list(self.airports)
        return [self.airports[int(i)] for i in sorted(self._tree.query(box(*bbox), predicate="intersects"))]

    def feature_collection(self, bbox: tuple[float, float, float, float] | None = None) -> dict[str, Any]:
        return {
            "type": "FeatureCollection",
            "metadata": {**self.metadata, "available": self.available, "message": self.message,
                         "regulatoryStatus": "INFORMATIVE: not UAS geographical zones"},
            "features": [a.feature for a in self.query(bbox)],
        }


def load_airports(path: Path = AIRPORTS_FILE) -> AirportData:
    if not path.is_file():
        return AirportData(False, message=f"Airport data missing ({path.name}); run scripts/fetch_airports.py.")
    doc = json.loads(path.read_text(encoding="utf-8"))
    airports = [
        Airport(f["properties"]["id"], f["properties"].get("name"), f["properties"].get("icao"), shape(f["geometry"]), f)
        for f in doc.get("features", [])
    ]
    return AirportData(True, airports, doc.get("metadata", {}),
                       f"{len(airports)} aerodromes from OpenStreetMap (informative, not drone zones).")
