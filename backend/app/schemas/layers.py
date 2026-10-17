"""GeoJSON models for the static data layers in /data (airspace: app/airspace)."""

from enum import StrEnum
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict


class CorridorType(StrEnum):
    RIVER = "RIVER"
    PARK = "PARK"


class HeightSource(StrEnum):
    OSM_HEIGHT = "osm_height"
    LEVELS_X3 = "levels_x3"
    DEFAULT_15M = "default_15m"


class StationType(StrEnum):
    HOSPITAL = "HOSPITAL"
    ROOFTOP = "ROOFTOP"
    PARK = "PARK"
    DEPOT = "DEPOT"


class StationStatus(StrEnum):
    AVAILABLE = "AVAILABLE"
    BUSY = "BUSY"
    OFFLINE = "OFFLINE"


class Geometry(BaseModel):
    type: Literal["Point", "LineString", "Polygon", "MultiPolygon"]
    coordinates: list[Any]


class CorridorProperties(BaseModel):
    model_config = ConfigDict(extra="allow")  # name, osm_tag, geometry_source
    id: str
    corridor_type: CorridorType


class BuildingProperties(BaseModel):
    id: str
    height_m: float
    height_source: HeightSource


class StationProperties(BaseModel):
    id: str
    name: str
    station_type: StationType
    status: StationStatus
    capacity: int
    source: Literal["DEMO"]


class Feature[P: BaseModel](BaseModel):
    type: Literal["Feature"]
    properties: P
    geometry: Geometry


class FeatureCollection[P: BaseModel](BaseModel):
    model_config = ConfigDict(extra="allow")  # metadata
    type: Literal["FeatureCollection"]
    features: list[Feature[P]]
