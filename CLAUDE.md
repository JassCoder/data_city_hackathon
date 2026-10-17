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

## Stack and hard constraints

- **Frontend** (`frontend/`): Angular (latest stable), standalone components, Signals, Angular Material, SCSS, Leaflet with OSM tiles.
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
backend/.venv/Scripts/python scripts/build_demo_data.py   # synthetic zones + stations (edit the tables in this file)
```

Backend tests use `tests/conftest.py`:
- `client` is a session TestClient over the real `/data`.
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
- `data`: `load_demo_data()` returns `DemoData`: citywide display corridors, tall buildings (≥ 50 m), stations, and `building_stats`. It has **no zones and no full building set**. The `/layers` body is pre-serialised and is for display only.
- `coverage`: `app/geo/coverage.py` `load_city_coverage()` gives the official polygon plus districts. If missing, `available=False`: `/map/warsaw-boundary` returns 503 and routes return `COVERAGE_UNAVAILABLE`. There is never a silent fallback.
- `route service`: `app/services/route_service.py` `RouteService`, built per request by `dependencies.get_route_service` from planner, profiles and weather. It is the **only** route pipeline: resolve the scenario (`app/routing/scenarios.py`) → profile → wind → the shared `RoutePlanner` → `RouteResponse`. Never add per-scenario routing functions or stored routes.
- `planner`: `RoutePlanner(load_city_grid(CITY_GRID_FILE, coverage.geom), AirspaceRepository(make_provider(), grid), coverage)`. The grid is the precomputed citywide raster (terrain + buildings).
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

Endpoints (all under `/api/v1`):
- `GET /health`
- `GET /layers` returns `{corridors, tallBuildings, stations, buildingStats}`, gzipped.
- `GET /map/warsaw-boundary` returns `{city, districts, bounds, source}`. `GET /map/coverage` returns status, geometry, routing limits and the airspace extent. `GET /map/buildings/14/{x}/{y}` serves gzipped footprint tiles (an empty FeatureCollection outside the city).
- `GET /zones?altitudeM=&at=&mode=` and `GET /zones/{id}` return evaluated zones plus `source` (provider, sourceType, timestamp, datasetVersion, disclaimer).
- `GET /geocoding/search?query=` returns `{query, results[{displayName, latitude, longitude, placeId, category, source, inCoverage}], provider, attribution, cached}`. Queries shorter than 3 characters get a 422, provider failure a 503, and a full rate-limit queue a 429.
- `GET /drone-profiles`
- `GET /weather?mode=DEMO|LIVE&altitude_m=`
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
  - `height_source` is `osm_height`, `levels_x3` or `default_15m` (estimated). OSM heights include spires (Varso Tower is 310 m).
- `tall_buildings.geojson`: buildings ≥ 50 m, the overview layer.
- `corridors.geojson`: citywide display layer. `RIVER` is one merged feature; `PARK` covers green ≥ 5,000 m² (the raster uses ≥ 1,000 m²).
- `airspace/demo_zones.geojson` and `landing_stations.geojson` are **synthetic** and generated by `scripts/build_demo_data.py` (edit its `ZONES` table).
  - The DEMO metadata `extent` is `DEMO_BBOX` (central Warsaw only).
  - The 11 DEMO zones cover P (Sejm polygon; Castle circle with an AMSL ceiling), RM (Palace of Culture block only), three RH school circles (0–60 m AGL, so inactive at 80 m), T, U, I (Vistula, where the depot station sits), an expired RL zone, and an UNKNOWN zone.
  - The script and a pytest both enforce that no station lies inside a non-information zone.
  - Don't enlarge the PKiN zone over Warszawa Centralna or Marszałkowska, which are example addresses.
- `drone_profiles.json`: sample DEMO profiles (`DEMO_DRONE_01` Standard, `DEMO_DRONE_02` Delivery).

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
  - `selectedScenario` (default `NORMAL`; null = custom): `selectScenario(id)` applies the config's mode/objective, keeps A/B/altitude/profile/weather, invalidates, then recalculates (or sets `scenarioNotice` = `MISSING_POINTS_MESSAGE`). Manual mode/objective changes → custom. **Scenario selection must never touch Point A/B.**
  - `loadDemoFixture(id)` (`DEMO_FIXTURES`) is the only code with predefined points, behind the explicit "Load demo fixture (replaces Point A and B)" toggle. It never changes scenario, mode, profile or weather.
- **`planner/location-input`:** search on submit only (results go through a `switchMap`, so superseded searches are dropped). The user must choose a result explicitly; out-of-coverage results are disabled. It also offers "Pick on map" (`store.pickTarget`) and manual lat/lon entry. `store.resetCount` clears its local state.
- **`planner/planner-panel`:** the altitude slider and numeric input, the mode, **route optimisation**, profile and weather selectors, and the Calculate / Clear Route / Reset Planner / Load Demo Scenario buttons.
- **`planner/route-results`:** the route details shown in the right panel.
- **`core/airspace.ts` (`AirspaceService`):**
  - Holds the `/zones` resource for the current valid altitude (the last value stays visible while reloading).
  - Provides display-only DRA category `filters`, `highlightZoneIds` (from `*_INSIDE` conflicts) and `focusZoneId`.
  - Calls `store.onAirspaceVersion()` on a dataset change (routes on another version become stale), and reloads itself if a route arrives with a newer version. The store never injects this service, to avoid a DI cycle.
- **`planner/airspace-panel`:** source badge, filters, zone list (click to focus) and error state.
- **`map/map.ts`:** owns all Leaflet code and uses `ViewEncapsulation.None`.
  - Corridors, zones and buildings share **one guarded canvas renderer**. `enforceOrder()` keeps corridors at the back, zones in the middle and buildings in front, because canvas hit-testing picks the topmost shape; call it after any change to these layers.
  - `zoneStyle()`: fill by `displayClass`, a solid red outline when `isObstacle`, dashed when inactive. Zone popups carry all metadata and a DEMO badge. While a pick target is armed, a click on a zone emits `mapClick` instead of opening the popup.
  - A/B markers are DOM `divIcon`s. The route is drawn on an SVG renderer in `routePane` (z 450): blue for NORMAL, **green** for EMERGENCY (red is reserved for zones), grey dashed when stale. Dotted links show snapped endpoints.
  - On a new `ready` route the map fits its bounds. Map clicks are emitted to `store.handleMapClick`, which fills the armed point, otherwise the first empty one.
  - **Citywide view:** the map starts on `FALLBACK_VIEW`, then fits the boundary once (`showEntireWarsaw()`, also the "Show Entire Warsaw" control). It draws the city and district outlines (SVG, non-interactive, permanent district labels). A missing boundary shows the `coverage-banner`.
  - **Building tiles:** z14 tiles are fetched on `moveend` from zoom ≥ `BUILDING_MIN_ZOOM` (15), cached in `tiles` and removed from `tileGroup` when zoomed out; tall buildings are always drawn. Zero-size containers skip fitting and tiles.
  - The dashed **airspace extent** comes from `airspaceSource.extent`. Map styles are global in `src/styles/map.scss` (listed in `angular.json`).

### Not built yet (original spec phases 4–6)
- Drone animation and the bottom bar.
- `/routes/compare`.
- Choosing a landing station or drop point as the route end, and the "Holding position" state.
- Wind sliders: the demo wind is fixed in `config.DEMO_WEATHER`.

### Demo fixtures and scenario tests
- Routing scenarios are tested in `backend/tests/test_scenarios.py` (all 5 scenarios: endpoints preserved, A/B changes, zone avoidance, NO_ROUTE, validation).
- The demo fixtures (explicit only), with the routes they currently produce:
- **Depot → hospital pad:** depot → hospital pad, Delivery Drone, 80 m. About 4.4 km; it crosses the DRA-I Vistula zone with a warning.
- **Across the Sejm zone:** (52.2255, 21.0205) → (52.2250, 21.0370). The straight line crosses DEMO-P-SEJM, and the route goes around it (about 1.37 km).
- **Enclosed courtyard:** a courtyard in Praga-Północ at (52.25549, 21.04532) → hospital at 20 m gives NO_ROUTE after a whole-city search, because it is enclosed by buildings ≥ 10 m; at 80 m the same trip routes. If `fetch_osm.py` is rerun, re-check it, because OSM edits can open the courtyard.
- Pytest pins all three (`test_routes_api.py`) plus 5 district pairs (`test_citywide.py`). Re-check them if you change zones, costs, buildings or search limits.

## Workflow

The work runs in phases: 1 skeleton, 2 data, 3 routing with tests, 4 modes/altitude/wind, 5 UX, 6 polish/README. Finish, run, and verify each phase before starting the next. After each phase, run the builds and tests, then update `PROJECT_PROGRESS.md`. Never claim tests passed without running them. Required pytest coverage: obstacle avoidance, corner cutting, no-route, and every obstacle category staying blocked in EMERGENCY mode.
