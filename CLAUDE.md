# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

**SkyRoute Warsaw**: a "Google Maps for drones" hackathon prototype. The user picks a start and destination on a Warsaw map. The backend computes a drone route that avoids restricted zones and tall buildings and prefers safe corridors (the Vistula, parks). The frontend draws the route and animates a drone along it.

It is a planning and simulation tool only and never controls real drones. No airspace zones are bundled or loaded by default. The bundled landing stations and drone profiles are **synthetic sample data** and must be labelled in the UI. Never present them as real legal restrictions, and never claim that avoiding loaded zones confirms real-world legality.

Official zones: PAŻP publishes no documented, permitted machine-readable zone source (researched 2026-10-17, see `DATA_SOURCES.md`). **Do not call DroneMap's undocumented backend (`api.dronemap.pansa.pl`) or scrape PAŻP services.** Official data enters only as a permitted file, through `SKYROUTE_AIRSPACE_PROVIDER=ed269|geojson` and `SKYROUTE_AIRSPACE_FILE`. Poland's real airspace systems (PAŻP, DroneTower/PansaUTM) are out of scope; this project only adds the route-planning layer.

The aim is a reliable end-to-end , not completeness. Working features beat placeholders. The full original spec lives in `SKYROUTE_PROMPT.md` if it is present. Phase status is tracked in `PROJECT_PROGRESS.md`; user-facing setup is in `README.md`.

**Later instructions override the spec** (see PROJECT_PROGRESS.md, Phase 3):
- The request contract uses `flightAltitudeMeters` (20–120, step 5, default 80), `droneProfileId` and `weatherMode` (SAMPLE|LIVE), replacing `altitudeM` and `wind`.
- EMERGENCY gets no special access: hard airspace restrictions are identical for both modes.
- Settings changes **invalidate** the route instead of auto-recalculating it. Choosing Point A/B with the other point set calculates at once (`PlannerStore.autoCalculate`, switched on by `App`; off in unit specs).

## Stack and hard constraints

- **Frontend** (`frontend/`): Angular (latest stable), standalone components, Signals, Angular Material, SCSS, Leaflet with OSM tiles.
- **Backend** (`backend/`): Python 3.12+, FastAPI, Pydantic, Uvicorn, Shapely, PyProj, NumPy, HTTPX, Pytest.
- **Data:** local files in `data/`, all committed. No database and no auth; the app is a modular monolith.
- **Coverage is the whole City of Warsaw:** the official GUGiK PRG polygon, TERYT `1465`, with 18 districts. Every coverage check is point-in-polygon on that geometry; never reintroduce a rectangle/bbox check. `_BBOX` now only describes where the  zones and stations exist (the airspace dataset `extent`).
- **Do not use** OSMnx or NetworkX at runtime, and avoid GeoPandas unless it is strictly needed. A* is hand-written on a NumPy grid.
- Every external API needs an offline fallback, and the  scenario must work with no network:
  - Open-Meteo: LIVE falls back to  wind, flagged `_FALLBACK`, with an explicit warning.
  - Nominatim: if it fails, map clicks and manual coordinates still work.
  - Overpass: only the one-off script uses it.
- **Public Nominatim policy:** server-side calls only, at most 1 request/s (global `RateLimiter`), cached, with a descriptive User-Agent and attribution shown in the UI. **Never add autocomplete or search-as-you-type against it**; searches run only on explicit submit.

## Commands

The repo root is this folder. The Python venv is `backend/.venv` (Windows layout, `Scripts/`). Angular CLI is not global, so use `npx ng`.

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
backend/.venv/Scripts/python scripts/build_sample_data.py # optional synthetic airspace sample; not loaded by default
backend/.venv/Scripts/python scripts/fetch_pois.py        # OSM hospitals + restaurants (~20 min, Overpass, one-off)
backend/.venv/Scripts/python scripts/fetch_airports.py    # OSM aerodromes (EPWA, EPBC; informative)
backend/.venv/Scripts/python scripts/fetch_planning_constraints.py  # OSM airport/military/government footprints (planning constraints)
backend/.venv/Scripts/python scripts/fetch_entrances.py   # OSM building entrances (addr:flats links; delivery planning)
backend/.venv/Scripts/python scripts/rebuild_buildings_from_tiles.py  # offline raster rebuild from cached tiles
```

Backend tests use `tests/conftest.py`:
- `client` is a session TestClient over the real `/data`; API routing tests inject synthetic zones only in the test lifespan.
- `overrides` is `app.dependency_overrides`. Inject fakes for `get_geocoder`, `get_weather` and `get_planner` from `app/dependencies.py`.
- `make_planner(zones=[zone(...)], buildings=..., river=..., margin_m=...)` builds a small synthetic world for routing tests.
- `zone(id, polygon | circle=(lon, lat, r), category=..., lower=..., upper=..., ref=..., start=..., end=..., source=...)` builds a normalized `AirspaceZone`.
- `StaticProvider.set_zones()` (reached through `planner.airspace.provider`) simulates a dataset update.
- External HTTP is always mocked with `httpx.MockTransport`, so no test touches the network.

Uvicorn `--reload` on this OneDrive-synced folder can stop watching after the first reload. If new endpoints return 404, restart the server. A running `ng serve` does not pick up `angular.json` changes (for example the global style list), so restart it; stopping its task can leave a Node process holding port 4200.

Shell gotcha: heredocs passed to the Bash tool break on some quote patterns. Write multi-line edit scripts to the scratchpad and run them instead.

Frontend test gotchas:
- `httpResource` keeps `fixture.whenStable()` pending until its request is flushed. Use `HttpTestingController` to flush it, or call `detectChanges()` instead.
- jsdom has no canvas. Specs that render zones call `stubCanvas()` (`src/testing/canvas-stub.ts`) and assert on the Leaflet layer objects (`options`, `getPopup()`). Buildings and corridors should still be flushed with empty `features`.
- `httpResource.value()` **throws** while the resource is in an error state. Always read resources through `safeValue()` (`core/api.ts`) or a computed built on it (`LayersService.data`, `PlannerApi.profileList`, `AirspaceService.response`).
- The route line uses an SVG renderer in its own `routePane`, so it is testable as `path.route-normal`, `path.route-emergency` or `path.route-stale`.
- Shared fixtures live in `src/testing/fixtures.ts` (`BOUNDARY` and `COVERAGE` are a simplified two-district box). `settle(http, fixture)` ticks and flushes startup requests (layers, profiles, health, weather, zones, boundary, coverage) until none remain; use it instead of a single `flushStartup`, because services issue their requests on the next tick.
- The weather readout refetches whenever the altitude changes. The planner-panel spec auto-answers `/weather` with an interceptor, so harness actions don't deadlock.
- `MapComponent` injects `HttpClient` optionally (for building tiles). jsdom maps have zero size: stub `getSize` when asserting `fitBounds` or tile loading.
- Material harnesses (`MatSelectHarness`, `MatSliderHarness`, `MatButtonToggleHarness`) wait for stability. If an action triggers an `httpResource` request (for example the weather toggle), click the native element and flush the request instead of using the harness, or the test deadlocks.

Headless screenshots: Edge's `--virtual-time-budget` stops Leaflet's frame-based canvas redraws, so canvas layers look blank. To check the map visually, drive Edge with Playwright (`channel="msedge"`) and wait for `[data-testid="layer-summary"]`.

## Architecture

### Backend request flow
The FastAPI lifespan in `app/main.py` builds all the singletons once and stores them on `app.state`. Routers reach them through `app/dependencies.py`, which tests override.
- `data`: `load__data()` returns `Data`: citywide display corridors, tall buildings (≥ 50 m), stations, and `building_stats`. It has **no zones and no full building set**. The `/layers` body is pre-serialised and is for display only.
- `coverage`: `app/geo/coverage.py` `load_city_coverage()` gives the official polygon plus districts. If missing, `available=False`: `/map/warsaw-boundary` returns 503 and routes return `COVERAGE_UNAVAILABLE`. There is never a silent fallback.
- `route service`: `app/services/route_service.py` `RouteService`, built per request by `dependencies.get_route_service` from planner, profiles and weather. It is the **only** route pipeline: resolve the scenario (`app/routing/scenarios.py`) → profile → wind → the shared `RoutePlanner` → `RouteResponse`. Never add per-scenario routing functions or stored routes.
- `planner`: `RoutePlanner(load_city_grid(CITY_GRID_FILE, coverage.geom), AirspaceRepository(make_provider(), grid), coverage)`. The grid is the precomputed citywide raster (terrain + buildings).
- `profiles`: `data/drone_profiles.json` (synthetic sample profiles), the only place profiles are defined.
- `weather`: `WeatherService` (SAMPLE, or LIVE Open-Meteo with an explicit SAMPLE_FALLBACK).
- `geocoder`: `GeocodingService` over `AddressGeocoder` (`services/address.py`).
  - GUGiK PRG address points (UUG, exact building numbers, results re-checked with `same_street`) plus Nominatim (1 req/s), merged into one ranked list with accuracy levels. Flats are kept, never geolocated.
  - `entrances`: `EntranceIndex` (`services/entrances.py`, `data/osm/entrances.json.gz`) gives the mapped entrances of the building at a point.
- **Time:** `services/clock.py` `warsaw_now()` is the backend calculation time (Europe/Warsaw; EU daylight-saving fallback when the tz database is missing). It is used for zones, weather and `calculatedAt`.

### Airspace (`app/airspace/`)
- **Planning constraints (`constraints.py`):** `data/planning_constraints.geojson` holds real OSM footprints of airports, military areas and government buildings (incl. the building containing an `office=government` point). `with_planning_constraints()` (in `main.py`, `SKYROUTE_PLANNING_CONSTRAINTS=on|off`, default on) adds them to the airspace dataset as category `PLANNING` / source `PLANNING_CONSTRAINT`: BLOCKED, RED, obstacles at every altitude and in every mode. They keep the base dataset's metadata, so they never count as official data. They are SkyRoute policy, never presented as official no-fly zones. Airspace files may not use `PLANNING`. The shared test `client` patches the wrapper out; `tests/test_planning_constraints.py` tests it on the real grid.
- **`models.py`:** the normalized `AirspaceZone` (camelCase on the wire, `None` = unknown). `geojsonGeometry` is always a Polygon or MultiPolygon; circular zones also keep `circle` (centre + radius) and use a 128-vertex **geodesic** polygon.
- **`providers.py`:**
  - `GeoJsonZoneFileProvider` (permitted local GeoJSON file, or converted snapshots).
  - `Ed269FileProvider` (an ED-269-style official export; its mapping is not validated against a real PAŻP file yet).
  - `factory.make_provider()` defaults to `EmptyProvider` (`SKYROUTE_AIRSPACE_PROVIDER=none`); a permitted file must be explicitly selected with `geojson` or `ed269`. Every dataset carries a content-hash `version`. Several files in `SKYROUTE_AIRSPACE_FILE` (os.pathsep) become a `CompositeProvider`.
  - `dedupe_zones` drops exact duplicates; the same id with different content raises `AirspaceLoadError`.
  - No airspace dataset is bundled or loaded by default. An empty provider means airspace is unknown, not unrestricted. Do not invent zones in other districts or around airports.
- **`evaluation.py`:** `evaluate(zone, FlightContext, endpoint=False)` checks, in order:
  - the validity period (unknown = active);
  - the vertical band (± `AIRSPACE_VERTICAL_MARGIN_M`; AMSL compared via `TERRAIN_ELEVATION_RANGE_M_AMSL`; unknown reference = applies; `endpoint=True` includes the climb from the ground);
  - category and restriction rules: P → BLOCKED/RED; R/RH/RM/RL → unavailable/RED (red like prohibited, since the route may not enter); U → unavailable/ORANGE; T → unavailable/YELLOW; I → INFORMATION/YELLOW (not an obstacle); unknown or no source → UNVERIFIED/GRAY (obstacle).
  - The result is a `ZoneEvaluation{status, displayClass, isObstacle, reasons}`. RH/RM/RL are consent *likelihoods*, never permissions. `FlightContext.authorizations` is the hook for modelled authorizations (none today).
- **`repository.py`:** `AirspaceRepository.refresh()` reloads when the provider's data changed (a broken update keeps the last good version). It returns an immutable `AirspaceState`: zones, metric geometry, an STRtree, and per-zone flat grid cell indices including the `AIRSPACE_SAFETY_MARGIN_M` (20 m) buffer. Request handlers call `refresh()`, so editing the data file takes effect without a restart.

Endpoints (all under `/api/v1`):
- `GET /health`
- `GET /layers` returns `{corridors, tallBuildings, stations, buildingStats}`, gzipped.
- `GET /map/warsaw-boundary` returns `{city, districts, bounds, source}`. `GET /map/coverage` returns status, geometry, routing limits and the airspace extent. `GET /map/buildings/14/{x}/{y}` serves gzipped footprint tiles (an empty FeatureCollection outside the city).
- `GET /zones?altitudeM=&at=&mode=&bbox=&format=` and `GET /zones/{id}` return evaluated zones plus `source` (provider, sourceType, timestamp, datasetVersion, disclaimer), `completeness` and `totalZones`.
  - The default is the whole dataset.
  - `bbox` filters by exact geometry intersection (STRtree).
  - `format=geojson` returns a FeatureCollection.
- `GET /zones/summary` (`app/airspace/summary.py`): dynamic counts by DRA category and by status group (BLOCKED, CONDITIONAL, INFORMATIONAL, UNKNOWN, NOT_APPLICABLE). `GET /airspace/status`: source, official coverage, the routing margin (a configurable modelling assumption) and the warning "Official airspace data unavailable. Routing is an unverified simulation." Declare `/summary` before `/{zone_id}`.
- `GET /zones/diagnostics` (`app/airspace/diagnostics.py`) gives per-district coverage, counts and warnings.
  - Never report a district as "verified".
  - A zone count of 0 is not an error; only an uncovered extent is `UNAVAILABLE`.
  - The frontend fetches it only while the debug panel is open.
  - Declare it before `/{zone_id}`.
- `GET /geocoding/search?query=` returns `{query, results[{displayName, latitude, longitude, placeId, category, source, inCoverage}], provider, attribution, cached}`. Queries shorter than 3 characters get a 422, provider failure a 503, and a full rate-limit queue a 429.
- `GET /drone-profiles`
- `GET /weather?mode=SAMPLE|LIVE&altitude_m=`
- `POST /routes/calculate`

API models live in `app/schemas/planning.py` and use `CamelModel` (`schemas/common.py`): snake_case in Python, camelCase on the wire, `extra="forbid"`, and strict numeric coordinates. Planning outcomes are returned as **HTTP 200 with a `status`**: `OK`, `NO_ROUTE`, `OUTSIDE_COVERAGE`, `START_BLOCKED`, `DESTINATION_BLOCKED`, `BLOCKED_WEATHER`, `SEARCH_LIMIT` (budget exhausted, nothing proven) or `COVERAGE_UNAVAILABLE`, plus a human-readable `message` and `geometry: null` when there is no route. Contract violations (bad coordinates, enum values, altitude, unknown profile, identical points) return **422**.

Request: `{start:{latitude,longitude}, destination:{...}, mode, flightAltitudeMeters, droneProfileId, weatherMode, routeObjective (CORRIDORS|SHORTEST|FASTEST, default CORRIDORS), scenario?, departureTime?}`.
- **Scenarios** (`NORMAL|BLOOD_DELIVERY|AED_DELIVERY|AVOID_PROHIBITED_ZONE|EMERGENCY`, served by `GET /scenarios`) are configuration only. `ScenarioConfig` carries goal, mode and a suggested profile, and **never coordinates**.
- A scenario sets mode/objective; an explicit contradicting `mode`/`routeObjective` → 422. Start and destination are always the request's own, and the response echoes them (`start`, `destination`).
- `respect_restricted_zones` is asserted True for every scenario, so no scenario may relax hard restrictions.
Response: `status`, `message`, `geometry` (GeoJSON LineString, **lon/lat order**), `distanceM`, `etaS`, the echoed settings, `weather` (with along-route `samples`), `routeStart` and `routeDestination`, `coverage` (valid, area, start and destination districts, `airspaceOutsideExtentM`), `search` (attempts, resolutionM, windowKm2, expansions, wholeCity, limitedBy, elapsedMs, cached), `zoneConflicts[]`, `airspace` (source + `datasetVersion`), `planningVerificationStatus` (always `SIMULATION_ONLY…`), `warnings[]`, `dataSources[]`, `computeMs`. Conflict relations are `START_INSIDE`, `DESTINATION_INSIDE`, `DIRECT_LINE_BLOCKED`, `ROUTE_CROSSES_INFO` and `NEAR_ROUTE`.

### Routing pipeline (`app/routing/`)
1. **Grid (`grid.py`):** a precomputed raster (`data/osm/grid_warsaw_25m.npz`, built by `fetch_osm.py`) of **1,198 × 1,151 cells at 25 m** (EPSG:2180), covering the city bounds.
   - **What it holds:** `building_height` (max over buildings covering each cell centre; small footprints mark their representative point's cell), `river` and `park`.
   - **Coverage mask:** computed at startup from the official polygon.
   - Arrays are indexed `[row, col]` with row 0 at the south.
   - **Zones:** rasterised by the airspace repository, not the grid (cells touching the zone plus its 20 m margin).
   - **Tests:** `build_grid(corridors, buildings, area)` rasterises small synthetic worlds.
2. **Costs (`costs.py`, the only place for weights)** depend on the `RouteObjective`:
   - **CORRIDORS:** river 1 / park 2 / open 5 for NORMAL; 1 / 1 / 2 for EMERGENCY.
   - **SHORTEST:** 1 everywhere.
   - **FASTEST:** 1 everywhere, plus a direction-dependent move cost.
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
  - `height_source` is `osm_height`, `levels_x3` (levels × 3 m) or `unknown` (`height_m: null`, never invented). OSM heights include spires (Varso Tower is 310 m).
  - Routing treats unknown heights with `SKYROUTE_UNKNOWN_BUILDING_POLICY` (`assume:15` default | `block`), applied when the grid loads from the `building_unknown` mask.
- `pois/hospitals.geojson` and `pois/restaurants.geojson` hold real OSM POIs (`scripts/fetch_pois.py`). `airports.geojson` holds OSM aerodromes (`scripts/fetch_airports.py`, informative only). `fleet/fleet.sqlite` holds the simulated fleet state (runtime, not data).
- `tall_buildings.geojson`: buildings ≥ 50 m, the overview layer.
- `corridors.geojson`: citywide display layer. `RIVER` is one merged feature; `PARK` covers green ≥ 5,000 m² (the raster uses ≥ 1,000 m²).
- `landing_stations.geojson` contains synthetic sample locations. No airspace file is bundled; `scripts/build_sample_data.py` can generate optional fictional zones for local testing, but runtime never loads them by default.
  - Don't enlarge the PKiN zone over Warszawa Centralna or Marszałkowska, which are example addresses.
- `drone_profiles.json`: sample  profiles (`_DRONE_01` Standard, `_DRONE_02` Delivery).

### Fleet simulation (`app/fleet/`, Phase 8)
- **Data split:**
  - Real POIs are read-only (`pois.py` ← `data/pois/*.geojson` from `scripts/fetch_pois.py`).
  - Simulated state lives in SQLite (`db.py`, stdlib `sqlite3`, `FLEET_DB_FILE` / `SKYROUTE_FLEET_DB`).
  - Never mix the two: stations and pads reference OSM ids.
- **Capacity invariants are schema CHECKs.**
  - Change state only inside `db.tx()`.
  - Reserve with a conditional `UPDATE … WHERE occupied + reserved < capacity` / `status = 'AVAILABLE'` and check `rowcount`.
  - `executescript` commits on its own, so never call it inside `tx()`.
- **Seed:** `seed.py` runs once (meta `seeded_at`); `sync_pois` runs every start. Delete the SQLite file to re-seed. Tests set `SKYROUTE_FLEET_DB` to a temporary file in conftest.
- **Assignment** (`service.assign`): uses the shared `RoutePlanner` for every leg (FASTEST). Never assign by straight line alone, and never bypass zone checks.
- **Dispatch eligibility:** only facilities with verification SIMULATION_ENABLED or VERIFIED_BY_OPERATOR and status OPEN take part.
- **Admin mutations** need `X-Admin-Token` (`require_admin` in `routers/fleet.py`).
- **Frontend:**
  - `core/fleet.ts` (`FleetService`, resources reload after mutations).
  - `map/fleet-layers.ts` owns the fleet overlays and popup actions. `map/cluster.ts` is a plugin-free clusterer; `leaflet.markercluster` does not attach to the ESM `L` namespace.
  - `planner/fleet-panel` is the dashboard.
  - In `MapComponent` effects, read the input before `this.fleet?.…`, otherwise the effect never tracks it.
  - Facility popups are the only code that sets Point A/B from a facility (`source: 'FACILITY'`).
  - The order form has its own addresses (`OrderDraft.pickup` / `delivery`, `planner/address-search.ts`), never the planner's A/B. Food orders need a pickup and a delivery address.
  - Blood, AED and medical-supplies orders ask only for the delivery address. The pickup is the nearest hospital (`GET /hospitals/nearest`, straight line, skipping points inside blocked zones; its enabled station if any). The backend does the same when `pickup` is omitted.
  - Restaurant "order from" and station "deliver to" popups fill the form.
  - Each address field also has "Select on map" (`FleetService.pickTarget`). `App.onMapClick` gives the click to the armed fleet field before the planner, and rejects points outside Warsaw.
  - The Orders list and the map's delivery routes show only orders created in this browser session (`myOrderIds`, sessionStorage `skyroute.fleet.myOrders.v1`).
  - `FleetService.showLayersFor(type)` switches on that order type's layers (`ORDER_LAYERS`).
  - The district filter zooms the map (`MapComponent.zoomDistrict`); "All of Warsaw" shows the whole city.
  - "No eligible drone" is one summary sentence (`_no_drone_message`); details stay in `candidates`.
- **Test fixtures:** `src/testing/fleet-fixtures.ts`. `flushStartup` answers the fleet requests (`flushFleet`). Spec rule: flush first, then `whenStable()`.

### Frontend structure
- **`core/models.ts`:** wire types, plus the shared `ALTITUDE` constants and validators.
- **`core/api.ts`:** `API_BASE_URL`, `safeValue`, and `describeHttpError`, which surfaces the backend `detail`.
- **`core/map-data.ts` (`MapDataService`):** the boundary and coverage resources, `contains()` (point-in-polygon via `core/geo.ts`) and `districtOf()`. It must not inject the store.
- **`core/planner-api.ts`:** HTTP for geocoding and routing, plus the drone profiles `httpResource`.
- **`core/planner.store.ts` (`PlannerStore`):** the single Signals store for points, settings and route state.
  - `request` is a computed value that is null until every input is valid, which drives the Calculate button.
  - Every setter calls `invalidate()`: a `ready` route becomes `stale` (still drawn, grey and dashed), and an in-flight request is cancelled.
  - A `requestId` drops late responses.
  - `setLocation` rejects points outside the city polygon with a per-point notice (`OUTSIDE_WARSAW`).
  - The `routeObjective` signal (default CORRIDORS) is part of `request`, and changing it invalidates the route.
  - `departureTime` (ISO UTC, null = now) is sent as `departureTime`, and `AirspaceService` adds it as `&at=` to `/zones`. Changing it invalidates the route.
  - `selectedScenario` (default `NORMAL`; null = custom): `selectScenario(id)` applies the config's mode/objective, keeps A/B/altitude/profile/weather, invalidates, then recalculates (or sets `scenarioNotice` = `MISSING_POINTS_MESSAGE`). Manual mode/objective changes → custom. **Scenario selection must never touch Point A/B.**
  - `loadFixture(id)` (`_FIXTURES`) is the only code with predefined points, behind the explicit "Load sample fixture (replaces Point A and B)" toggle. It never changes scenario, mode, profile or weather.
- **`planner/location-input`:**
  - Search on submit only (results go through a `switchMap`, so superseded searches are dropped). If every in-coverage building-level match (ADDRESS or NEARBY_BUILDING) lies within 75 m of the top one, it is selected automatically and the full list stays behind "Show all matches"; otherwise the user chooses. Out-of-coverage results are disabled.
  - NEARBY_BUILDING: a letter-suffixed number missing from PRG (e.g. Al. Solidarności 171B) falls back to the registered base building (171), labelled as such with a backend note.
  - Shows each result's `accuracy` badge, the backend `note`, and the kept flat.
  - After an ADDRESS-level choice it calls `/geocoding/entrances` and `store.offerEntrances`. `store.chooseEntrance` moves the point there (`source: 'ENTRANCE'`).
  - It also offers "Select Point A/B on map" (`store.pickTarget`). There is no manual lat/lon entry (removed). `store.resetCount` clears its local state.
- **`planner/planner-panel`:**
  - Simplified: "Starting address" / "Destination address" (no "Point A/B" wording), altitude, Flight Mode, Route Optimisation (Smart Route = CORRIDORS, sent as BALANCED, first and default / Fastest / Shortest), a read-only Standard Drone, `WeatherStatusComponent` (LIVE default), and Calculate / Clear Route / Reset. No explanatory hints under the toggles. Toggle groups use the global `.pill-toggle` style (separate compact pills, `styles.scss`).
  - There is no scenario UI. The store still has `selectScenario`, but it isn't shown, and `selectedScenario` defaults to null.
  - The request sends `optimization` (`OPTIMIZATION_OF[routeObjective]`), never `routeObjective`, and never a departure time.
- **Floating map controls** (`map/map-overlays.scss`, positioned by `.overlay` in `app.scss`):
  - **Panels:** `MapLayersControlComponent` and `RouteDetailsPanelComponent` (top right) and `AirspaceLegendComponent` (bottom right, no zone list); one open at a time via `MapLayerStore.openPanel`. Route Details opens only when clicked, never by itself.
  - No header SAMPLE DATA badge, no footer disclaimer and no map airspace banner (removed on request). Synthetic data stays labelled in layer names, popups and the legend.
  - Layer defaults: airspace zones, delivery routes, boundary, 18 districts, river and parks on; everything else off (storage key `skyroute.layers.v2`).
  - **Hidden, not removed:** panels use `[hidden]`, so their content stays in the DOM for tests.
  - **Shared styles:** legend colours come from `ZONE_COLORS`/`INFO_BLUE` in `map.ts`.
- **`core/map-layers.ts` (`MapLayerStore`):**
  - `LAYER_DEFS` holds the exact labels and defaults; visibility is kept in `sessionStorage`. **Specs that depend on layer defaults must call `sessionStorage.clear()` first.**
  - `MapComponent.register(key, layer)` replaces Leaflet's layer control, and an effect applies visibility.
  - DRA category sub-filters stay in `AirspaceService.filters`. Hiding a layer never affects routing.
- **Flight simulation (`core/simulation.ts`, `planner/simulation-panel.ts`):** virtual round trip only; never controls a drone.
  - "Find Route" calculates; "Start Simulation" is enabled only for a `ready` route whose request equals the current `store.request()`.
  - Outbound = the displayed route geometry. The return leg is a separate `POST /routes/calculate` (same request, endpoints swapped), fetched at start. No valid return → stop at B with the reason; never reversed or invented.
  - `pointAt`/`trailOf` interpolate along the exact geometry. The pace is the leg's backend ETA. `SIM_TIME_SCALE` (1× = 20 simulated s per real s) times the playback speed (1/2/5/10×).
  - One loop through the injectable `SIM_SCHEDULER` (requestAnimationFrame; specs use a manual scheduler and `advance()`).
  - Any route change (settings invalidate the route) stops a running simulation.
  - `MapComponent` `simulation` input (`SimFrame`): SVG drone in `dronePane` (z 660, rotated `.drone-body`), green `sim-trail`, dashed purple `sim-return`, optional follow.
- **`planner/route-results`:** the Route Details content (overview, weather, drone, safety; no zone list).
- **`core/airspace.ts` (`AirspaceService`):**
  - Holds the `/zones` resource for the current valid altitude (the last value stays visible while reloading).
  - Provides display-only DRA category `filters`, `highlightZoneIds` (from `*_INSIDE` conflicts) and `focusZoneId`.
  - Calls `store.onAirspaceVersion()` on a dataset change (routes on another version become stale), and reloads itself if a route arrives with a newer version. The store never injects this service, to avoid a DI cycle.
- **`planner/airspace-panel`:** source badge, filters, zone list (click to focus) and error state.
- **`map/map.ts`:** owns all Leaflet code and uses `ViewEncapsulation.None`.
  - Corridors, zones and buildings share **one guarded canvas renderer**. `enforceOrder()` keeps corridors at the back, zones in the middle and buildings in front, because canvas hit-testing picks the topmost shape; call it after any change to these layers.
  - `zoneStyle()`: fill by `displayClass`, a solid red outline when `isObstacle`, dashed when inactive. Zone popups carry all metadata and a  badge. While a pick target is armed, a click on a zone emits `mapClick` instead of opening the popup.
  - A/B markers are DOM `divIcon`s. The route is drawn on an SVG renderer in `routePane` (z 450): blue for NORMAL, **green** for EMERGENCY (red is reserved for zones), grey dashed when stale. Dotted links show snapped endpoints.
  - On a new `ready` route the map fits its bounds. Map clicks are emitted to `store.handleMapClick`, which fills the armed point, otherwise the first empty one.
  - **Citywide view:** the map starts on `FALLBACK_VIEW`, then fits the boundary once (`showEntireWarsaw()`, also the "Show Entire Warsaw" control). It draws the city and district outlines (SVG, non-interactive, permanent district labels). A missing boundary shows the `coverage-banner`.
  - **Building tiles:** z14 tiles are fetched on `moveend` from zoom ≥ `BUILDING_MIN_ZOOM` (15), cached in `tiles` and removed from `tileGroup` when zoomed out; tall buildings are always drawn. Zero-size containers skip fitting and tiles.
  - The dashed **airspace extent** comes from `airspaceSource.extent`. Map styles are global in `src/styles/map.scss` (listed in `angular.json`).

### Not built yet (original spec phases 4–6)
- The bottom bar.
- `/routes/compare`.
- Choosing a landing station or drop point as the route end, and the "Holding position" state.
- Wind sliders: the SAMPLE wind is fixed in `config._WEATHER`.

### Airspace fixtures and scenario tests
- Citywide airspace is tested in `backend/tests/test_citywide_airspace.py` with the **synthetic** zones in `tests/citywide_zones.py` (TEST-* ids, airport fixtures pytest-only). For a manual citywide run, write that fixture with `python -m tests.citywide_zones out.geojson` (from `backend/`) and start the backend with `SKYROUTE_AIRSPACE_PROVIDER=geojson SKYROUTE_AIRSPACE_FILE=out.geojson`.
- Routing scenarios are tested in `backend/tests/test_scenarios.py` (all 5 scenarios: endpoints preserved, A/B changes, zone avoidance, NO_ROUTE, validation).
- Explicit route fixtures and their expected outcomes:
- **Depot → hospital pad:** depot → hospital pad, Delivery Drone, 80 m. About 4.4 km; it crosses the DRA-I Vistula zone with a warning.
- **Enclosed courtyard:** a courtyard in Praga-Północ at (52.25549, 21.04532) → hospital at 20 m gives NO_ROUTE after a whole-city search, because it is enclosed by buildings ≥ 10 m; at 80 m the same trip routes. If `fetch_osm.py` is rerun, re-check it, because OSM edits can open the courtyard.
- Pytest pins all three (`test_routes_api.py`) plus 5 district pairs (`test_citywide.py`). Re-check them if you change zones, costs, buildings or search limits.

## Workflow

The work runs in phases: 1 skeleton, 2 data, 3 routing with tests, 4 modes/altitude/wind, 5 UX, 6 polish/README. Finish, run, and verify each phase before starting the next. After each phase, run the builds and tests, then update `PROJECT_PROGRESS.md`. Never claim tests passed without running them. Required pytest coverage: obstacle avoidance, corner cutting, no-route, and every obstacle category staying blocked in EMERGENCY mode.
