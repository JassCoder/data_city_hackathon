"""Mapped building entrances (OSM `entrance=*`, data/osm/entrances.json.gz).

For a resolved address point, finds the mapped building footprint (from the
cached building tiles) and the entrances on its outline. Nothing is invented:
no building or no mapped entrance means an empty list. An entrance is linked to
a flat only when its `addr:flats` tag covers that flat. Entrances are for
delivery-location planning, never a drone landing location.
"""

from __future__ import annotations

import gzip
import json
import re
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
from shapely.geometry import Point, box, shape
from shapely.strtree import STRtree

from app.config import ENTRANCES_FILE
from app.geo.buildings import buildings_in_bbox
from app.routing.grid import to_metres, xy_to_lonlat

BUILDING_SEARCH_DEG = 0.0006  # ~45-65 m box around the address point
BUILDING_MAX_DISTANCE_M = 20.0  # an address point just outside its footprint still belongs to it
ENTRANCE_TOLERANCE_M = 3.0  # entrance nodes sit on (or within this of) the building outline

NOTE = ("Mapped OpenStreetMap entrances. Choose one for delivery planning; an entrance is not a drone landing site. "
        "Flats are linked to an entrance only where the entrance has an addr:flats tag.")


def flats_contain(spec: str | None, flat: str | None) -> bool:
    """addr:flats such as '1-20;25;30-40' covers `flat`."""
    if not spec or not flat or not flat.isdigit():
        return False
    n = int(flat)
    for part in re.split(r"[;,]", spec):
        part = part.strip()
        m = re.fullmatch(r"(\d+)\s*-\s*(\d+)", part)
        if m and int(m.group(1)) <= n <= int(m.group(2)):
            return True
        if part.isdigit() and int(part) == n:
            return True
    return False


@dataclass
class EntranceIndex:
    available: bool
    rows: list[list] = field(default_factory=list)
    metadata: dict = field(default_factory=dict)
    tiles_dir: Path | None = None

    def __post_init__(self):
        self._tree = STRtree([Point(r[1], r[2]) for r in self.rows]) if self.rows else None

    def _building_at(self, lat: float, lon: float):
        d = BUILDING_SEARCH_DEG
        kwargs = {"tiles_dir": self.tiles_dir} if self.tiles_dir else {}
        candidates = buildings_in_bbox((lon - d, lat - d, lon + d, lat + d), **kwargs)
        p_m = to_metres(Point(lon, lat))
        best, best_d = None, BUILDING_MAX_DISTANCE_M
        for f in candidates:
            g_m = to_metres(shape(f["geometry"]))
            dist = 0.0 if g_m.covers(p_m) else g_m.distance(p_m)
            if dist <= best_d:
                best, best_d = (f, g_m), dist
        return best

    def for_point(self, lat: float, lon: float, flat: str | None = None) -> dict:
        found = self._building_at(lat, lon) if self.available else None
        if found is None:
            return {"building": None, "entrances": [], "note": NOTE if self.available else
                    "Entrance data is not loaded (run scripts/fetch_entrances.py).",
                    "source": self.metadata.get("source")}
        feature, g_m = found
        outline = g_m.boundary.buffer(ENTRANCE_TOLERANCE_M)
        b = g_m.buffer(ENTRANCE_TOLERANCE_M).bounds
        entrances = []
        if self._tree is not None:
            lons, lats = xy_to_lonlat(np.array([b[0], b[2]]), np.array([b[1], b[3]]))
            for i in self._tree.query(box(lons[0], lats[0], lons[1], lats[1])):
                r = self.rows[int(i)]
                if not outline.covers(to_metres(Point(r[1], r[2]))):
                    continue
                entrances.append({"id": r[0], "latitude": r[2], "longitude": r[1], "entrance": r[3], "ref": r[4],
                                  "flats": r[5], "housenumber": r[6], "street": r[7], "wheelchair": r[8],
                                  "matchesFlat": flats_contain(r[5], flat)})
        entrances.sort(key=lambda e: (not e["matchesFlat"], e["entrance"] != "main", e["ref"] or "", e["id"]))
        p = feature["properties"]
        return {"building": {"id": p.get("id"), "heightM": p.get("height_m"), "heightSource": p.get("height_source")},
                "entrances": entrances, "note": NOTE, "source": self.metadata.get("source")}


def load_entrances(path: Path = ENTRANCES_FILE, tiles_dir: Path | None = None) -> EntranceIndex:
    if not path.is_file():
        return EntranceIndex(False)
    doc = json.loads(gzip.decompress(path.read_bytes()))
    return EntranceIndex(True, doc["rows"], doc.get("metadata", {}), tiles_dir)
