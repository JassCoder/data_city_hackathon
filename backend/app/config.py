"""App-wide settings. Routing weights live in app/routing/costs.py, not here."""

import os
from pathlib import Path

API_PREFIX = "/api/v1"
APP_VERSION = "0.1.0"

REPO_ROOT = Path(__file__).resolve().parents[2]
DATA_DIR = REPO_ROOT / "data"

# Angular dev server origins.
CORS_ORIGINS = [
    "http://localhost:4200",
    "http://127.0.0.1:4200",
]

# Demo area: central Warsaw (Śródmieście + Powiśle + Vistula), ~4.4 x 3.9 km, WGS84.
# Single source of truth: scripts/fetch_osm.py, /health and /layers all read this.
MAP_CENTER = (52.2297, 21.0122)  # lat, lon
DEMO_BBOX = {
    "minLon": 20.985,  # west
    "minLat": 52.215,  # south
    "maxLon": 21.050,  # east
    "maxLat": 52.250,  # north
}

# File names inside DATA_DIR.
DATA_FILES = {
    "corridors": "corridors.geojson",
    "tall_buildings": "tall_buildings.geojson",  # >= 50 m, citywide overview (all buildings: tiles)
    "stations": "landing_stations.geojson",
}

DRONE_PROFILES_FILE = "drone_profiles.json"
# Weights and parameters of the multi-criteria SAFEST objective (app/routing/risk).
COST_MODEL_FILE = DATA_DIR / "cost_model.json"
# Headless drone simulation (app/sim): engine parameters and example scenarios.
SIM_CONFIG_FILE = DATA_DIR / "sim_config.json"
SIM_SCENARIOS_DIR = DATA_DIR / "sim_scenarios"

# Citywide coverage: the official Warsaw boundary (GUGiK PRG, TERYT 1465) and
# its 18 districts, cached by scripts/fetch_boundaries.py.
BOUNDARY_CITY_FILE = DATA_DIR / "boundaries" / "warsaw_city.geojson"
BOUNDARY_DISTRICTS_FILE = DATA_DIR / "boundaries" / "warsaw_districts.geojson"
# Shown only when the boundary file is missing (never used for routing coverage).
FALLBACK_VIEW = {"center": [52.2297, 21.0122], "zoom": 11}

# Citywide OSM products written by scripts/fetch_osm.py.
OSM_DIR = DATA_DIR / "osm"
CITY_GRID_FILE = OSM_DIR / "grid_warsaw_25m.npz"  # routing raster (buildings, river, parks)
RISK_RASTER_FILE = OSM_DIR / "risk_warsaw_25m.npz"  # SAFEST: floor area, land use, POIs (scripts/fetch_risk_layers.py)
BUILDING_TILES_DIR = OSM_DIR / "tiles"  # {z}/{x}/{y}.json.gz, display only
BUILDING_TILE_ZOOM = 14
BUILDINGS_INDEX_FILE = OSM_DIR / "buildings_index.json"

# Airspace (UAS geographical zones). Provider is chosen by environment:
#   SKYROUTE_AIRSPACE_PROVIDER=demo (default) | geojson | ed269
#   SKYROUTE_AIRSPACE_FILE=<path>  (required for geojson / ed269)
AIRSPACE_PROVIDER = os.environ.get("SKYROUTE_AIRSPACE_PROVIDER", "demo")
AIRSPACE_FILE = os.environ.get("SKYROUTE_AIRSPACE_FILE")
AIRSPACE_DEMO_FILE = DATA_DIR / "airspace" / "demo_zones.geojson"
AIRSPACE_SAFETY_MARGIN_M = 20.0  # horizontal buffer added to obstacle zones for routing
AIRSPACE_VERTICAL_MARGIN_M = 10.0  # added above/below the flight band when comparing altitudes
AIRSPACE_NEAR_ROUTE_M = 60.0  # report blocked zones closer than this to the route
AIRSPACE_CIRCLE_SEGMENTS = 128  # geodesic circle approximation (< 0.04 % radius error)
# No DEM yet: AMSL-referenced zones are compared using this terrain range (m AMSL)
# for the demo area (Vistula ~78 m to Śródmieście ~115 m), conservatively.
TERRAIN_ELEVATION_RANGE_M_AMSL = (75.0, 120.0)

COVERAGE_LABEL = (
    "Śródmieście, Powiśle and the Vistula "
    f"(lat {DEMO_BBOX['minLat']:.3f}–{DEMO_BBOX['maxLat']:.3f}, "
    f"lon {DEMO_BBOX['minLon']:.3f}–{DEMO_BBOX['maxLon']:.3f})"
)

USER_AGENT = "SkyRouteWarsaw/0.3 (hackathon route-planning prototype; server-side, cached)"

# Geocoding: public Nominatim, server-side only, <= 1 request/s, cached.
NOMINATIM_URL = "https://nominatim.openstreetmap.org/search"
GEOCODING_VIEWBOX = "20.85,52.37,21.27,52.09"  # Warsaw city: left,top,right,bottom
GEOCODING_MIN_INTERVAL_S = 1.0
GEOCODING_MAX_WAIT_S = 5.0
GEOCODING_CACHE_TTL_S = 24 * 3600
GEOCODING_CACHE_MAX = 512
GEOCODING_RESULT_LIMIT = 8

# Weather.
OPEN_METEO_URL = "https://api.open-meteo.com/v1/forecast"
WEATHER_TIMEOUT_S = 5.0
WEATHER_CACHE_TTL_S = 600
DEMO_WEATHER = {"windSpeedKmh": 14.0, "windDirectionDeg": 250.0, "windGustKmh": 22.0}
WEATHER_SAMPLE_SPACING_KM = 5.0  # LIVE: one forecast point per ~5 km of the A-B line
WEATHER_MAX_SAMPLES = 8
WEATHER_SAMPLE_GRID_DEG = 0.02  # snap sample points (~2 km) so nearby trips share the cache

# Corridor search (app/routing/planner.py). A window around A-B is searched
# first and widened up to the whole city if no path is found inside it.
ROUTE_MIN_MARGIN_M = 1500.0  # window margin around the A-B box
ROUTE_MARGIN_FACTOR = 0.35  # extra margin as a fraction of the A-B distance
ROUTE_MARGIN_GROWTH = 2.5  # margin multiplier per retry
ROUTE_MAX_FINE_CELLS = 300_000  # larger windows are coarsened (conservatively) to stay under this
ROUTE_MAX_EXPANSIONS = 1_200_000  # A* node budget per attempt
ROUTE_TIME_LIMIT_S = 20.0  # total search time budget per request
ROUTE_CACHE_SIZE = 128

# Buildings are simplified for the /layers response only (routing keeps full detail).
LAYERS_SIMPLIFY_TOLERANCE_DEG = 0.00001  # ~1 m
LAYERS_COORD_DECIMALS = 6  # ~0.1 m
