"""Routing coverage = the official City of Warsaw polygon (GUGiK PRG, TERYT 1465).

Point checks are real point-in-polygon tests on prepared geometries, never
min/max box checks. If the boundary file is missing, coverage is reported as
unavailable and routing refuses to run (no silent fallback to a rectangle).
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import shapely
from shapely.geometry import Point, box, mapping, shape
from shapely.geometry.base import BaseGeometry

from app.config import BOUNDARY_CITY_FILE, BOUNDARY_DISTRICTS_FILE


@dataclass
class District:
    name: str
    teryt: str
    geom: BaseGeometry  # WGS84


@dataclass
class Coverage:
    available: bool
    label: str
    geom: BaseGeometry | None = None  # WGS84 lon/lat
    districts: list[District] = field(default_factory=list)
    source: dict[str, Any] = field(default_factory=dict)
    message: str = ""
    raw_city: dict | None = None
    raw_districts: dict | None = None

    def __post_init__(self):
        if self.geom is not None:
            shapely.prepare(self.geom)
        for d in self.districts:
            shapely.prepare(d.geom)

    def contains(self, lon: float, lat: float) -> bool:
        return self.geom is not None and self.geom.covers(Point(lon, lat))

    def district_of(self, lon: float, lat: float) -> str | None:
        p = Point(lon, lat)
        return next((d.name for d in self.districts if d.geom.covers(p)), None)

    @property
    def bounds(self) -> tuple[float, float, float, float] | None:
        return self.geom.bounds if self.geom is not None else None


def load_city_coverage(city_file: Path = BOUNDARY_CITY_FILE, districts_file: Path = BOUNDARY_DISTRICTS_FILE) -> Coverage:
    if not city_file.is_file():
        return Coverage(
            available=False,
            label="City of Warsaw (boundary unavailable)",
            message=f"Warsaw boundary data is missing ({city_file.name}). Run scripts/fetch_boundaries.py. "
            "Routing is disabled until the official boundary is available.",
        )
    city_doc = json.loads(city_file.read_text(encoding="utf-8"))
    city = shape(city_doc["features"][0]["geometry"])
    districts, districts_doc = [], None
    if districts_file.is_file():
        districts_doc = json.loads(districts_file.read_text(encoding="utf-8"))
        districts = [
            District(f["properties"]["name"], f["properties"]["teryt"], shape(f["geometry"]))
            for f in districts_doc["features"]
        ]
    return Coverage(
        available=True,
        label="City of Warsaw (GUGiK PRG boundary, TERYT 1465)",
        geom=city,
        districts=districts,
        source=city_doc.get("metadata", {}),
        message=f"Routing supported anywhere inside the official City of Warsaw boundary ({len(districts)} districts).",
        raw_city=city_doc,
        raw_districts=districts_doc,
    )


def bbox_coverage(bbox: dict[str, float], label: str = "test area") -> Coverage:
    """Rectangular coverage for synthetic test worlds only."""
    return Coverage(available=True, label=label, geom=box(bbox["minLon"], bbox["minLat"], bbox["maxLon"], bbox["maxLat"]))


def geometry_geojson(geom: BaseGeometry | None) -> dict | None:
    return mapping(geom) if geom is not None else None
