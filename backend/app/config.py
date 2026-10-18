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

# Extent of the SYNTHETIC  airspace zones and stations only (central Warsaw, ~4.4 x 3.9 km,
# WGS84; scripts/build__data.py). It is NOT the application's coverage: routing,
# geocoding and all geographic data cover the whole official Warsaw polygon.
MAP_CENTER = (52.2297, 21.0122)  # lat, lon
_BBOX = {
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

# Citywide coverage: the official Warsaw boundary (GUGiK PRG, TERYT 1465) and
# its 18 districts, cached by scripts/fetch_boundaries.py.
BOUNDARY_CITY_FILE = DATA_DIR / "boundaries" / "warsaw_city.geojson"
BOUNDARY_DISTRICTS_FILE = DATA_DIR / "boundaries" / "warsaw_districts.geojson"
# Shown only when the boundary file is missing (never used for routing coverage).
FALLBACK_VIEW = {"center": [52.2297, 21.0122], "zoom": 11}

# Citywide OSM products written by scripts/fetch_osm.py.
OSM_DIR = DATA_DIR / "osm"
CITY_GRID_FILE = OSM_DIR / "grid_warsaw_25m.npz"  # routing raster (buildings, river, parks)
BUILDING_TILES_DIR = OSM_DIR / "tiles"  # {z}/{x}/{y}.json.gz, display only
BUILDING_TILE_ZOOM = 14
BUILDINGS_INDEX_FILE = OSM_DIR / "buildings_index.json"
# Buildings without an OSM height or level count have an UNKNOWN height; the data
# never invents one. How routing treats them is this explicit, configurable policy:
#   "assume:<m>"  obstacle up to <m> metres (default 15 m, roughly a 5-storey block)
#   "block"       obstacle at every flight altitude (most conservative)
UNKNOWN_BUILDING_POLICY = os.environ.get("SKYROUTE_UNKNOWN_BUILDING_POLICY", "assume:15")
BUILDINGS_MAX_QUERY_KM2 = 4.0  # GET /buildings?bbox= limit (use the z14 tiles for larger areas)
POI_DIR = DATA_DIR / "pois"  # real OSM hospitals + restaurants (scripts/fetch_pois.py)
ENTRANCES_FILE = OSM_DIR / "entrances.json.gz"  # mapped OSM building entrances (scripts/fetch_entrances.py)
AIRPORTS_FILE = DATA_DIR / "airports.geojson"  # OSM aerodromes (scripts/fetch_airports.py), informative only
# SkyRoute PLANNING CONSTRAINTS (scripts/fetch_planning_constraints.py): OSM airport, military and government
# areas avoided by policy. Not official zones. "off" disables them.
PLANNING_CONSTRAINTS_FILE = DATA_DIR / "planning_constraints.geojson"
PLANNING_CONSTRAINTS = os.environ.get("SKYROUTE_PLANNING_CONSTRAINTS", "on")

# Airspace (UAS geographical zones). Provider is chosen by environment:
#   SKYROUTE_AIRSPACE_PROVIDER=none (default) | geojson | ed269
#   SKYROUTE_AIRSPACE_FILE=<path>  (required for geojson / ed269)
AIRSPACE_PROVIDER = os.environ.get("SKYROUTE_AIRSPACE_PROVIDER", "none")
AIRSPACE_FILE = os.environ.get("SKYROUTE_AIRSPACE_FILE")
# Optional generated sample dataset used only when explicitly selected as a file provider.
AIRSPACE__FILE = DATA_DIR / "airspace" / "sample_zones.geojson"
AIRSPACE_STALE_AFTER_DAYS = 28  # official data older than one AIRAC cycle (or undated) is STALE
# Optional NON-REGULATORY planning constraints (request flag planningConstraints): the
# mapped OSM aerodrome footprints (data/airports.geojson), grown by this buffer, are
# avoided like obstacles. An assumption for conservative planning, never an official zone.
PLANNING_CONSTRAINT_BUFFER_M = float(os.environ.get("SKYROUTE_PLANNING_CONSTRAINT_BUFFER_M", "0"))
AIRSPACE_SAFETY_MARGIN_M = 20.0  # horizontal buffer added to obstacle zones for routing
AIRSPACE_VERTICAL_MARGIN_M = 10.0  # added above/below the flight band when comparing altitudes
AIRSPACE_NEAR_ROUTE_M = 60.0  # report blocked zones closer than this to the route
AIRSPACE_CIRCLE_SEGMENTS = 128  # geodesic circle approximation (< 0.04 % radius error)
# No DEM yet: AMSL-referenced zones are compared using this terrain range (m AMSL),
# conservatively (Vistula ~75 m to the higher natural ground ~120 m; approximate).
TERRAIN_ELEVATION_RANGE_M_AMSL = (75.0, 120.0)


USER_AGENT = "SkyRouteWarsaw/0.3 (hackathon route-planning prototype; server-side, cached)"

# Geocoding: public Nominatim, server-side only, <= 1 request/s, cached.
NOMINATIM_URL = "https://nominatim.openstreetmap.org/search"
# Official PRG address points via the public GUGiK geocoding service (building-level, exact numbers).
GUGIK_UUG_URL = "https://services.gugik.gov.pl/uug/"
GUGIK_MIN_INTERVAL_S = 0.2
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
WEATHER_STALE_MAX_S = 3 * 3600  # LIVE failure: last LIVE values may be shown as CACHED up to this age
_WEATHER = {"windSpeedKmh": 14.0, "windDirectionDeg": 250.0, "windGustKmh": 22.0}
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

# --- Simulated drone-delivery infrastructure (app/fleet) ---------------------------
# Real places (data/pois: OSM hospitals/restaurants) are kept separate from the
# SIMULATED stations, depots, pads, drones and orders stored in this SQLite file.
FLEET_DB_FILE = Path(os.environ.get("SKYROUTE_FLEET_DB", str(DATA_DIR / "fleet" / "fleet.sqlite")))
HOSPITAL_STATION_CAPACITY = int(os.environ.get("SKYROUTE_HOSPITAL_STATION_CAPACITY", "2"))
DEPOT_CAPACITY_STANDARD = 6
DEPOT_CAPACITY_HIGH_DEMAND = 12
PAD_CAPACITY_DEFAULT = 1
PAD_CAPACITY_MAX = 2
PAD_MAX_DISTANCE_FROM_FACILITY_M = 150.0  # a proposed pad must be near the restaurant/hospital
DEPOT_TARGET_COUNT = 10  # existing Vistula depot + planned sites
DEPOT_HIGH_DEMAND_COUNT = 3  # planned depots with the largest simulated demand share get the larger size
DEPOT_SERVICE_RADIUS_M = 6000.0  # planning assumption: demand beyond this from a depot counts as uncovered
DEPOT_CANDIDATE_SPACING_M = 1200.0
DEMO_HOSPITAL_STATIONS_ENABLED = 6  # hospital stations enabled for the simulation by the seed (labelled DEMO)
DEMO_RESTAURANT_PARTNERS = 6  # clearly labelled demo subscription partners
DRONES_PER_STANDARD_DEPOT = 4
DRONES_PER_HIGH_DEMAND_DEPOT = 8
DRONE_MIN_BATTERY_PCT = 25.0  # below this a drone is not dispatched
DRONE_RANGE_RESERVE_PCT = 15.0  # keep this share of the usable range in reserve
ASSIGNMENT_CANDIDATES = 4  # nearest depots (straight line) whose drones are then compared by routed time
# SIMULATED district demand weights (an explicit assumption, not measured demand): central
# districts are weighted higher. Multiplies the real restaurant/hospital counts in planning.
SIMULATED_DISTRICT_DEMAND = {
    "Śródmieście": 1.6, "Wola": 1.3, "Mokotów": 1.3, "Ochota": 1.2, "Praga-Północ": 1.2, "Żoliborz": 1.1,
    "Praga-Południe": 1.1, "Bielany": 1.0, "Targówek": 1.0, "Ursynów": 1.0, "Bemowo": 1.0, "Włochy": 0.9,
    "Wilanów": 0.9, "Białołęka": 0.9, "Ursus": 0.8, "Wawer": 0.8, "Rembertów": 0.7, "Wesoła": 0.7,
}
# Development-only protection for administrative fleet mutations (header X-Admin-Token).
# In production (SKYROUTE_ENV=production) admin mutations are refused unless a token is configured.
SKYROUTE_ENV = os.environ.get("SKYROUTE_ENV", "development")
ADMIN_TOKEN = os.environ.get("SKYROUTE_ADMIN_TOKEN") or ("dev-admin-token" if SKYROUTE_ENV != "production" else None)
