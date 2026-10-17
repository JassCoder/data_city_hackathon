"""Downloads the official Warsaw boundary and its 18 districts from GUGiK's
Państwowy Rejestr Granic (PRG) OGC API Features and caches them in
data/boundaries/. Run once (results are committed):

    backend/.venv/Scripts/python scripts/fetch_boundaries.py

Features are selected by TERYT code, not by name:
  - city:      GranicaPowiatu, kod == "1465" (miasto stołeczne Warszawa, city with county rights)
  - districts: GranicaJednostkiEwidencyjnej, kod == "1465NN_8" (dzielnice)
Nothing is written unless all checks pass.
"""

from __future__ import annotations

import json
import os
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

import httpx
import shapely
from pyproj import Transformer
from shapely.geometry import mapping, shape
from shapely.ops import unary_union

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT / "backend"))
from app.config import BOUNDARY_CITY_FILE, BOUNDARY_DISTRICTS_FILE, USER_AGENT  # noqa: E402

API = "https://ogcapi.geoportal.gov.pl/res/ims/maps/PRG/apiFeatures/collections"
SEARCH_BBOX = "20.80,52.05,21.32,52.42"  # generous box around Warsaw, only used to page the query
CITY_TERYT = "1465"
DISTRICT_RE = re.compile(r"^1465(0[2-9]|1[0-9])_8$")
SOURCE = "GUGiK – Państwowy Rejestr Granic (PRG), OGC API Features"

_to_m = Transformer.from_crs("EPSG:4326", "EPSG:2180", always_xy=True).transform


def area_km2(geom) -> float:
    return shapely.transform(geom, lambda x, y: _to_m(x, y), interleaved=False).area / 1e6


def fetch(collection: str) -> list[dict]:
    url = f"{API}/{collection}/items"
    params = {"f": "json", "bbox": SEARCH_BBOX, "limit": 500}
    features: list[dict] = []
    with httpx.Client(headers={"User-Agent": USER_AGENT}, timeout=180) as client:
        while url:
            res = client.get(url, params=params)
            res.raise_for_status()
            doc = res.json()
            features += doc["features"]
            url = next((l["href"] for l in doc.get("links", []) if l.get("rel") == "next"), None)
            params = None  # the next link carries its own query
    print(f"{collection}: {len(features)} features in search box")
    return features


def feature(f: dict, extra: dict) -> dict:
    p = f["properties"]
    return {
        "type": "Feature",
        "properties": {
            "teryt": p["kod"],
            "name": p["nazwaJednostki"].replace(" - dzielnica", ""),
            "officialName": p["nazwaJednostki"],
            "areaHa": p.get("powierzchnia"),
            "prgId": p.get("idLokalny"),
            "prgVersion": p.get("idWersja"),
            "validFrom": p.get("waznyOd"),
            **extra,
        },
        "geometry": mapping(shape(f["geometry"])),
    }


def main() -> int:
    try:
        powiaty = fetch("GranicaPowiatu")
        jednostki = fetch("GranicaJednostkiEwidencyjnej")
    except (httpx.HTTPError, KeyError, ValueError) as exc:
        print(f"ERROR: PRG request failed: {exc}. Existing files were left untouched.", file=sys.stderr)
        return 1

    city = [f for f in powiaty if f["properties"].get("kod") == CITY_TERYT]
    districts = [f for f in jednostki if DISTRICT_RE.match(f["properties"].get("kod", ""))]
    if len(city) != 1 or len(districts) != 18:
        print(f"ERROR: expected 1 city and 18 districts, got {len(city)} and {len(districts)}", file=sys.stderr)
        return 1

    city_geom = shape(city[0]["geometry"])
    union = unary_union([shape(d["geometry"]) for d in districts])
    a_city, a_union = area_km2(city_geom), area_km2(union)
    if abs(a_city - a_union) / a_city > 0.01:
        print(f"ERROR: districts ({a_union:.1f} km²) do not match the city ({a_city:.1f} km²)", file=sys.stderr)
        return 1

    retrieved = datetime.now(timezone.utc).isoformat(timespec="seconds")
    meta = {"source": SOURCE, "url": API, "retrievedAt": retrieved, "crs": "CRS84 (lon, lat)"}
    BOUNDARY_CITY_FILE.parent.mkdir(parents=True, exist_ok=True)
    city_fc = {"type": "FeatureCollection", "metadata": meta,
               "features": [feature(city[0], {"areaKm2": round(a_city, 2)})]}
    districts_fc = {"type": "FeatureCollection", "metadata": meta,
                    "features": sorted((feature(d, {"areaKm2": round(area_km2(shape(d["geometry"])), 2)})
                                        for d in districts), key=lambda f: f["properties"]["name"])}
    for path, doc in ((BOUNDARY_CITY_FILE, city_fc), (BOUNDARY_DISTRICTS_FILE, districts_fc)):
        tmp = path.with_suffix(".tmp")
        tmp.write_text(json.dumps(doc, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
        os.replace(tmp, path)
        print(f"wrote {path.relative_to(REPO_ROOT)} ({path.stat().st_size / 1e6:.2f} MB)")
    print(f"Warsaw: {a_city:.1f} km², bounds {tuple(round(v, 4) for v in city_geom.bounds)}; "
          f"districts: {', '.join(f['properties']['name'] for f in districts_fc['features'])}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
