"""One-off download of SkyRoute PLANNING CONSTRAINTS from OpenStreetMap.

    backend/.venv/Scripts/python scripts/fetch_planning_constraints.py

Writes data/planning_constraints.geojson (committed; the backend never calls Overpass).

What is collected (real mapped OSM footprints only; no circles, no buffers):
  AIRPORT     aeroway=aerodrome areas (Chopin EPWA, Babice EPBC, ...)
  MILITARY    landuse=military areas and areas tagged military=*
  GOVERNMENT  office=government / building=government areas, and the building
              footprint that contains an office=government point

These are NOT official UAS geographical zones. SkyRoute avoids them as its own
planning policy for the simulation. Real airport and government restrictions
(e.g. DRA-R in the Chopin CTR, which is far larger than the airport grounds)
come only from an official zone dataset (SKYROUTE_AIRSPACE_PROVIDER=ed269|geojson).
"""

from __future__ import annotations

import json
import sys
from datetime import datetime, timezone
from pathlib import Path

from shapely.geometry import LineString, mapping, shape
from shapely.ops import polygonize, unary_union

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT / "scripts"))
sys.path.insert(0, str(REPO_ROOT / "backend"))
from fetch_osm import FetchError, element_polygon, overpass, round_coords  # noqa: E402

from app.config import BOUNDARY_CITY_FILE, PLANNING_CONSTRAINTS_FILE  # noqa: E402

MIN_AREA_M2 = 50.0  # drop mapping slivers (approximate, at Warsaw's latitude)
EXCLUDED_MILITARY = {"trench", "bunker", "checkpoint", "office", "recruitment_office", "obstacle_course"}

QUERY = """[out:json][timeout:300][bbox:{s},{w},{n},{e}];
(
  way["aeroway"="aerodrome"]; relation["aeroway"="aerodrome"];
  way["landuse"="military"]; relation["landuse"="military"];
  way["military"]; relation["military"];
  way["office"="government"]; relation["office"="government"];
  way["building"="government"]; relation["building"="government"];
);
out geom;"""
# Government offices mapped as points: the building footprint that contains them.
OFFICE_BUILDINGS = """[out:json][timeout:300][bbox:{s},{w},{n},{e}];
node["office"="government"]->.g;
.g is_in->.a;
way(pivot.a)["building"];
out geom;"""


def kind_of(tags: dict) -> str | None:
    if tags.get("aeroway") == "aerodrome":
        return "AIRPORT"
    if tags.get("landuse") == "military" or (tags.get("military") and tags["military"] not in EXCLUDED_MILITARY):
        return "MILITARY"
    if tags.get("office") == "government" or tags.get("building") == "government":
        return "GOVERNMENT"
    return None


def repaired_relation(el: dict):
    """Outer member ways of a relation whose rings cross: node the lines, then polygonize.
    Only the relation's own mapped lines are used (inner rings are ignored: conservative)."""
    if el["type"] != "relation":
        return None
    lines = [LineString([(p["lon"], p["lat"]) for p in m["geometry"]]) for m in el.get("members", [])
             if m.get("type") == "way" and m.get("role") != "inner" and len(m.get("geometry", [])) >= 2]
    if not lines:
        return None
    polys = list(polygonize(unary_union(lines)))
    return unary_union(polys).buffer(0) if polys else None


def area_m2(geom) -> float:
    return geom.area * 111_320 * 68_000  # deg² → m² near 52.2°N (filter only)


def main() -> int:
    sys.stdout.reconfigure(encoding="utf-8")
    city = shape(json.loads(BOUNDARY_CITY_FILE.read_text(encoding="utf-8"))["features"][0]["geometry"])
    w, s, e, n = city.bounds
    try:
        elements = overpass(QUERY.format(s=s, w=w, n=n, e=e), "planning constraints")
        offices = overpass(OFFICE_BUILDINGS.format(s=s, w=w, n=n, e=e), "government office buildings")
    except FetchError as exc:
        print(f"ERROR: {exc}\nExisting file left untouched.", file=sys.stderr)
        return 1

    features, seen, skipped, repaired = [], set(), [], []
    tagged = [(el, kind_of(el.get("tags", {}))) for el in elements] + [(el, "GOVERNMENT") for el in offices]
    for el, kind in tagged:
        key = f"osm_{el['type']}_{el['id']}"
        if el["type"] == "node" or key in seen:
            continue
        tags = el.get("tags", {})
        try:
            geom = element_polygon(el)
        except Exception:
            geom = repaired_relation(el)  # broken OSM multipolygon: node its own outer lines
            if geom is None:
                skipped.append(f"{key} ({tags.get('name') or kind})")
                continue
            repaired.append(f"{key} ({tags.get('name') or kind})")
        if kind is None or geom is None or geom.is_empty or not geom.intersects(city) or area_m2(geom) < MIN_AREA_M2:
            continue
        seen.add(key)
        features.append({
            "type": "Feature",
            "properties": {
                "id": key,
                "kind": kind,
                "name": tags.get("name") or tags.get("official_name"),
                "osmTags": {k: tags[k] for k in ("aeroway", "icao", "landuse", "military", "office", "government",
                                                  "building", "operator") if k in tags},
            },
            "geometry": round_coords(mapping(geom.simplify(0.00001, preserve_topology=True))),
        })

    counts = {k: sum(1 for f in features if f["properties"]["kind"] == k) for k in ("AIRPORT", "MILITARY", "GOVERNMENT")}
    if not counts["AIRPORT"]:
        print("ERROR: no aerodrome found; Overpass result looks incomplete. Existing file left untouched.", file=sys.stderr)
        return 1
    union_km2 = area_m2(unary_union([shape(f["geometry"]) for f in features])) / 1e6
    out = {
        "type": "FeatureCollection",
        "metadata": {
            "source": "OpenStreetMap contributors (ODbL), via Overpass API",
            "fetchedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "description": "SkyRoute PLANNING CONSTRAINTS: OSM-mapped airport, military and government areas that the "
                           "simulation avoids by policy. NOT official UAS geographical zones and not a legal no-fly "
                           "boundary.",
            "counts": counts,
            "areaKm2": round(union_km2, 2),
        },
        "features": features,
    }
    PLANNING_CONSTRAINTS_FILE.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    for msg in repaired:
        print(f"  repaired invalid OSM multipolygon from its outer ways: {msg}")
    for msg in skipped:
        print(f"  skipped invalid OSM geometry: {msg}")
    print(f"wrote {PLANNING_CONSTRAINTS_FILE}: {counts}, {union_km2:.1f} km² (union)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
