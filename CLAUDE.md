# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

**SkyRoute Warsaw**: a "Google Maps for drones" hackathon prototype. The user picks a start and destination on a Warsaw map. The backend computes a drone route that avoids restricted zones and tall buildings and prefers safe corridors (the Vistula, parks). The frontend draws the route and animates a drone along it.

It is a planning and simulation tool only and never controls real drones. The bundled airspace zones, landing stations and drone profiles are **synthetic** and must be labelled DEMO in the UI. Never present them as real legal restrictions, and never claim that avoiding the loaded zones confirms real-world legality.

Official zones: PAŻP publishes no documented, permitted machine-readable zone source (researched 2026-10-17, see `DATA_SOURCES.md`). **Do not call DroneMap's undocumented backend (`api.dronemap.pansa.pl`) or scrape PAŻP services.** Official data enters only as a permitted file, through `SKYROUTE_AIRSPACE_PROVIDER=ed269|geojson` and `SKYROUTE_AIRSPACE_FILE`. Poland's real airspace systems (PAŻP, DroneTower/PansaUTM) are out of scope; this project only adds the route-planning layer.

The aim is a reliable end-to-end demo, not completeness. Working features beat placeholders. The full original spec lives in `SKYROUTE_PROMPT.md` if it is present. Phase status is tracked in `PROJECT_PROGRESS.md`; user-facing setup is in `README.md`.

**Later instructions override the spec** (see PROJECT_PROGRESS.md, Phase 3):
- The request contract uses `flightAltitudeMeters` (20–120, step 5, default 80), `droneProfileId` and `weatherMode` (DEMO|LIVE), replacing `altitudeM` and `wind`.
- EMERGENCY gets no special access: hard airspace restrictions are identical for both modes.
- Settings changes **invalidate** the route instead of auto-recalculating it.
- `flightAltitudeMeters` stays per request; when omitted it defaults to `altitude.defaultCruiseM` in `data/cost_model.json`. Startup fails if that default exceeds `legalCeilingM` (120 m) or the API range exceeds the ceiling.
- `routeObjective` also accepts `SAFEST` (multi-criteria risk cost, `app/routing/risk/`) and `LOWEST_ENERGY` (same engine, `objectivePresets.lowestEnergy` weights; works without the risk raster). Blood/AED scenarios also allow `mode: EMERGENCY` (`ScenarioConfig.extra_modes`, exposed as `allowedModes` in `/scenarios`); other scenario/mode contradictions stay 422. Its weights and parameters live only in `data/cost_model.json` (JSON, not YAML: no extra dependency). Optional `payloadKg` (≤ the profile's `maxPayloadKg`, else 422).

## Stack and hard constraints

- **Frontend** (`frontend/`): Angular (latest stable, zoneless), standalone components, Signals, SCSS with design tokens, Leaflet with OSM tiles. No component library (Angular Material removed 2026-10-18; ask before adding any dependency).
- **Backend** (`backend/`): Python 3.12+, FastAPI, Pydantic, Uvicorn, Shapely, PyProj, NumPy, HTTPX, Pytest.
- **Data:** local files in `data/`, all committed. No database and no auth; the app is a modular monolith.
- **Coverage is the whole City of Warsaw:** the official GUGiK PRG polygon, TERYT `1465`, with 18 districts. Every coverage check is point-in-polygon on that geometry; never reintroduce a rectangle/bbox check. `DEMO_BBOX` now only describes where the DEMO zones and stations exist (the airspace dataset `extent`).
- **Do not use** OSMnx or NetworkX at runtime, and avoid GeoPandas unless it is strictly needed. A* is hand-written on a NumPy grid.
- Every external API needs an offline fallback, and the demo scenario must work with no network:
  - Open-Meteo: LIVE falls back to DEMO wind, flagged `DEMO_FALLBACK`, with an explicit warning.
  - Nominatim: if it fails, map clicks and manual coordinates still work.
  - Overpass: only the one-off script uses it.
- **Public Nominatim policy:** server-side calls only, at most 1 request/s (global `RateLimiter`), cached, with a descriptive User-Agent and attribution shown in the UI. **Never add autocomplete or search-as-you-type against it**; searches run only on explicit submit.

## Commands

The repo root is this folder. The Python venv is `backend/.venv` (`Scripts/` on Windows, `bin/` on macOS/Linux; commands below use the Windows layout). Angular CLI is not global, so use `npx ng`.

```bash
# Backend (from backend/)
.venv/Scripts/pip install -r requirements.txt
.venv/Scripts/python -m uvicorn app.main:app --reload --port 8000   # API under /api/v1, docs at /docs
.venv/Scripts/python -m pytest                                      # all tests
.venv/Scripts/python -m pytest tests/test_health.py::test_health_ok # single test
.venv/Scripts/python -m pytest -k cors                              # by keyword

# Frontend (from frontend/), Angular 22 + Vitest
npm install
npx ng serve --port 4200      # calls http://localhost:8000/api/v1 (set in src/app/core/api.ts)
npx ng build
npx ng test --watch=false     # all tests
npx ng test --watch=false --include src/app/app.spec.ts   # single spec file

# Data (from repo root). Output in data/ is committed; the backend never fetches at runtime.
backend/.venv/Scripts/python scripts/fetch_boundaries.py  # official boundary + 18 districts (GUGiK PRG OGC API)
backend/.venv/Scripts/python scripts/fetch_osm.py         # citywide OSM: raster + building tiles + corridors (~40 min)
backend/.venv/Scripts/python scripts/build_demo_data.py   # synthetic zones + stations (edit the tables in this file)
backend/.venv/Scripts/python scripts/fetch_risk_layers.py # SAFEST risk raster: Overpass land use/POIs + floor area from tiles (~25 min)
backend/.venv/Scripts/python scripts/sweep_crowd_weight.py --out sweep.csv  # crowd-weight trade-off CSV (real planner)
```

Backend tests use `tests/conftest.py`:
- `client` is a session TestClient over the real `/data`.
- `overrides` is `app.dependency_overrides`. Inject fakes for `get_geocoder`, `get_weather` and `get_planner` from `app/dependencies.py`.
- `make_planner(zones=[zone(...)], buildings=..., river=..., margin_m=..., world=..., cost_model=...)` builds a small synthetic world for routing tests. `world` takes `synthetic_world()` kwargs (crowded blocks, residential, sensitive, open space as grid-cell slices); `cost_model` overrides `COST_MODEL` (e.g. other weights).
- `zone(id, polygon | circle=(lon, lat, r), category=..., lower=..., upper=..., ref=..., start=..., end=..., source=...)` builds a normalized `AirspaceZone`.
- `StaticProvider.set_zones()` (reached through `planner.airspace.provider`) simulates a dataset update.
- External HTTP is always mocked with `httpx.MockTransport`, so no test touches the network.

Uvicorn `--reload` on this OneDrive-synced folder can stop watching after the first reload. If new endpoints return 404, restart the server. A running `ng serve` does not pick up `angular.json` changes (for example the global style list), so restart it; stopping its task can leave a Node process holding port 4200.

Shell gotcha: heredocs passed to the Bash tool break on some quote patterns. Write multi-line edit scripts to the scratchpad and run them instead.

Frontend test gotchas:
- `httpResource` keeps `fixture.whenStable()` pending until its request is flushed. Instantiate every resource a component touches (e.g. `TestBed.inject(HealthService).resource.value()`) **before** `settle(http, appRef)`, or flush it with `HttpTestingController`.
- jsdom has no canvas. Specs that render the map call `stubCanvas()` (`src/testing/canvas-stub.ts`) and assert on Leaflet layer objects (`options`, `getPopup()`; zone popups are functions: call `getContent()(layer)`). jsdom maps have zero size: stub `getSize` when asserting `fitBounds` or tile loading.
- `httpResource.value()` **throws** in an error state. Read resources through `safeValue()` or a computed built on it.
- Shared fixtures: `src/testing/fixtures.ts` (`BOUNDARY`/`COVERAGE` are a simplified two-district box; `SCENARIOS` mirrors `/scenarios` incl. `allowedModes`; `COST_BREAKDOWN`). `settle()` ticks and flushes startup requests until none remain.
- Fleet tests build drones with `createDrone` + `toRouteRequest` + `routeResponse` (see `fleet.spec.ts`, `map.spec.ts`). `FleetStore` persists to `localStorage`: call `localStorage.clear()` in `beforeEach`.
- Zone and route paths are SVG: assert `path.route-ready` / `path.route-stale` strokes and zone `fillColor` (`url(#zp-…)`).

Browser checks (Playwright for Python in `backend/.venv`, dev tool only, not in requirements; drives the installed Google Chrome with `channel="chrome"`, no browser download). With backend (8000) and `ng serve` (4200) running:
- `backend/.venv/bin/python frontend/e2e/ui_check.py --out <dir>`: screenshots at 1280×720 and 390×844 and fails if any overlay (`.leaflet-control`, `[data-overlay]`) overlaps another, default and with panels open.
- `backend/.venv/bin/python frontend/e2e/flows.py --out <dir>`: the acceptance flows (3 coloured routes, A/B by suggestion/coordinates/pick/drag, zone popup, one failing drone isolated, mobile sheets).
- The app is zoneless: rendering happens a frame after a signal change, so use Playwright's auto-waiting `expect()` instead of reading values right after an action. Leaflet canvas layers need a short wait after load. `.claude/skills/webapp-testing/scripts/with_server.py` can start both servers.

## Architecture

### Backend request flow
The FastAPI lifespan in `app/main.py` builds all the singletons once and stores them on `app.state`. Routers reach them through `app/dependencies.py`, which tests override.
- `data`: `load_demo_data()` returns `DemoData`: citywide display corridors, tall buildings (≥ 50 m), stations, and `building_stats`. It has **no zones and no full building set**. The `/layers` body is pre-serialised and is for display only.
- `coverage`: `app/geo/coverage.py` `load_city_coverage()` gives the official polygon plus districts. If missing, `available=False`: `/map/warsaw-boundary` returns 503 and routes return `COVERAGE_UNAVAILABLE`. There is never a silent fallback.
- `route service`: `app/services/route_service.py` `RouteService`, built per request by `dependencies.get_route_service` from planner, profiles and weather. It is the **only** route pipeline: resolve the scenario (`app/routing/scenarios.py`) → profile → wind → the shared `RoutePlanner` → `RouteResponse`. Never add per-scenario routing functions or stored routes.
- `cost_model`: `load_validated_cost_model()` (`data/cost_model.json`, validated, altitude check).
- `planner`: `build_planner(cost_model)` = `RoutePlanner(grid, AirspaceRepository(make_provider(), grid), coverage, CostModel(...))`. The grid is the precomputed citywide raster (terrain + buildings); the `CostModel` reads the OSM risk raster. Scripts reuse `build_planner`.
- `profiles`: `data/drone_profiles.json` (DEMO), the only place profiles are defined.
- `weather`: `WeatherService` (DEMO, or LIVE Open-Meteo with an explicit fallback).
- `geocoder`: `GeocodingService` (a `GeocodingProvider` protocol, currently Nominatim, plus `TTLCache` and `RateLimiter`).

### Airspace (`app/airspace/`)
- **`models.py`:** the normalized `AirspaceZone` (camelCase on the wire, `None` = unknown). `geojsonGeometry` is always a Polygon or MultiPolygon; circular zones also keep `circle` (centre + radius) and use a 128-vertex **geodesic** polygon.
- **`providers.py`:**
  - `GeoJsonZoneFileProvider` (DEMO file, or converted snapshots).
  - `Ed269FileProvider` (an ED-269-style official export; its mapping is not validated against a real PAŻP file yet).
  - `factory.make_provider()` picks one from environment variables. Every dataset carries a content-hash `version`.
- **`evaluation.py`:** `evaluate(zone, FlightContext, endpoint=False)` checks, in order:
  - the validity period (unknown = active);
  - the vertical band (± `AIRSPACE_VERTICAL_MARGIN_M`; AMSL compared via `TERRAIN_ELEVATION_RANGE_M_AMSL`; unknown reference = applies; `endpoint=True` includes the climb from the ground);
  - category and restriction rules: P → BLOCKED/RED; R/RH/RM/RL/U → unavailable/ORANGE; T → unavailable/YELLOW; I → INFORMATION/YELLOW (not an obstacle); unknown or no source → UNVERIFIED/GRAY (obstacle).
  - The result is a `ZoneEvaluation{status, displayClass, isObstacle, reasons}`. RH/RM/RL are consent *likelihoods*, never permissions. `FlightContext.authorizations` is the hook for modelled authorizations (none today).
- **`repository.py`:** `AirspaceRepository.refresh()` reloads when the provider's data changed (a broken update keeps the last good version). It returns an immutable `AirspaceState`: zones, metric geometry, an STRtree, and per-zone flat grid cell indices including the `AIRSPACE_SAFETY_MARGIN_M` (20 m) buffer. Request handlers call `refresh()`, so editing the data file takes effect without a restart.

### Multi-criteria costs (`app/routing/risk/`, UI-free)
- **`config.py`:** pydantic models for `data/cost_model.json` (`extra="forbid"`, weights ≥ 0, no numeric defaults in code).
- **`providers.py`:** `GridSpec`, `CostContext` (departure time, altitude, payload: a new context = a new surface, the recompute hook), and the `PopulationDensityProvider`, `LandUseProvider`, `ObstacleProvider`, `WindProvider` protocols. Providers return **rasters on the routing grid**, not point lookups. `Array*` implementations; `synthetic.py` builds test worlds; `osm.py` loads `data/osm/risk_warsaw_25m.npz` (density proxy from floor area + stops, coefficients from `densityProxy`).
- **`terms.py`:** each cell term is 0..1: population `(density × hourly multiplier / reference)^exponent`, obstacle proximity, noise (residential × day/night factor), emergency landing (distance to open space / radius), sensitive sites. `distance_within` gives exact capped distances.
- **`energy.py`:** P = cruisePowerW + payloadPowerWPerKg × payload at cruise airspeed; energy/m = P / ground speed (wind triangle, `ground_speed` is shared with the planner's ETA/FASTEST). Energy and time terms are normalised by the worst case the hard limits allow, so they stay ≤ 1.
- **`surface.py`:** `CostModel` (static terms cached) → `CostSurface` per context: `cell_cost = 1 + Σ wᵢ·termᵢ`, a direction table `[wind sample][move]`, `min_cost_per_m = 1 + min(table)` (admissible heuristic factor), and `breakdown(points)` per term along the flown line.
- **`search.py`:** standalone `find_route` with a structured `RiskRoute` (`WIND_LIMIT`, `START_BLOCKED`, `GOAL_BLOCKED`, `NO_ROUTE`, `BATTERY_RESERVE`).
- **In the planner:** every request builds (or reuses) the surface. SAFEST searches `cell_cost` with `astar(..., additive=True)` (step = length × (cell + table)). Every OK route gets a breakdown; route energy above battery × (1 − reserve) → `INSUFFICIENT_BATTERY` for **all** objectives (user decision 2026-10-18; the Standard Drone cannot fly the 21–27 km cross-city pairs, so `test_citywide.py` uses the Delivery Drone).

Endpoints (all under `/api/v1`):
- `GET /health`
- `GET /layers` returns `{corridors, tallBuildings, stations, buildingStats}`, gzipped.
- `GET /map/warsaw-boundary` returns `{city, districts, bounds, source}`. `GET /map/coverage` returns status, geometry, routing limits and the airspace extent. `GET /map/buildings/14/{x}/{y}` serves gzipped footprint tiles (an empty FeatureCollection outside the city).
- `GET /zones?altitudeM=&at=&mode=` and `GET /zones/{id}` return evaluated zones plus `source` (provider, sourceType, timestamp, datasetVersion, disclaimer).
- `GET /geocoding/search?query=` returns `{query, results[{displayName, latitude, longitude, placeId, category, source, inCoverage}], provider, attribution, cached}`. Queries shorter than 3 characters get a 422, provider failure a 503, and a full rate-limit queue a 429.
- `GET /drone-profiles`
- `GET /weather?mode=DEMO|LIVE&altitude_m=`
- `POST /routes/calculate`

API models live in `app/schemas/planning.py` and use `CamelModel` (`schemas/common.py`): snake_case in Python, camelCase on the wire, `extra="forbid"`, and strict numeric coordinates. Planning outcomes are returned as **HTTP 200 with a `status`**: `OK`, `NO_ROUTE`, `OUTSIDE_COVERAGE`, `START_BLOCKED`, `DESTINATION_BLOCKED`, `BLOCKED_WEATHER`, `SEARCH_LIMIT` (budget exhausted, nothing proven), `COVERAGE_UNAVAILABLE`, `INSUFFICIENT_BATTERY` or `RISK_DATA_UNAVAILABLE` (SAFEST without the risk raster), plus a human-readable `message` and `geometry: null` when there is no route. Contract violations (bad coordinates, enum values, altitude, unknown profile, identical points) return **422**.

Request: `{start:{latitude,longitude}, destination:{...}, mode, flightAltitudeMeters?, droneProfileId, weatherMode, routeObjective (CORRIDORS|SHORTEST|FASTEST|SAFEST, default CORRIDORS), scenario?, departureTime?, payloadKg?}`.
- **Scenarios** (`NORMAL|BLOOD_DELIVERY|AED_DELIVERY|AVOID_PROHIBITED_ZONE|EMERGENCY`, served by `GET /scenarios`) are configuration only. `ScenarioConfig` carries goal, mode and a suggested profile, and **never coordinates**.
- A scenario sets mode/objective; an explicit contradicting `mode`/`routeObjective` → 422. Start and destination are always the request's own, and the response echoes them (`start`, `destination`).
- `respect_restricted_zones` is asserted True for every scenario, so no scenario may relax hard restrictions.
Response: `status`, `message`, `geometry` (GeoJSON LineString, **lon/lat order**), `distanceM`, `etaS`, the echoed settings, `weather` (with along-route `samples`), `routeStart` and `routeDestination`, `coverage` (valid, area, start and destination districts, `airspaceOutsideExtentM`), `search` (attempts, resolutionM, windowKm2, expansions, wholeCity, limitedBy, elapsedMs, cached), `zoneConflicts[]`, `costBreakdown` (totalCost, lengthM, terms[{term, weight, mean, cost}], energyWh, batteryUsableWh, payloadKg, flightTimeS, populationExposure, maxDensityPerHa, localHour, note; null when no route), `airspace` (source + `datasetVersion`), `planningVerificationStatus` (always `SIMULATION_ONLY…`), `warnings[]`, `dataSources[]`, `computeMs`. Conflict relations are `START_INSIDE`, `DESTINATION_INSIDE`, `DIRECT_LINE_BLOCKED`, `ROUTE_CROSSES_INFO` and `NEAR_ROUTE`.

### Routing pipeline (`app/routing/`)
1. **Grid (`grid.py`):** a precomputed raster (`data/osm/grid_warsaw_25m.npz`, built by `fetch_osm.py`) of **1,198 × 1,151 cells at 25 m** (EPSG:2180), covering the city bounds.
   - **What it holds:** `building_height` (max over buildings covering each cell centre; small footprints mark their representative point's cell), `river` and `park`.
   - **Coverage mask:** computed at startup from the official polygon.
   - Arrays are indexed `[row, col]` with row 0 at the south.
   - **Zones:** rasterised by the airspace repository, not the grid (cells touching the zone plus its 20 m margin).
   - **Tests:** `build_grid(corridors, buildings, area)` rasterises small synthetic worlds.
2. **Costs (`costs.py` for CORRIDORS/SHORTEST/FASTEST; `data/cost_model.json` for SAFEST)** depend on the `RouteObjective`:
   - **CORRIDORS:** river 1 / park 2 / open 5 for NORMAL; 1 / 1 / 2 for EMERGENCY.
   - **SHORTEST:** 1 everywhere.
   - **FASTEST:** 1 everywhere, plus a direction-dependent move cost.
   - **SAFEST:** `CostSurface.cell_cost` plus the additive energy/time direction table (see Multi-criteria costs).
   - **Always blocked:** obstacle zones (plus margin), buildings ≥ altitude − `verticalClearanceM`, and cells outside the city.
   - `base_cost` and the full cost array are cached per (mode, altitude, clearance, dataset version, obstacles, objective).
3. **Endpoints:** checked in this order: coverage (polygon), then the zone check, then weather (wind above the limit at **any** sample → `BLOCKED_WEATHER`).
   - Inside an obstacle zone → `START_BLOCKED`/`DESTINATION_BLOCKED` with a `*_INSIDE` conflict. The point is never moved out of a zone.
   - Inside only the margin → joined from the margin.
   - On a tall building → snapped within 150 m, with a warning.
4. **Corridor search (`planner._corridor_search`):**
   - The window is the A–B box plus a margin of max(`ROUTE_MIN_MARGIN_M`, `ROUTE_MARGIN_FACTOR` × distance).
   - With no path it widens ×`ROUTE_MARGIN_GROWTH`, up to the whole grid. `NO_ROUTE` is only claimed after the whole-city attempt, and the message says which resolution was searched.
   - Windows over `ROUTE_MAX_FINE_CELLS` are coarsened with `pool_blocked` (any blocked sub-cell blocks the coarse cell, so the result is always safe, possibly longer).
   - Budgets: `ROUTE_MAX_EXPANSIONS` per attempt and `ROUTE_TIME_LIMIT_S` total. Exhaustion gives `SEARCH_LIMIT`, never a guessed route.
   - Results are cached (`ROUTE_CACHE_SIZE`) by request, wind samples, objective, dataset version and departure minute.
   - Typical cost: under 250 ms even across the city.
5. **A\* (`astar.py`):** flat Python lists; 8-connected; octile heuristic × min cost; no corner-cutting diagonals; raises `SearchLimitExceeded`.
   - Optional `move_cost=(regions, table)`: for FASTEST, entering a cell with move k costs `length × table[region][k]`, where table = cruise ÷ ground speed per nearest wind sample. The heuristic uses the table minimum.
6. **Smoothing:** greedy line-of-sight on the (possibly coarse) window. A shortcut must be free and cost ≤ 1.02× the sub-path. An exact endpoint replaces its own cell's centre, otherwise it is joined.
7. **Safety net:** each candidate line must clear the exact obstacle polygons **and** the fine 25 m building/coverage raster; otherwise less-smoothed variants are tried, then `NO_ROUTE`.
8. **Airspace extent:** the route length outside `AirspaceState.extent_m` is reported as not checked (a warning, `coverage.airspaceOutsideExtentM`, and "PARTIAL AIRSPACE DATA" in the verification status).
9. **ETA:** per segment with crosswind correction and along-track wind from the nearest `WindSample` (`services/weather.WindField`). LIVE weather samples Open-Meteo along the A–B line (`sample_points`, ~5 km spacing, 10/80/120 m interpolated to altitude, cached).

### Data files (`data/`)
Schemas are in `app/schemas/layers.py`.
- `boundaries/warsaw_city.geojson` and `warsaw_districts.geojson`: official GUGiK PRG geometry (the city is powiat `1465`; districts are `1465NN_8` land-registry units).
- `osm/grid_warsaw_25m.npz`: the routing raster plus its `meta` (origin, cell, stats).
- `osm/tiles/14/x/y.json.gz` and `osm/buildings_index.json`: all 189k building footprints `{id, height_m, height_source}` for display.
  - `height_source` is `osm_height`, `levels_x3` or `default_15m` (estimated). OSM heights include spires (Varso Tower is 310 m).
- `tall_buildings.geojson`: buildings ≥ 50 m, the overview layer.
- `corridors.geojson`: citywide display layer. `RIVER` is one merged feature; `PARK` covers green ≥ 5,000 m² (the raster uses ≥ 1,000 m²).
- `airspace/demo_zones.geojson` and `landing_stations.geojson` are **synthetic** and generated by `scripts/build_demo_data.py` (edit its `ZONES` table).
  - The DEMO metadata `extent` is `DEMO_BBOX` (central Warsaw only).
  - The 11 DEMO zones cover P (Sejm polygon; Castle circle with an AMSL ceiling), RM (Palace of Culture block only), three RH school circles (0–60 m AGL, so inactive at 80 m), T, U, I (Vistula, where the depot station sits), an expired RL zone, and an UNKNOWN zone.
  - The script and a pytest both enforce that no station lies inside a non-information zone.
  - Don't enlarge the PKiN zone over Warszawa Centralna or Marszałkowska, which are example addresses.
- `drone_profiles.json`: sample DEMO profiles (`DEMO_DRONE_01` Standard, `DEMO_DRONE_02` Delivery), including DEMO energy fields (`cruisePowerW`, `payloadPowerWPerKg`, `batteryWh`).
- `cost_model.json`: SAFEST weights and parameters (DEMO values), default cruise altitude and legal ceiling, battery reserve.
- `osm/risk_warsaw_25m.npz`: built by `scripts/fetch_risk_layers.py` on exactly the routing grid's cells: residential/other floor area, residential, open space (no forests, ≥ 2,000 m²), sensitive sites, transit stops. Facts only; density and costs are computed at runtime from `cost_model.json`. A missing or misaligned file does **not** stop the app: it starts with `grid_only_providers` (logged warning, `/health` `riskDataAvailable: false`), SAFEST returns `RISK_DATA_UNAVAILABLE`, other objectives work and their breakdown note says the crowd/noise/sensitive terms are not loaded. The fetch caches tiles in `scripts/.cache/overpass` (gitignored), so a rerun after an Overpass outage resumes.

### Frontend structure
No component library (Angular Material was removed in the redesign): shared styles are design tokens in `src/styles/tokens.scss` and base components in `src/styles/base.scss` (button, input, segmented radio group, badge, native `[popover]`, tabs, toast, states). Icons are inline SVG (`ui/icon.ts`). Endpoints come from `src/environments/environment.ts`; UI thresholds from `core/settings.ts` (`SETTINGS`). No web fonts (system stack; B612 was rejected because it lacks Polish diacritics).
- **`core/models.ts`:** wire types, `ALTITUDE` (= `SETTINGS.altitude`) and validators. **`core/api.ts`:** `API_BASE_URL`, `safeValue`, `describeHttpError`. **`core/health.ts`:** `/health` (status, `riskDataMissing`).
- **`core/map-data.ts` (`MapDataService`):** boundary + coverage, `contains()` (point-in-polygon), `districtOf()`.
- **`core/planner-api.ts`:** geocoding (explicit search only), `POST /routes/calculate`, profiles and scenarios resources.
- **`core/routing-options.ts`:** the UI-to-API mapping. Optimisations Balanced/Fastest/Safest/Lowest energy → `CORRIDORS`/`FASTEST`/`SAFEST`/`LOWEST_ENERGY`. Missions per mode: Normal = General (free optimisation), Avoid prohibited zone; Emergency = General emergency (`EMERGENCY` scenario), Blood delivery, AED / first aid. A mission sends its `scenario` + mode and **no** `routeObjective` (the scenario sets it; the UI shows it locked). No weights in the frontend.
- **`core/fleet.ts` (pure, no Angular):** `Drone` records (colour from `DRONE_COLORS`, colour-blind safe, no red/amber/yellow), `updateDrone` (route-relevant changes: ready → stale, calculating/error → draft), `droneIssues` (plain-language validation), `toRouteRequest`, `droneStatus`, `findCrossings` (same-altitude-band segment intersections), `playbackPoints` (timestamped points for a future animation; time spread by distance because the backend returns only the total ETA).
- **`core/fleet.store.ts` (`FleetStore`):** the single store: `drones`, `selectedId`, `editingId`, `pickTarget {droneId, role}`, `weatherMode`, `lastDeleted` (undo). One request per drone with its own cancellation and `requestIds` (late responses dropped); `calculateAll` runs in parallel and failures stay per drone. `setLocation` validates against the city polygon (per-point `notices`). `handleMapClick` fills the armed point, else the first empty point of the open drone; `handleMarkerDrag` returns false to snap a rejected marker back. `loadDemoFleet()` (`DEMO_FLEET`) is the only code with predefined points, behind the explicit "Load demo fleet" button. The fleet (without routes) persists in `localStorage`.
- **`core/place-suggestions.ts`:** instant local suggestions (recent places, stations, district label points), `parseCoordinates`, diacritic-insensitive matching. **Never** query Nominatim while typing.
- **`core/airspace.ts` (`AirspaceService`):** `/zones` at the altitude of the drone being edited, else selected, else default (`altitude` linkedSignal keeps the last valid value); display-only category `filters`; `highlightZoneIds` = the selected drone's blocking zones when its result is not OK; calls `fleet.onAirspaceVersion()`. The fleet never injects this service (DI cycle).
- **`core/map-layers.ts`:** layer visibility + which overlay panel is open (exclusive on mobile). **`core/ui-state.ts`:** drawer open/tab, mobile sheet state, one-shot `focusRequest`.
- **`fleet/`:** `drone-list` (list, per-drone actions in a native popover menu, Calculate all, wind, demo fleet, live status announcements), `drone-editor` (inline form), `point-field` (ARIA combobox), `altitude-input`.
- **`details/`:** `route-details` (drawer Route tab: plain-language `STATUS_HEADLINE` + `STATUS_NEXT_STEP`, stats, zones deduplicated by strongest relation, cost breakdown, safety note) and `airspace-tab` (zones grouped by meaning).
- **`map/map.ts`:** all Leaflet code, `ViewEncapsulation.None`, global styles in `src/styles/map.scss`.
  - **Overlays never overlap by construction:** `LayersPanelComponent` and `MapLegendComponent` are projected (`mapTopRight` / `mapBottomRight`) and adopted as Leaflet corner controls (`hostControl`), so Leaflet stacks them; their max-heights use container-query units (`app-map` has `container-type: size`). Pick hints and the boundary warning are strips above the map, not overlays. `frontend/e2e/ui_check.py` asserts it.
  - **Airspace:** `map-style.ts` is the visual language: `zoneKind(evaluation)` → prohibited / conditional / unverified / info / inactive, each with colour + SVG fill pattern + border (ticks for no-entry) + glyph. Zones are SVG in `zonePane` (z 420, above the building canvas, so building tooltips under zones are not clickable). One shared `<defs>` (`installPatternDefs`) serves the renderer and the legend. Popups lead with "For <flight>: <meaning>" (`flightLabel`).
  - Corridors and buildings share one guarded canvas; `enforceOrder()` keeps corridors behind buildings.
  - **Drones:** coloured draggable A/B `divIcon` pins per visible drone, route lines on the SVG `routePane` (z 450): drone colour when ready (`path.route-ready`), grey dashed when outdated (`path.route-stale`), selected on top and wider; clicking a line emits `routeClick` (or `mapClick` while picking). Crossing markers per pair.
  - **Fitting:** a new ready route of the selected drone (or a `focusRequest`) fits without animation; the fit is re-applied when the map resizes (drawer opens) until the user interacts with the map (`keepFit`). An animated fit or `invalidateSize()` panning would undo it.
  - Citywide view, building tiles (z14 from zoom 15) and the zone-data extent work as before; layers are keyed by `LayerKey` and toggled from `layerVisibility`.

### Not built yet (original spec phases 4–6)
- Drone animation and the bottom bar.
- `/routes/compare`.
- Choosing a landing station or drop point as the route end, and the "Holding position" state.
- Wind sliders: the demo wind is fixed in `config.DEMO_WEATHER`.

### Demo fixtures and scenario tests
- Routing scenarios are tested in `backend/tests/test_scenarios.py` (all 5 scenarios: endpoints preserved, A/B changes, zone avoidance, NO_ROUTE, validation).
- The demo fixtures (explicit only; in the UI they are the three drones of `DEMO_FLEET` in `core/fleet.store.ts`, loaded by "Load demo fleet"), with the routes they currently produce:
- **Depot → hospital pad:** depot → hospital pad, Delivery Drone, 80 m. About 4.4 km; it crosses the DRA-I Vistula zone with a warning.
- **Across the Sejm zone:** (52.2255, 21.0205) → (52.2250, 21.0370). The straight line crosses DEMO-P-SEJM, and the route goes around it (about 1.37 km).
- **Enclosed courtyard:** a courtyard in Praga-Północ at (52.25549, 21.04532) → hospital at 20 m gives NO_ROUTE after a whole-city search, because it is enclosed by buildings ≥ 10 m; at 80 m the same trip routes. If `fetch_osm.py` is rerun, re-check it, because OSM edits can open the courtyard.
- Pytest pins all three (`test_routes_api.py`) plus 5 district pairs (`test_citywide.py`, Delivery Drone). Re-check them if you change zones, costs, buildings or search limits.

## Workflow

The work runs in phases: 1 skeleton, 2 data, 3 routing with tests, 4 modes/altitude/wind, 5 UX, 6 polish/README. Finish, run, and verify each phase before starting the next. After each phase, run the builds and tests, then update `PROJECT_PROGRESS.md`. Never claim tests passed without running them. Required pytest coverage: obstacle avoidance, corner cutting, no-route, and every obstacle category staying blocked in EMERGENCY mode.
