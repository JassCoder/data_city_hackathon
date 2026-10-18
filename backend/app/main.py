from contextlib import asynccontextmanager

import httpx
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware

from app.config import (
    API_PREFIX,
    APP_VERSION,
    CORS_ORIGINS,
    CITY_GRID_FILE,
    GEOCODING_CACHE_MAX,
    GEOCODING_CACHE_TTL_S,
    GEOCODING_MAX_WAIT_S,
    GEOCODING_MIN_INTERVAL_S,
    GEOCODING_RESULT_LIMIT,
    GEOCODING_VIEWBOX,
    NOMINATIM_URL,
    GUGIK_UUG_URL,
    GUGIK_MIN_INTERVAL_S,
    USER_AGENT,
)
from app.airspace.constraints import with_planning_constraints
from app.airspace.factory import make_provider
from app.airspace.repository import AirspaceRepository
from app.geo.coverage import load_city_coverage
from app.geo.airports import load_airports
from app.config import FLEET_DB_FILE
from app.fleet.db import FleetDB
from app.fleet.pois import load_pois
from app.fleet.seed import seed as seed_fleet
from app.fleet.service import FleetService
from app.routers import data, fleet, geocoding, geodata, health, map, planning, zones, city_weather
from app.routing.constraints import build_constraints
from app.routing.grid import load_city_grid
from app.routing.planner import RoutePlanner
from app.services.data_loader import load__data
from app.services.drone_profiles import load_drone_profiles
from app.services.address import AddressGeocoder, GugikAddressProvider
from app.services.entrances import load_entrances
from app.services.geocoding import GeocodingService, NominatimProvider, RateLimiter, TTLCache
from app.services.weather import WeatherService
from app.services.city_weather import CityWeatherService


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Fails startup with a clear DataLoadError if a /data file is missing or invalid.
    app.state.data = load__data()
    app.state.profiles = load_drone_profiles()
    # Official Warsaw boundary; if missing, coverage reports it and routing is refused.
    coverage = load_city_coverage()
    # Precomputed citywide raster (fails startup with GridLoadError if missing).
    grid = load_city_grid(CITY_GRID_FILE, coverage.geom)
    # Fails startup with a clear AirspaceLoadError if the zone source is missing or invalid.
    # OSM airports: informative layer; also the optional non-regulatory planning constraints.
    app.state.airports = load_airports()
    app.state.planner = RoutePlanner(grid, AirspaceRepository(with_planning_constraints(make_provider()), grid), coverage,
                                     build_constraints(app.state.airports, grid))
    # Simulated delivery infrastructure: real OSM hospitals/restaurants (read-only) + SQLite fleet state.
    fleet_db = FleetDB(FLEET_DB_FILE)
    pois = load_pois()
    app.state.fleet = FleetService(fleet_db, pois, app.state.planner, app.state.profiles)
    app.state.fleet_seed = seed_fleet(fleet_db, pois, app.state.planner, app.state.profiles)
    viewbox = GEOCODING_VIEWBOX
    if coverage.bounds:
        w, s, e, n = coverage.bounds
        viewbox = f"{w - 0.01:.4f},{n + 0.01:.4f},{e + 0.01:.4f},{s - 0.01:.4f}"
    async with httpx.AsyncClient() as client:
        app.state.weather = WeatherService(client)
        app.state.city_weather = CityWeatherService(client)  # Open Data Warsaw (token from the environment)
        # Building numbers: official GUGiK PRG address points; places/fallback: Nominatim (1 req/s).
        app.state.geocoder = GeocodingService(
            AddressGeocoder(
                GugikAddressProvider(client, GUGIK_UUG_URL, USER_AGENT, contains=coverage.contains,
                                     limiter=RateLimiter(GUGIK_MIN_INTERVAL_S, GEOCODING_MAX_WAIT_S)),
                NominatimProvider(client, NOMINATIM_URL, USER_AGENT, viewbox, contains=coverage.contains),
                RateLimiter(GEOCODING_MIN_INTERVAL_S, GEOCODING_MAX_WAIT_S),
                contains=coverage.contains,
            ),
            TTLCache(GEOCODING_CACHE_MAX, GEOCODING_CACHE_TTL_S),
            RateLimiter(0.0, GEOCODING_MAX_WAIT_S),  # per-provider limits live in AddressGeocoder
            limit=GEOCODING_RESULT_LIMIT,
        )
        app.state.entrances = load_entrances()
        yield
    fleet_db.close()


app = FastAPI(
    title="SkyRoute Warsaw API",
    version=APP_VERSION,
    description="Drone route planning prototype. Simulation only, .",
    lifespan=lifespan,
)

app.add_middleware(GZipMiddleware, minimum_size=1000)
app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ORIGINS,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(health.router, prefix=API_PREFIX)
app.include_router(geodata.router, prefix=API_PREFIX)
app.include_router(fleet.router, prefix=API_PREFIX)
app.include_router(data.router, prefix=API_PREFIX)
app.include_router(geocoding.router, prefix=API_PREFIX)
app.include_router(planning.router, prefix=API_PREFIX)
app.include_router(zones.router, prefix=API_PREFIX)
app.include_router(zones.status_router, prefix=API_PREFIX)
app.include_router(map.router, prefix=API_PREFIX)
app.include_router(city_weather.router, prefix=API_PREFIX)
