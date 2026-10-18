"""One-off import of real hospitals and restaurants in Warsaw from OpenStreetMap.

    backend/.venv/Scripts/python scripts/fetch_pois.py            # both
    backend/.venv/Scripts/python scripts/fetch_pois.py hospitals  # one layer

Writes (committed; the backend and browser never call Overpass):
  data/pois/hospitals.geojson     amenity=hospital / healthcare=hospital
  data/pois/restaurants.geojson   amenity=restaurant

Nodes, ways and relations are fetched in a few bbox tiles (Overpass usage
policy: small queries, pauses, descriptive User-Agent), clipped to the official
GUGiK Warsaw polygon and deduplicated:
  - hospitals: features within the same mapped campus (or within
    HOSPITAL_MERGE_M with the same name, or unnamed parts of a named campus)
    are one facility; every building of a campus is NOT a separate hospital;
  - restaurants: a node inside / next to a polygon with the same name is one POI.
Names are never invented (unnamed stays null). Re-running only replaces these
files; simulated stations/pads in the fleet database reference OSM ids and survive.
"""

from __future__ import annotations

import json
import sys
from datetime import datetime, timezone
from pathlib import Path

import shapely
from shapely.geometry import Point, mapping, shape

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT / "scripts"))
sys.path.insert(0, str(REPO_ROOT / "backend"))
from fetch_osm import FetchError, element_polygon, reproject, round_coords, tiled_query  # noqa: E402

from app.config import BOUNDARY_CITY_FILE, BOUNDARY_DISTRICTS_FILE, POI_DIR  # noqa: E402

HOSPITALS_BODY = """
  node["amenity"="hospital"]; way["amenity"="hospital"]; relation["amenity"="hospital"];
  node["healthcare"="hospital"]; way["healthcare"="hospital"]; relation["healthcare"="hospital"];
"""
RESTAURANTS_BODY = 'node["amenity"="restaurant"]; way["amenity"="restaurant"]; relation["amenity"="restaurant"];'
HOSPITAL_MERGE_M = 250.0  # same-name parts closer than this are one facility
NAME_VARIANT_MERGE_M = 400.0  # one name contained in the other ("X" vs "Państwowy X"): same facility
RESTAURANT_MERGE_M = 30.0  # node + polygon with the same name
SOURCE = "OpenStreetMap contributors (ODbL), via Overpass API"
MIN_EXPECTED = {"hospitals": 15, "restaurants": 1000}  # sanity floor: refuse to write a broken import


def _address(tags: dict) -> str | None:
    street = tags.get("addr:street") or tags.get("addr:place")
    parts = [f"{street} {tags.get('addr:housenumber', '')}".strip() if street else None,
             " ".join(p for p in (tags.get("addr:postcode"), tags.get("addr:city")) if p) or None]
    out = ", ".join(p for p in parts if p)
    return out or None


def _geometry(el: dict):
    if el["type"] == "node":
        return Point(el["lon"], el["lat"])
    return element_polygon(el)


def _records(elements: list[dict], city, districts) -> list[dict]:
    out = []
    for el in elements:
        geom = _geometry(el)
        if geom is None or geom.is_empty:
            continue
        rp = geom if geom.geom_type == "Point" else geom.representative_point()
        if not city.covers(rp):
            continue
        tags = el.get("tags", {})
        out.append({
            "osm_id": f"{el['type']}/{el['id']}",
            "name": tags.get("name"),
            "tags": tags,
            "geom": geom,
            "point": rp,
            "district": next((n for n, g in districts if g.covers(rp)), None),
        })
    return out


def _completeness(r: dict) -> dict:
    t = r["tags"]
    return {"hasName": bool(r["name"]), "hasAddress": bool(_address(t)),
            "hasFootprint": r["geom"].geom_type != "Point", "hasContact": bool(t.get("website") or t.get("phone")
                                                                              or t.get("contact:website") or t.get("contact:phone"))}


def _norm(name: str) -> str:
    return " ".join(name.lower().replace("„", " ").replace("”", " ").replace('"', " ").split())


def _name_variant(a: str, b: str) -> bool:
    a, b = _norm(a), _norm(b)
    return len(min(a, b, key=len)) >= 12 and (a in b or b in a)


def dedupe_hospitals(records: list[dict]) -> list[dict]:
    """One record per facility. Polygons win over nodes; a feature inside (or within
    HOSPITAL_MERGE_M of) a kept campus with the same name or no name is merged."""
    ordered = sorted(records, key=lambda r: (r["geom"].geom_type == "Point", -_area(r)))
    kept: list[dict] = []
    for r in ordered:
        rm = reproject(r["geom"])
        target = None
        for k in kept:
            km = k["_m"]
            same_name = r["name"] and k["name"] and r["name"].strip().lower() == k["name"].strip().lower()
            inside = km.buffer(5).covers(reproject(r["point"]))
            near = km.distance(rm) <= HOSPITAL_MERGE_M
            variant = (r["name"] and k["name"] and _name_variant(r["name"], k["name"])
                       and km.distance(rm) <= NAME_VARIANT_MERGE_M)
            if (inside and (same_name or not r["name"] or not k["name"])) or (same_name and near) or variant:
                target = k
                break
        if target is None:
            r["_m"], r["merged"] = rm, []
            kept.append(r)
        else:
            target["merged"].append(r["osm_id"])
            if not target["name"] and r["name"]:
                target["name"] = r["name"]
            for key, val in r["tags"].items():
                target["tags"].setdefault(key, val)
    return kept


def dedupe_restaurants(records: list[dict]) -> list[dict]:
    ordered = sorted(records, key=lambda r: r["geom"].geom_type == "Point")  # polygons first
    kept: list[dict] = []
    tree_pts: list = []
    for r in ordered:
        p = reproject(r["point"])
        dup = None
        if r["name"]:
            for k, kp in zip(kept, tree_pts):
                if k["name"] and k["name"].strip().lower() == r["name"].strip().lower() and (
                        kp.distance(p) <= RESTAURANT_MERGE_M or k["_m"].buffer(5).covers(p)):
                    dup = k
                    break
        if dup is None:
            r["_m"], r["merged"] = reproject(r["geom"]), []
            kept.append(r)
            tree_pts.append(p)
        else:
            dup["merged"].append(r["osm_id"])
    return kept


def _area(r: dict) -> float:
    return 0.0 if r["geom"].geom_type == "Point" else reproject(r["geom"]).area


def _feature(r: dict, kind: str, fetched: str) -> dict:
    t = r["tags"]
    g = r["geom"] if kind == "hospital" and r["geom"].geom_type != "Point" else None
    props = {
        "id": f"osm:{r['osm_id']}",
        "osmId": r["osm_id"],
        "name": r["name"],
        "address": _address(t),
        "district": r["district"],
        "latitude": round(r["point"].y, 6),
        "longitude": round(r["point"].x, 6),
        "website": t.get("website") or t.get("contact:website"),
        "phone": t.get("phone") or t.get("contact:phone"),
        "mergedOsmIds": r.get("merged", []),
        "completeness": _completeness(r),
        "source": SOURCE,
        "importedAt": fetched,
    }
    if kind == "hospital":
        props["emergency"] = t.get("emergency")
        props["operator"] = t.get("operator")
        if g is not None:
            props["footprint"] = {"type": mapping(g)["type"],
                                  "coordinates": round_coords(mapping(g.simplify(0.00002, preserve_topology=True))["coordinates"])}
    else:
        props["cuisine"] = t.get("cuisine")
        props["openingHours"] = t.get("opening_hours")
    return {"type": "Feature", "properties": props,
            "geometry": {"type": "Point", "coordinates": [props["longitude"], props["latitude"]]}}


def run(layer: str, city, districts, bounds, fetched: str) -> int:
    body = HOSPITALS_BODY if layer == "hospitals" else RESTAURANTS_BODY
    try:
        elements = tiled_query(body, layer, bounds)
    except FetchError as exc:
        print(f"ERROR: {exc}\nExisting {layer} file left untouched.", file=sys.stderr)
        return 1
    records = _records(elements, city, districts)
    kept = dedupe_hospitals(records) if layer == "hospitals" else dedupe_restaurants(records)
    if len(kept) < MIN_EXPECTED[layer]:
        print(f"ERROR: implausible {layer} result ({len(kept)}); nothing written.", file=sys.stderr)
        return 1
    kind = "hospital" if layer == "hospitals" else "restaurant"
    feats = sorted((_feature(r, kind, fetched) for r in kept), key=lambda f: f["properties"]["id"])
    by_district: dict[str, int] = {}
    for f in feats:
        by_district[f["properties"]["district"] or "?"] = by_district.get(f["properties"]["district"] or "?", 0) + 1
    doc = {
        "type": "FeatureCollection",
        "metadata": {
            "layer": layer,
            "source": SOURCE,
            "query": " ".join(body.split()),
            "importedAt": fetched,
            "rawElements": len(elements),
            "insideWarsaw": len(records),
            "afterDeduplication": len(feats),
            "byDistrict": dict(sorted(by_district.items())),
            "completenessNote": "OpenStreetMap is volunteer-mapped: this list is not guaranteed to contain every "
                                "operating facility, and names, addresses and tags may be missing or outdated.",
        },
        "features": feats,
    }
    POI_DIR.mkdir(parents=True, exist_ok=True)
    (POI_DIR / f"{layer}.geojson").write_text(json.dumps(doc, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"{layer}: {len(elements)} raw elements, {len(records)} inside Warsaw, {len(feats)} after dedup; "
          f"districts {len(by_district)}")
    return 0


def main(argv: list[str]) -> int:
    sys.stdout.reconfigure(encoding="utf-8")
    layers = argv or ["hospitals", "restaurants"]
    city = shape(json.loads(BOUNDARY_CITY_FILE.read_text(encoding="utf-8"))["features"][0]["geometry"])
    shapely.prepare(city)
    districts = [(f["properties"]["name"], shape(f["geometry"]))
                 for f in json.loads(BOUNDARY_DISTRICTS_FILE.read_text(encoding="utf-8"))["features"]]
    for _, g in districts:
        shapely.prepare(g)
    fetched = datetime.now(timezone.utc).isoformat(timespec="seconds")
    return max(run(layer, city, districts, city.bounds, fetched) for layer in layers)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
