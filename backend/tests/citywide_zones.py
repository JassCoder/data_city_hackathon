"""SYNTHETIC citywide zone fixtures for deterministic tests (not official data).

Zones are spread over northern, southern, eastern and western Warsaw and sit
across the straight line of several district pairs, so citywide loading,
evaluation and avoidance can be tested. Every id starts with TEST- and every
name says "TEST fixture". None is placed on an airport; the airport fixtures
are separate (`AIRPORT_FIXTURES`), irregular polygons used only in pytest.

Write the fixture as a GeoJSON file for a manual/E2E run of the real app:

    backend/.venv/Scripts/python -m tests.citywide_zones <out.geojson>    (from backend/)
    SKYROUTE_AIRSPACE_PROVIDER=geojson SKYROUTE_AIRSPACE_FILE=<out.geojson> uvicorn app.main:app
"""

from __future__ import annotations

import json
import sys
from datetime import datetime, timezone
from pathlib import Path

from shapely.geometry import MultiPolygon, Polygon, box

from app.airspace.models import AirspaceZone
from tests.conftest import zone


def _rect(lat: float, lon: float, h_m: float, w_m: float) -> Polygon:
    """Rectangle centred on (lat, lon), height/width in metres (small-area approximation)."""
    dlat, dlon = h_m / 2 / 111_320, w_m / 2 / (111_320 * 0.6123)  # cos(52.2 deg)
    return box(lon - dlon, lat - dlat, lon + dlon, lat + dlat)


def _named(z: AirspaceZone, label: str) -> AirspaceZone:
    return z.model_copy(update={"name": f"TEST fixture: {label} (synthetic, not an official zone)",
                                "source": "SkyRoute TEST fixture (synthetic)"})


_RING_OUTER = _rect(52.1868, 20.9946, 1100, 1100)
_RING_HOLE = _rect(52.1868, 20.9946, 500, 500)

# district -> zone, all ids TEST-*
CITYWIDE_ZONES: list[AirspaceZone] = [
    # North (Białołęka), across the Białołęka -> Śródmieście line.
    _named(zone("TEST-P-NORTH", _rect(52.3050, 21.0085, 900, 1300), category="DRA-P"), "prohibited area, north"),
    # South (Ursynów), across the Ursynów -> Wawer line.
    _named(zone("TEST-RM-SOUTH", _rect(52.1470, 21.0600, 900, 1100), category="DRA-RM"), "restricted area, south"),
    # East (Wesoła): U-space.
    _named(zone("TEST-U-EAST", _rect(52.2380, 21.2150, 800, 1000), category="DRA-U", upper=120), "U-space area, east"),
    # Praga-Południe, across the Praga-Południe -> Rembertów line: technical requirements.
    _named(zone("TEST-T-EAST-MID", _rect(52.2507, 21.1174, 900, 900), category="DRA-T", upper=120),
           "technical-requirements area, Praga-Południe"),
    # West (Bemowo): a MultiPolygon restricted zone.
    _named(zone("TEST-R-WEST", MultiPolygon([_rect(52.2350, 20.9050, 500, 600), _rect(52.2290, 20.9100, 400, 500)]),
                category="DRA-R"), "restricted area in two parts, west"),
    # Mokotów, across the Włochy -> Mokotów line: a ring with a hole (holes must survive end to end).
    _named(zone("TEST-RL-RING", Polygon(_RING_OUTER.exterior.coords, [_RING_HOLE.exterior.coords]), category="DRA-RL"),
           "restricted ring with a hole, Mokotów"),
    # Wilanów: information only (crossed with a warning).
    _named(zone("TEST-I-WILANOW", _rect(52.1632, 21.1051, 800, 800), category="DRA-I", upper=120),
           "information area, Wilanów"),
    # Across the Wilanów -> Żoliborz line, but only 0-60 m AGL: inactive at 80 m, an obstacle at 40 m.
    _named(zone("TEST-RH-LOW", _rect(52.2103, 21.0434, 700, 900), category="DRA-RH", upper=60),
           "restricted area below 60 m AGL, Powiśle"),
    # Targówek: temporary, active only in November 2026.
    _named(zone("TEST-RL-TEMP", _rect(52.2850, 21.0650, 700, 700), category="DRA-RL",
                start=datetime(2026, 11, 1, tzinfo=timezone.utc), end=datetime(2026, 11, 30, 23, 59, tzinfo=timezone.utc)),
           "temporary restricted area (Nov 2026), Targówek"),
    # Ursus: incomplete metadata -> treated as blocked.
    _named(zone("TEST-X-URSUS", _rect(52.1958, 20.8821, 500, 500), category="UNKNOWN", lower=None, upper=None,
                ref="UNKNOWN"), "zone with incomplete metadata, Ursus"),
    # Straddles the southern city boundary; its centroid lies outside Warsaw.
    _named(zone("TEST-P-BOUNDARY", box(21.0700, 52.0850, 21.0900, 52.1020), category="DRA-P"),
           "prohibited area overlapping the southern city boundary"),
    # Entirely outside Warsaw (Piaseczno area): loaded, but touches no district.
    _named(zone("TEST-R-OUTSIDE", _rect(52.0700, 21.0200, 800, 800), category="DRA-R"), "restricted area outside Warsaw"),
]

# Airport-related fixtures: irregular synthetic polygons near EPWA / EPBC, used to
# test altitude-dependent and AMSL rules. They are NOT the real airport zones.
AIRPORT_FIXTURES: list[AirspaceZone] = [
    # Restricted only from 40 m AGL up: low flights pass, higher flights must avoid it.
    _named(zone("TEST-AIRPORT-EPWA", Polygon([(20.950, 52.158), (20.985, 52.160), (20.990, 52.176), (20.960, 52.180),
                                               (20.945, 52.170)]),
                category="DRA-R", lower=40, upper=None), "airport-related restricted area above 40 m AGL (near EPWA)"),
    # AMSL ceiling: compared through the terrain range (no DEM).
    _named(zone("TEST-AIRPORT-EPBC", Polygon([(20.900, 52.262), (20.922, 52.263), (20.924, 52.275), (20.903, 52.276)]),
                category="DRA-R", lower=None, upper=150, ref="AMSL"),
           "airport-related restricted area below 150 m AMSL (near EPBC)"),
]


def feature_collection(zones: list[AirspaceZone], extent: dict | None, label: str) -> dict:
    """Normalized GeoJSON (the format `GeoJsonZoneFileProvider` reads)."""
    features = []
    for z in zones:
        props = z.model_dump(mode="json", by_alias=True)
        features.append({"type": "Feature", "geometry": props.pop("geojsonGeometry"), "properties": props})
    return {
        "type": "FeatureCollection",
        "metadata": {
            "provider": "skyroute-test-fixture",
            "sourceType": "SYNTHETIC",
            "label": label,
            "sourceTimestamp": "2026-10-18T00:00:00Z",
            "disclaimer": "SYNTHETIC TEST FIXTURE. Not official PAŻP geographical zones.",
            **({"extent": extent} if extent else {}),
            "extentLabel": "TEST fixture: synthetic zones spread across all of Warsaw",
        },
        "features": features,
    }


if __name__ == "__main__":
    out = Path(sys.argv[1])
    # Extent = the city's bounding box, so every district counts as covered (by synthetic data).
    doc = feature_collection(CITYWIDE_ZONES, {"minLon": 20.85, "minLat": 52.09, "maxLon": 21.28, "maxLat": 52.37},
                             "SkyRoute TEST fixture: synthetic citywide zones (NOT official)")
    out.write_text(json.dumps(doc, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"wrote {out}: {len(doc['features'])} zones")
