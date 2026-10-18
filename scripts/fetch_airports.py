"""One-off download of airports (OSM aeroway=aerodrome) in and around Warsaw.

    backend/.venv/Scripts/python scripts/fetch_airports.py

Writes data/airports.geojson (committed; the backend never calls Overpass).
Each feature is the mapped aerodrome area (its real OSM boundary, never a
circle) with its ICAO/IATA codes, plus the runways inside it.

These are INFORMATIVE locations, not UAS geographical zones: an airport
footprint is not a drone no-fly area by itself. Airport-related drone
restrictions (DRA-R inside the CTR, height limits) come only from an official
zone dataset (SKYROUTE_AIRSPACE_PROVIDER=ed269|geojson).
"""

from __future__ import annotations

import json
import sys
from datetime import datetime, timezone
from pathlib import Path

from shapely.geometry import LineString, mapping, shape

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT / "scripts"))
sys.path.insert(0, str(REPO_ROOT / "backend"))
from fetch_osm import FetchError, element_polygon, overpass, round_coords  # noqa: E402

from app.config import AIRPORTS_FILE, BOUNDARY_CITY_FILE  # noqa: E402

MARGIN_DEG = 0.05  # also fetch aerodromes just outside the city (routing corridors near the boundary)
REQUIRED_ICAO = {"EPWA", "EPBC"}  # validation: both Warsaw airports must be present

QUERY = """[out:json][timeout:120][bbox:{s},{w},{n},{e}];
(way["aeroway"="aerodrome"]; relation["aeroway"="aerodrome"]; node["aeroway"="aerodrome"];);
out geom;
(way["aeroway"="runway"];);
out geom;"""


def main() -> int:
    sys.stdout.reconfigure(encoding="utf-8")
    city = shape(json.loads(BOUNDARY_CITY_FILE.read_text(encoding="utf-8"))["features"][0]["geometry"])
    w, s, e, n = city.bounds
    q = QUERY.format(s=s - MARGIN_DEG, w=w - MARGIN_DEG, n=n + MARGIN_DEG, e=e + MARGIN_DEG)
    try:
        elements = overpass(q, "airports")
    except FetchError as exc:
        print(f"ERROR: {exc}\nExisting file left untouched.", file=sys.stderr)
        return 1

    runways = []
    for el in elements:
        if el.get("tags", {}).get("aeroway") == "runway" and el.get("geometry"):
            runways.append((el, LineString([(p["lon"], p["lat"]) for p in el["geometry"]])))

    features = []
    for el in elements:
        tags = el.get("tags", {})
        if tags.get("aeroway") != "aerodrome" or el["type"] == "node":
            continue  # nodes have no footprint; every Warsaw airfield is mapped as an area
        geom = element_polygon(el)
        if geom is None or geom.is_empty:
            continue
        refs = [r.get("tags", {}).get("ref") for r, line in runways if geom.intersects(line)]
        rws = list(dict.fromkeys(ref for ref in refs if ref))  # a runway is often mapped as several ways
        rp = geom.representative_point()
        g = mapping(geom.simplify(0.00002, preserve_topology=True))
        features.append({
            "type": "Feature",
            "properties": {
                "id": f"osm_{el['type']}_{el['id']}",
                "name": tags.get("name"),
                "icao": tags.get("icao"),
                "iata": tags.get("iata"),
                "aerodromeType": tags.get("aerodrome:type") or tags.get("aerodrome"),
                "operator": tags.get("operator"),
                "runways": rws,
                "insideWarsaw": bool(city.intersects(geom)),
                "labelPoint": [round(rp.x, 6), round(rp.y, 6)],
                "source": "OpenStreetMap contributors (ODbL), via Overpass API",
            },
            "geometry": {"type": g["type"], "coordinates": round_coords(g["coordinates"])},
        })

    found = {f["properties"]["icao"] for f in features}
    missing = REQUIRED_ICAO - found
    if missing:
        print(f"ERROR: expected airports not found: {sorted(missing)}; nothing written.", file=sys.stderr)
        return 1
    doc = {
        "type": "FeatureCollection",
        "metadata": {
            "layer": "airports",
            "source": "OpenStreetMap contributors (ODbL), via Overpass API (aeroway=aerodrome)",
            "fetchedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "disclaimer": "Airport locations and mapped boundaries, for information. NOT UAS geographical zones and "
                          "not drone no-fly areas by themselves; airport-related drone restrictions require official "
                          "PAŻP zone data.",
        },
        "features": sorted(features, key=lambda f: (not f["properties"]["insideWarsaw"], f["properties"]["name"] or "")),
    }
    AIRPORTS_FILE.write_text(json.dumps(doc, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"wrote {AIRPORTS_FILE.relative_to(REPO_ROOT)}: {len(features)} aerodromes "
          f"({', '.join(f['properties']['name'] or '?' for f in doc['features'])})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
