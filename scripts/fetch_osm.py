"""One-off download of OSM data for the SkyRoute demo area.

Writes data/buildings.geojson and data/corridors.geojson. Run from the repo root
with the backend venv:

    backend/.venv/Scripts/python scripts/fetch_osm.py

Nothing is written unless every query succeeds, so a failed run never
clobbers the committed snapshot.
"""

from __future__ import annotations

import json
import os
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

import httpx
from pyproj import Transformer
from shapely.geometry import LineString, Polygon, box, mapping
import shapely
from shapely.ops import linemerge, polygonize, unary_union

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT / "backend"))
from app.config import DATA_DIR, DATA_FILES, DEMO_BBOX  # noqa: E402

OVERPASS_ENDPOINTS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
]
TIMEOUT_S = 180
DEFAULT_HEIGHT_M = 15.0
LEVEL_HEIGHT_M = 3.0
MIN_PARK_AREA_M2 = 1000.0  # drop traffic-island grass etc.
RIVER_CENTERLINE_BUFFER_M = 150.0  # fallback only, if no riverbank polygons
COORD_DECIMALS = 7

_to_m = Transformer.from_crs("EPSG:4326", "EPSG:2180", always_xy=True).transform
_to_deg = Transformer.from_crs("EPSG:2180", "EPSG:4326", always_xy=True).transform

S, W, N, E = DEMO_BBOX["minLat"], DEMO_BBOX["minLon"], DEMO_BBOX["maxLat"], DEMO_BBOX["maxLon"]
BBOX_POLY = box(W, S, E, N)

BUILDINGS_QUERY = f"""
[out:json][timeout:{TIMEOUT_S}][bbox:{S},{W},{N},{E}];
(
  way["building"]["building"!="no"];
  relation["building"]["building"!="no"]["type"="multipolygon"];
);
out geom;
"""

CORRIDORS_QUERY = f"""
[out:json][timeout:{TIMEOUT_S}][bbox:{S},{W},{N},{E}];
(
  way["waterway"="river"];
  way["natural"="water"]["water"="river"];
  relation["natural"="water"]["water"="river"];
  way["waterway"="riverbank"];
  relation["waterway"="riverbank"];
  way["leisure"="park"];
  relation["leisure"="park"];
  way["landuse"~"^(forest|grass)$"];
  relation["landuse"~"^(forest|grass)$"];
);
out geom;
"""


class FetchError(RuntimeError):
    pass


def overpass(query: str, label: str) -> list[dict]:
    errors = []
    headers = {"User-Agent": "SkyRouteWarsaw-hackathon/0.1 (demo data fetch)"}
    for url in OVERPASS_ENDPOINTS:
        print(f"[{label}] querying {url} ...", flush=True)
        try:
            res = httpx.post(url, data={"data": query}, headers=headers, timeout=TIMEOUT_S + 30)
            res.raise_for_status()
            elements = res.json().get("elements", [])
            print(f"[{label}] {len(elements)} elements", flush=True)
            return elements
        except (httpx.HTTPError, ValueError) as exc:
            errors.append(f"{url}: {type(exc).__name__}: {exc}")
    raise FetchError(f"All Overpass endpoints failed for {label}:\n  " + "\n  ".join(errors))


# --- geometry assembly -------------------------------------------------------

def _coords(way_geom: list[dict]) -> list[tuple[float, float]]:
    return [(p["lon"], p["lat"]) for p in way_geom]


def element_polygon(el: dict):
    """Polygon/MultiPolygon for a closed way or multipolygon relation, else None."""
    if el["type"] == "way":
        pts = _coords(el.get("geometry", []))
        if len(pts) < 4 or pts[0] != pts[-1]:
            return None
        poly = Polygon(pts)
        return poly if poly.is_valid else poly.buffer(0)

    if el["type"] == "relation":
        outer, inner = [], []
        for m in el.get("members", []):
            if m.get("type") != "way" or "geometry" not in m:
                continue
            line = LineString(_coords(m["geometry"]))
            (inner if m.get("role") == "inner" else outer).append(line)
        if not outer:
            return None
        shell = unary_union(list(polygonize(linemerge(outer))))
        if shell.is_empty:
            return None
        if inner:
            shell = shell.difference(unary_union(list(polygonize(linemerge(inner)))))
        return shell if shell.is_valid else shell.buffer(0)
    return None


def reproject(geom, fn):
    return shapely.transform(geom, lambda x, y: fn(x, y), interleaved=False)


def area_m2(geom) -> float:
    return reproject(geom, _to_m).area


def round_coords(obj, nd=COORD_DECIMALS):
    if isinstance(obj, (list, tuple)):
        if obj and isinstance(obj[0], (int, float)):
            return [round(v, nd) for v in obj]
        return [round_coords(v, nd) for v in obj]
    return obj


def feature(geom, props: dict) -> dict:
    g = mapping(geom)
    return {"type": "Feature", "properties": props, "geometry": {**g, "coordinates": round_coords(g["coordinates"])}}


# --- buildings ---------------------------------------------------------------

_NUM = re.compile(r"-?\d+(?:[.,]\d+)?")


def _parse_number(raw: str | None) -> float | None:
    if not raw:
        return None
    m = _NUM.search(raw)
    if not m:
        return None
    val = float(m.group().replace(",", "."))
    if "'" in raw or "ft" in raw.lower():
        val *= 0.3048
    return val if val > 0 else None


def building_height(tags: dict) -> tuple[float, str]:
    h = _parse_number(tags.get("height"))
    if h is not None:
        return round(h, 1), "osm_height"
    levels = _parse_number(tags.get("building:levels"))
    if levels is not None:
        return round(levels * LEVEL_HEIGHT_M, 1), "levels_x3"
    return DEFAULT_HEIGHT_M, "default_15m"


def build_buildings(elements: list[dict]) -> list[dict]:
    features = []
    for el in elements:
        geom = element_polygon(el)
        if geom is None or geom.is_empty or not geom.intersects(BBOX_POLY):
            continue
        height_m, source = building_height(el.get("tags", {}))
        features.append(feature(geom, {
            "id": f"osm_{el['type']}_{el['id']}",
            "height_m": height_m,
            "height_source": source,
        }))
    return features


# --- corridors ---------------------------------------------------------------

def _is_river(tags: dict) -> bool:
    return (
        tags.get("waterway") in ("river", "riverbank")
        or (tags.get("natural") == "water" and tags.get("water") == "river")
    )


def build_corridors(elements: list[dict]) -> list[dict]:
    river_polys, centerlines, features = [], [], []
    for el in elements:
        tags = el.get("tags", {})
        if tags.get("waterway") == "river" and el["type"] == "way":
            centerlines.append(LineString(_coords(el["geometry"])))
            continue
        geom = element_polygon(el)
        if geom is None or geom.is_empty:
            continue
        geom = geom.intersection(BBOX_POLY)
        if geom.is_empty or geom.geom_type not in ("Polygon", "MultiPolygon"):
            continue
        if _is_river(tags):
            river_polys.append(geom)
            continue
        if area_m2(geom) < MIN_PARK_AREA_M2:
            continue
        features.append(feature(geom, {
            "id": f"osm_{el['type']}_{el['id']}",
            "name": tags.get("name"),
            "corridor_type": "PARK",
            "osm_tag": next(f"{k}={tags[k]}" for k in ("leisure", "landuse") if k in tags),
        }))

    if river_polys:
        river = unary_union(river_polys)
        geometry_source = "osm_riverbank"
    elif centerlines:
        print("WARNING: no riverbank polygons found, buffering river centerline instead")
        river_m = reproject(unary_union(centerlines), _to_m).buffer(RIVER_CENTERLINE_BUFFER_M)
        river = reproject(river_m, _to_deg).intersection(BBOX_POLY)
        geometry_source = "centerline_buffer"
    else:
        raise FetchError("No Vistula geometry (riverbank or centerline) found in the bbox")

    features.insert(0, feature(river, {
        "id": "vistula",
        "name": "Wisła (Vistula)",
        "corridor_type": "RIVER",
        "geometry_source": geometry_source,
    }))
    return features


# --- main --------------------------------------------------------------------

def collection(features: list[dict], kind: str) -> dict:
    return {
        "type": "FeatureCollection",
        "metadata": {
            "layer": kind,
            "source": "OpenStreetMap contributors (ODbL), via Overpass API",
            "fetched_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "bbox": DEMO_BBOX,
        },
        "features": features,
    }


def write_atomic(path: Path, data: dict) -> None:
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    os.replace(tmp, path)


def main() -> int:
    try:
        buildings = build_buildings(overpass(BUILDINGS_QUERY, "buildings"))
        corridors = build_corridors(overpass(CORRIDORS_QUERY, "corridors"))
        if not buildings:
            raise FetchError("Overpass returned no buildings for the bbox")
    except FetchError as exc:
        print(f"\nERROR: {exc}\nExisting files in {DATA_DIR} were left untouched.", file=sys.stderr)
        return 1

    DATA_DIR.mkdir(exist_ok=True)
    write_atomic(DATA_DIR / DATA_FILES["buildings"], collection(buildings, "buildings"))
    write_atomic(DATA_DIR / DATA_FILES["corridors"], collection(corridors, "corridors"))

    sources = {}
    for f in buildings:
        sources[f["properties"]["height_source"]] = sources.get(f["properties"]["height_source"], 0) + 1
    tall = sum(1 for f in buildings if f["properties"]["height_m"] >= 50)
    parks = sum(1 for f in corridors if f["properties"]["corridor_type"] == "PARK")
    print(f"\nbuildings.geojson: {len(buildings)} buildings ({tall} >= 50 m), height sources {sources}")
    print(f"corridors.geojson: 1 river ({corridors[0]['properties']['geometry_source']}), {parks} parks/green")
    return 0


if __name__ == "__main__":
    sys.exit(main())
