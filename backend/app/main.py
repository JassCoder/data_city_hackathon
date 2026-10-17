from contextlib import asynccontextmanager

import httpx
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware

from app.config import (
    API_PREFIX,
    APP_VERSION,
    CORS_ORIGINS,
    DEMO_BBOX,
    GEOCODING_CACHE_MAX,
    GEOCODING_CACHE_TTL_S,
    GEOCODING_MAX_WAIT_S,
    GEOCODING_MIN_INTERVAL_S,
    GEOCODING_RESULT_LIMIT,
    GEOCODING_VIEWBOX,
    NOMINATIM_URL,
    USER_AGENT,
)
from app.airspace.factory import make_provider
from app.airspace.repository import AirspaceRepository
from app.routers import data, geocoding, health, planning, zones
from app.routing.grid import build_grid
from app.routing.planner import RoutePlanner
from app.services.data_loader import load_demo_data
from app.services.drone_profiles import load_drone_profiles
from app.services.geocoding import GeocodingService, NominatimProvider, RateLimiter, TTLCache
from app.services.weather import WeatherService


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Fails startup with a clear DataLoadError if a /data file is missing or invalid.
    app.state.data = load_demo_data()
    app.state.profiles = load_drone_profiles()
    grid = build_grid(app.state.data, DEMO_BBOX)
    # Fails startup with a clear AirspaceLoadError if the zone source is missing or invalid.
    app.state.planner = RoutePlanner(grid, AirspaceRepository(make_provider(), grid))
    async with httpx.AsyncClient() as client:
        app.state.weather = WeatherService(client)
        app.state.geocoder = GeocodingService(
            NominatimProvider(client, NOMINATIM_URL, USER_AGENT, GEOCODING_VIEWBOX),
            TTLCache(GEOCODING_CACHE_MAX, GEOCODING_CACHE_TTL_S),
            RateLimiter(GEOCODING_MIN_INTERVAL_S, GEOCODING_MAX_WAIT_S),
            limit=GEOCODING_RESULT_LIMIT,
        )
        yield


app = FastAPI(
    title="SkyRoute Warsaw API",
    version=APP_VERSION,
    description="Drone route planning prototype. Simulation only, DEMO DATA.",
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
app.include_router(data.router, prefix=API_PREFIX)
app.include_router(geocoding.router, prefix=API_PREFIX)
app.include_router(planning.router, prefix=API_PREFIX)
app.include_router(zones.router, prefix=API_PREFIX)
