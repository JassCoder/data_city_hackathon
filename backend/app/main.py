import logging
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
    RISK_RASTER_FILE,
    COST_MODEL_FILE,
    GEOCODING_CACHE_MAX,
    GEOCODING_CACHE_TTL_S,
    GEOCODING_MAX_WAIT_S,
    GEOCODING_MIN_INTERVAL_S,
    GEOCODING_RESULT_LIMIT,
    GEOCODING_VIEWBOX,
    NOMINATIM_URL,
    SIM_SCENARIOS_DIR,
    USER_AGENT,
)
from app.airspace.factory import make_provider
from app.airspace.repository import AirspaceRepository
from app.geo.coverage import load_city_coverage
from app.routers import data, geocoding, health, map, planning, simulations, zones
from app.routing.grid import load_city_grid
from app.routing.planner import RoutePlanner
from app.routing.risk.config import CostModelConfig, load_cost_model, validate_altitudes
from app.routing.risk.osm import RiskRasterError, grid_only_providers, load_osm_providers
from app.routing.risk.providers import GridSpec
from app.routing.risk.surface import CostModel
from app.schemas.planning import ALTITUDE_MAX_M, ALTITUDE_MIN_M, ALTITUDE_STEP_M
from app.services.data_loader import load_demo_data
from app.services.drone_profiles import load_drone_profiles
from app.services.geocoding import GeocodingService, NominatimProvider, RateLimiter, TTLCache
from app.services.weather import WeatherService
from app.sim.session import SimSessionStore
from app.sim.world import sim_world_beside

logger = logging.getLogger(__name__)


def build_planner(cost_model: CostModelConfig) -> RoutePlanner:
    """The citywide planner on the real /data files (also used by scripts/)."""
    # Official Warsaw boundary; if missing, coverage reports it and routing is refused.
    coverage = load_city_coverage()
    # Precomputed citywide raster (fails startup with GridLoadError if missing).
    grid = load_city_grid(CITY_GRID_FILE, coverage.geom)
    # OSM risk raster. If missing or not on the grid's cells the app still starts:
    # SAFEST then answers RISK_DATA_UNAVAILABLE, the other objectives are unaffected.
    spec = GridSpec(grid.rows, grid.cols, grid.cell, grid.min_x, grid.min_y)
    try:
        risk_providers, _ = load_osm_providers(RISK_RASTER_FILE, grid, cost_model.density_proxy)
        risk = CostModel(cost_model, spec, risk_providers)
    except RiskRasterError as exc:
        logger.warning("SAFEST routing disabled: %s", exc)
        risk = CostModel(cost_model, spec, grid_only_providers(grid), unavailable_reason=str(exc))
    # Fails startup with a clear AirspaceLoadError if the zone source is missing or invalid.
    return RoutePlanner(grid, AirspaceRepository(make_provider(), grid), coverage, risk)


def load_validated_cost_model() -> CostModelConfig:
    """Fails with a clear CostModelError if the file is invalid or cruise > legal ceiling."""
    cost_model = load_cost_model(COST_MODEL_FILE)
    validate_altitudes(cost_model, ALTITUDE_MIN_M, ALTITUDE_MAX_M, ALTITUDE_STEP_M)
    return cost_model


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Fails startup with a clear DataLoadError if a /data file is missing or invalid.
    app.state.data = load_demo_data()
    app.state.profiles = load_drone_profiles()
    app.state.cost_model = load_validated_cost_model()
    app.state.planner = build_planner(app.state.cost_model)
    # Simulation sessions get their own planner (built on first use) so their zones stay out of routing.
    app.state.sim_store = SimSessionStore(lambda: sim_world_beside(app.state.planner), SIM_SCENARIOS_DIR)
    coverage = app.state.planner.coverage
    viewbox = GEOCODING_VIEWBOX
    if coverage.bounds:
        w, s, e, n = coverage.bounds
        viewbox = f"{w - 0.01:.4f},{n + 0.01:.4f},{e + 0.01:.4f},{s - 0.01:.4f}"
    async with httpx.AsyncClient() as client:
        app.state.weather = WeatherService(client)
        app.state.geocoder = GeocodingService(
            NominatimProvider(client, NOMINATIM_URL, USER_AGENT, viewbox, contains=coverage.contains),
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
app.include_router(map.router, prefix=API_PREFIX)
app.include_router(simulations.router, prefix=API_PREFIX)
