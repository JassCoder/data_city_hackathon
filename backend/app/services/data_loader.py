"""Loads and validates the GeoJSON layers in /data once at startup.

Airspace zones are loaded separately (app/airspace). Keeps full-detail
Shapely geometries for routing and pre-serialises
the lighter /layers response so requests don't re-encode ~7k buildings.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

from pydantic import BaseModel, ValidationError
from shapely.geometry import mapping, shape
from shapely.geometry.base import BaseGeometry

from app.config import (
    DATA_DIR,
    DATA_FILES,
    DEMO_BBOX,
    LAYERS_COORD_DECIMALS,
    LAYERS_SIMPLIFY_TOLERANCE_DEG,
)
from app.schemas.layers import (
    BuildingProperties,
    CorridorProperties,
    FeatureCollection,
    StationProperties,
)

POLYGONAL = ("Polygon", "MultiPolygon")


class DataLoadError(RuntimeError):
    pass


@dataclass(frozen=True)
class Layer[P: BaseModel]:
    properties: list[P]
    geometries: list[BaseGeometry]  # full detail, WGS84 lon/lat, same order as properties
    raw: dict  # the file as loaded


@dataclass(frozen=True)
class DemoData:
    corridors: Layer[CorridorProperties]
    buildings: Layer[BuildingProperties]
    stations: Layer[StationProperties]
    layers_json: bytes  # pre-built GET /layers body


def _load_layer[P: BaseModel](
    data_dir: Path, key: str, props_model: type[P], allowed_geoms: tuple[str, ...]
) -> Layer[P]:
    path = data_dir / DATA_FILES[key]
    if not path.is_file():
        hint = "run `python scripts/build_demo_data.py`" if key == "stations" else "run `python scripts/fetch_osm.py`"
        raise DataLoadError(f"Missing data file {path}. To create it, {hint} from the repo root.")
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
        fc = FeatureCollection[props_model].model_validate(raw)
    except (json.JSONDecodeError, ValidationError) as exc:
        raise DataLoadError(f"Invalid GeoJSON in {path.name}:\n{exc}") from exc

    geometries = []
    for f in fc.features:
        geom = shape(f.geometry.model_dump())
        if geom.geom_type not in allowed_geoms:
            raise DataLoadError(
                f"{path.name}: feature {f.properties.id} has {geom.geom_type}, expected {allowed_geoms}"
            )
        if geom.is_empty or not geom.is_valid:
            raise DataLoadError(f"{path.name}: feature {f.properties.id} has an empty or invalid geometry")
        geometries.append(geom)
    return Layer([f.properties for f in fc.features], geometries, raw)


def _round(coords, nd: int):
    if coords and isinstance(coords[0], (int, float)):
        return [round(c, nd) for c in coords]
    return [_round(c, nd) for c in coords]


def _light_collection(layer: Layer, simplify: bool) -> dict:
    features = []
    for props, geom in zip(layer.properties, layer.geometries):
        if simplify:
            geom = geom.simplify(LAYERS_SIMPLIFY_TOLERANCE_DEG, preserve_topology=True)
        g = mapping(geom)
        features.append({
            "type": "Feature",
            "properties": props.model_dump(mode="json"),
            "geometry": {"type": g["type"], "coordinates": _round(g["coordinates"], LAYERS_COORD_DECIMALS)},
        })
    return {"type": "FeatureCollection", "metadata": layer.raw.get("metadata", {}), "features": features}


def load_demo_data(data_dir: Path = DATA_DIR) -> DemoData:
    corridors = _load_layer(data_dir, "corridors", CorridorProperties, POLYGONAL)
    buildings = _load_layer(data_dir, "buildings", BuildingProperties, POLYGONAL)
    stations = _load_layer(data_dir, "stations", StationProperties, ("Point",))

    body = {
        "bbox": DEMO_BBOX,
        "corridors": _light_collection(corridors, simplify=True),
        "buildings": _light_collection(buildings, simplify=True),
        "stations": _light_collection(stations, simplify=False),
    }
    layers_json = json.dumps(body, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    return DemoData(corridors, buildings, stations, layers_json)
