"""Writes optional synthetic sample datasets:

- data/airspace/sample_zones.geojson: UAS geographical-zone test examples using Polish
  DRA categories, in the normalized airspace format (app/airspace/models.py).
- data/landing_stations.geojson

Everything here is invented. The zone boundaries are NOT official PAŻP zones,
and the stations are NOT real facilities. The app does not load these zones by
default. Edit the tables below and re-run:

    backend/.venv/Scripts/python scripts/build_sample_data.py
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

from shapely.geometry import Point, Polygon, mapping, shape

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT / "backend"))
from app.airspace.geometry import geodesic_circle  # noqa: E402
from app.config import AIRSPACE__FILE, DATA_DIR, DATA_FILES, _BBOX  # noqa: E402

TIMESTAMP = "2026-10-17T00:00:00Z"
DISCLAIMER = (
    "Synthetic sample zones for testing only. These boundaries are invented and are NOT "
    "official PAŻP geographical zones."
)

BASE = {
    "source": "SkyRoute set (synthetic)",
    "sourceType": "SYNTHETIC",
    "sourceTimestamp": TIMESTAMP,
    "verificationStatus": "SYNTHETIC",
    "validityStart": None,
    "validityEnd": None,
}

# Each zone: normalized properties + either "ring" (polygon, lon/lat) or "circle".
ZONES = [
    {
        "id": "-P-SEJM", "name": " prohibited area: Sejm / Wiejska",
        "draCategory": "DRA-P", "restrictionType": "PROHIBITED",
        "lowerAltitude": 0, "upperAltitude": 300, "altitudeReference": "AGL",
        "authorizationRequired": True,
        "operationalConditions": "Synthetic example of a DRA-P zone: only narrowly defined state operations.",
        "ring": [(21.0245, 52.2238), (21.0322, 52.2236), (21.0330, 52.2262), (21.0290, 52.2275), (21.0250, 52.2268)],
    },
    {
        "id": "-P-CASTLE", "name": " prohibited circle: Royal Castle",
        "draCategory": "DRA-P", "restrictionType": "PROHIBITED",
        "lowerAltitude": None, "upperAltitude": 350, "altitudeReference": "AMSL",
        "authorizationRequired": True,
        "operationalConditions": "Synthetic circular DRA-P example (centre + radius), AMSL ceiling.",
        "circle": {"center": [21.0152, 52.2478], "radiusM": 140},
    },
    {
        "id": "-RM-PKIN", "name": " restricted area: Palace of Culture",
        "draCategory": "DRA-RM", "restrictionType": "AUTHORIZATION_REQUIRED",
        "lowerAltitude": 0, "upperAltitude": 250, "altitudeReference": "AGL",
        "authorizationRequired": True,
        "operationalConditions": "Synthetic DRA-RM example: consent from the zone requester required.",
        "ring": [(21.0040, 52.2300), (21.0098, 52.2300), (21.0098, 52.2340), (21.0040, 52.2340)],
    },
    *[
        {
            "id": f"-RH-SCHOOL-{key}", "name": f" restricted circle: school, {label}",
            "draCategory": "DRA-RH", "restrictionType": "AUTHORIZATION_REQUIRED",
            "lowerAltitude": 0, "upperAltitude": 60, "altitudeReference": "AGL",
            "authorizationRequired": True,
            "operationalConditions": "Synthetic DRA-RH example limited to 0–60 m AGL (not applicable to higher cruise).",
            "circle": {"center": [lon, lat], "radiusM": 100},
        }
        for key, label, lon, lat in [
            ("POWISLE", "Powiśle", 21.0255, 52.2390),
            ("SOUTH", "Śródmieście Południowe", 21.0165, 52.2205),
            ("MIROW", "Mirów", 20.9935, 52.2420),
        ]
    ],
    {
        "id": "-T-UW", "name": " technical-requirements area: University campus",
        "draCategory": "DRA-T", "restrictionType": "TECHNICAL_REQUIREMENTS",
        "lowerAltitude": 0, "upperAltitude": 120, "altitudeReference": "AGL",
        "authorizationRequired": None,
        "operationalConditions": "Synthetic DRA-T example: Remote ID and geo-awareness required.",
        "ring": [(21.0172, 52.2392), (21.0212, 52.2392), (21.0215, 52.2418), (21.0175, 52.2420)],
    },
    {
        "id": "-U-PORT", "name": " U-space area: Port Czerniakowski",
        "draCategory": "DRA-U", "restrictionType": "USPACE_SERVICES_REQUIRED",
        "lowerAltitude": 0, "upperAltitude": 120, "altitudeReference": "AGL",
        "authorizationRequired": None,
        "operationalConditions": "Synthetic DRA-U example: network identification and traffic information services.",
        "ring": [(21.0400, 52.2170), (21.0470, 52.2170), (21.0470, 52.2205), (21.0400, 52.2205)],
    },
    {
        "id": "-I-VISTULA", "name": " information area: Vistula bridge works",
        "draCategory": "DRA-I", "restrictionType": "INFORMATION",
        "lowerAltitude": 0, "upperAltitude": 120, "altitudeReference": "AGL",
        "authorizationRequired": False,
        "operationalConditions": "Synthetic navigation warning: cranes up to 40 m near the bridges.",
        "ring": [(21.0330, 52.2330), (21.0430, 52.2330), (21.0470, 52.2400), (21.0360, 52.2410)],
    },
    {
        "id": "-RL-EVENT", "name": " temporary restricted area: Plac Piłsudskiego event",
        "draCategory": "DRA-RL", "restrictionType": "AUTHORIZATION_REQUIRED",
        "lowerAltitude": 0, "upperAltitude": 150, "altitudeReference": "AGL",
        "authorizationRequired": True,
        "operationalConditions": "Synthetic temporary zone, expired: shows validity-period handling.",
        "validityStart": "2026-09-01T00:00:00Z", "validityEnd": "2026-09-30T23:59:59Z",
        "ring": [(21.0085, 52.2400), (21.0140, 52.2400), (21.0140, 52.2430), (21.0085, 52.2430)],
    },
    {
        "id": "-X-INCOMPLETE", "name": " zone with incomplete metadata",
        "draCategory": "UNKNOWN", "restrictionType": "UNKNOWN",
        "lowerAltitude": None, "upperAltitude": None, "altitudeReference": "UNKNOWN",
        "authorizationRequired": None, "operationalConditions": None,
        "verificationStatus": "INSUFFICIENT_DATA",
        "ring": [(20.9962, 52.2364), (20.9988, 52.2364), (20.9988, 52.2378), (20.9962, 52.2378)],
    },
]

# (id, name, station_type, status, capacity, lon, lat)
STATIONS = [
    ("st-hospital", "Śródmieście Hospital Pad", "HOSPITAL", "AVAILABLE", 2, 20.9930, 52.2300),
    # On a ~21 m roof, below the 30 m minimum flight altitude.
    ("st-rooftop", "Powiśle Rooftop Pad", "ROOFTOP", "AVAILABLE", 1, 21.02877, 52.23747),
    ("st-park", "Rydz-Śmigły Park Pad", "PARK", "AVAILABLE", 2, 21.0395, 52.2300),
    ("st-depot", "Vistula Boulevard Depot", "DEPOT", "AVAILABLE", 6, 21.0385, 52.2352),
]


def _round(coords, nd=7):
    if isinstance(coords[0], (int, float)):
        return [round(c, nd) for c in coords]
    return [_round(c, nd) for c in coords]


def _zone_feature(z: dict) -> dict:
    props = {**BASE, **{k: v for k, v in z.items() if k != "ring"}}
    geometry = None
    if "ring" in z:
        g = mapping(Polygon(z["ring"]))
        geometry = {"type": g["type"], "coordinates": _round(g["coordinates"])}
    return {"type": "Feature", "properties": props, "geometry": geometry}


def _zone_area(z: dict):
    if "circle" in z:
        (lon, lat), r = z["circle"]["center"], z["circle"]["radiusM"]
        return geodesic_circle(lon, lat, r)
    return Polygon(z["ring"])


def main() -> None:
    zones = {
        "type": "FeatureCollection",
        "metadata": {
            "provider": "skyroute-sample",
            "sourceType": "SYNTHETIC",
            "label": "Synthetic sample airspace (not official)",
            "sourceTimestamp": TIMESTAMP,
            "disclaimer": DISCLAIMER,
            # The synthetic zones were only drawn for central Warsaw: elsewhere zones are unknown.
            "extent": _BBOX,
            "extentLabel": "Sample zones exist only for central Warsaw (Śródmieście / Powiśle)",
        },
        "features": [_zone_feature(z) for z in ZONES],
    }
    stations = {
        "type": "FeatureCollection",
        "metadata": {
            "layer": "landing_stations",
            "source": "SYNTHETIC",
            "disclaimer": "Synthetic sample landing locations; not real facilities.",
            "timestamp": TIMESTAMP,
        },
        "features": [
            {
                "type": "Feature",
                "properties": {"id": sid, "name": name, "station_type": stype, "status": status,
                               "capacity": capacity, "source": "SYNTHETIC"},
                "geometry": mapping(Point(lon, lat)),
            }
            for sid, name, stype, status, capacity, lon, lat in STATIONS
        ],
    }

    # Stations may sit in information zones only.
    for s in stations["features"]:
        pt = shape(s["geometry"])
        for z in ZONES:
            if z["draCategory"] != "DRA-I" and _zone_area(z).intersects(pt):
                raise SystemExit(f"Station {s['properties']['id']} lies inside zone {z['id']}")

    AIRSPACE__FILE.parent.mkdir(parents=True, exist_ok=True)
    AIRSPACE__FILE.write_text(json.dumps(zones, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"wrote {AIRSPACE__FILE.relative_to(REPO_ROOT)}: {len(zones['features'])} zones")
    path = DATA_DIR / DATA_FILES["stations"]
    path.write_text(json.dumps(stations, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"wrote {path.relative_to(REPO_ROOT)}: {len(stations['features'])} stations")


if __name__ == "__main__":
    main()
