"""One-off import of mapped building entrances (OSM `entrance=*` nodes) in Warsaw.

    backend/.venv/Scripts/python scripts/fetch_entrances.py

Writes data/osm/entrances.json.gz (committed; the backend never calls Overpass):
a compact list of [osm_id, lon, lat, entrance, ref, addr:flats, housenumber,
street, wheelchair]. Only mapped entrances are stored; none are invented.
`addr:flats` (when mapped) is the only basis for linking a flat to an entrance.
"""

from __future__ import annotations

import gzip
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

import shapely
from shapely.geometry import Point, shape

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT / "scripts"))
sys.path.insert(0, str(REPO_ROOT / "backend"))
from fetch_osm import FetchError, tiled_query  # noqa: E402

from app.config import BOUNDARY_CITY_FILE, ENTRANCES_FILE  # noqa: E402

BODY = 'node["entrance"]["entrance"!="no"];'
FIELDS = ["osmId", "lon", "lat", "entrance", "ref", "flats", "housenumber", "street", "wheelchair"]
MIN_EXPECTED = 1000


def main() -> int:
    sys.stdout.reconfigure(encoding="utf-8")
    city = shape(json.loads(BOUNDARY_CITY_FILE.read_text(encoding="utf-8"))["features"][0]["geometry"])
    shapely.prepare(city)
    try:
        elements = tiled_query(BODY, "entrances", city.bounds)
    except FetchError as exc:
        print(f"ERROR: {exc}\nExisting file left untouched.", file=sys.stderr)
        return 1
    rows = []
    for el in elements:
        if el.get("type") != "node" or not city.covers(Point(el["lon"], el["lat"])):
            continue
        t = el.get("tags", {})
        rows.append([f"node/{el['id']}", round(el["lon"], 7), round(el["lat"], 7), t.get("entrance"), t.get("ref"),
                     t.get("addr:flats"), t.get("addr:housenumber"), t.get("addr:street"), t.get("wheelchair")])
    if len(rows) < MIN_EXPECTED:
        print(f"ERROR: implausible result ({len(rows)} entrances); nothing written.", file=sys.stderr)
        return 1
    rows.sort(key=lambda r: r[0])
    doc = {
        "metadata": {"source": "OpenStreetMap contributors (ODbL), via Overpass API (entrance=*)",
                     "importedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                     "fields": FIELDS, "count": len(rows),
                     "note": "Mapped entrances only. Flat-to-entrance links exist only where addr:flats is mapped."},
        "rows": rows,
    }
    ENTRANCES_FILE.write_bytes(gzip.compress(json.dumps(doc, ensure_ascii=False, separators=(",", ":")).encode("utf-8"), 6))
    with_flats = sum(1 for r in rows if r[5])
    print(f"wrote {ENTRANCES_FILE.relative_to(REPO_ROOT)}: {len(rows)} entrances ({with_flats} with addr:flats)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
