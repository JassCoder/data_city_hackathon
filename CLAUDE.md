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
- **Data:** local GeoJSON files in `data/`. No database and no auth; the app is a modular monolith.
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
backend/.venv/Scripts/python scripts/fetch_osm.py         # OSM buildings + corridors via Overpass (needs network)
backend/.venv/Scripts/python scripts/build_demo_data.py   # synthetic zones + stations (edit the tables in this file)
```

Backend tests use `tests/conftest.py`:
- `client` is a session TestClient over the real `/data`.
- `overrides` is `app.dependency_overrides`. Inject fakes for `get_geocoder`, `get_weather` and `get_planner` from `app/dependencies.py`.
- `make_planner(zones=[zone(...)], buildings=..., river=..., margin_m=...)` builds a small synthetic world for routing tests.
- `zone(id, polygon | circle=(lon, lat, r), category=..., lower=..., upper=..., ref=..., start=..., end=..., source=...)` builds a normalized `AirspaceZone`.
- `StaticProvider.set_zones()` (reached through `planner.airspace.provider`) simulates a dataset update.
- External HTTP is always mocked with `httpx.MockTransport`, so no test touches the network.

Uvicorn `--reload` on this OneDrive-synced folder can stop watching after the first reload. If new endpoints return 404, restart the server.

Frontend test gotchas:
- `httpResource` keeps `fixture.whenStable()` pending until its request is flushed. Use `HttpTestingController` to flush it, or call `detectChanges()` instead.
- jsdom has no canvas. Specs that render zones call `stubCanvas()` (`src/testing/canvas-stub.ts`) and assert on the Leaflet layer objects (`options`, `getPopup()`). Buildings and corridors should still be flushed with empty `features`.
- `httpResource.value()` **throws** while the resource is in an error state. Always read resources through `safeValue()` (`core/api.ts`) or a computed built on it (`LayersService.data`, `PlannerApi.profileList`, `AirspaceService.response`).
- The route line uses an SVG renderer in its own `routePane`, so it is testable as `path.route-normal`, `path.route-emergency` or `path.route-stale`.
- Shared fixtures live in `src/testing/fixtures.ts`. `flushStartup(http)` answers the layers, profiles, health and weather requests.
- Material harnesses (`MatSelectHarness`, `MatSliderHarness`, `MatButtonToggleHarness`) wait for stability. If an action triggers an `httpResource` request (for example the weather toggle), click the native element and flush the request instead of using the harness, or the test deadlocks.

Headless screenshots: Edge's `--virtual-time-budget` stops Leaflet's frame-based canvas redraws, so canvas layers look blank. To check the map visually, drive Edge with Playwright (`channel="msedge"`) and wait for `[data-testid="layer-summary"]`.

## Architecture

### Backend request flow
The FastAPI lifespan in `app/main.py` builds all the singletons once and stores them on `app.state`. Routers reach them through `app/dependencies.py`, which tests override.
- `data`: `load_demo_data()` returns `DemoData` (corridors, buildings, stations; **no zones**). Each `Layer` holds validated Pydantic `properties` plus **full-detail** Shapely `geometries`. The `/layers` body is a separate, simplified, pre-serialised copy and must never be used for routing.
- `planner`: `RoutePlanner(grid, AirspaceRepository(make_provider(), grid))`. The grid holds terrain and buildings only.
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
- `GET /layers` returns `{bbox, corridors, buildings, stations}`, gzipped.
- `GET /zones?altitudeM=&at=&mode=` and `GET /zones/{id}` return evaluated zones plus `source` (provider, sourceType, timestamp, datasetVersion, disclaimer).
- `GET /geocoding/search?query=` returns `{query, results[{displayName, latitude, longitude, placeId, category, source, inCoverage}], provider, attribution, cached}`. Queries shorter than 3 characters get a 422, provider failure a 503, and a full rate-limit queue a 429.
- `GET /drone-profiles`
- `GET /weather?mode=DEMO|LIVE`
- `POST /routes/calculate`

API models live in `app/schemas/planning.py` and use `CamelModel` (`schemas/common.py`): snake_case in Python, camelCase on the wire, `extra="forbid"`, and strict numeric coordinates. Planning outcomes are returned as **HTTP 200 with a `status`**: `OK`, `NO_ROUTE`, `OUTSIDE_COVERAGE`, `START_BLOCKED`, `DESTINATION_BLOCKED` or `BLOCKED_WEATHER`, plus a human-readable `message` and `geometry: null` when there is no route. Contract violations (bad coordinates, enum values, altitude, unknown profile, identical points) return **422**.

Request: `{start:{latitude,longitude}, destination:{...}, mode, flightAltitudeMeters, droneProfileId, weatherMode, departureTime?}`.
Response: `status`, `message`, `geometry` (GeoJSON LineString, **lon/lat order**), `distanceM`, `etaS`, the echoed settings, `weather`, `routeStart` and `routeDestination`, `zoneConflicts[]`, `airspace` (source + `datasetVersion`), `planningVerificationStatus` (always `SIMULATION_ONLY…`), `warnings[]`, `dataSources[]`, `computeMs`. Conflict relations are `START_INSIDE`, `DESTINATION_INSIDE`, `DIRECT_LINE_BLOCKED`, `ROUTE_CROSSES_INFO` and `NEAR_ROUTE`.

### Routing pipeline (`app/routing/`)
1. **Grid (`grid.py`):** the bbox (S 52.215, W 20.985, N 52.250, E 21.050) is defined only in `app/config.py` (`DEMO_BBOX`), which both scripts import and the APIs serve, so don't duplicate it. It is projected to **EPSG:2180** as a grid of 161×182 cells, each 25 m. Arrays are indexed `[row, col]` with row 0 at the south. The rasterisation rules differ by layer:
   - **Zones:** rasterised by the airspace repository, not the grid. A cell is blocked if it touches the zone plus its 20 m margin.
   - **Buildings:** a cell takes the max height of buildings covering its **centre**, which keeps streets open. A footprint too small to cover any centre still marks its representative point's cell.
   - **Corridors:** cell-centre test.
2. **Costs (`costs.py`, the only place for weights):**

   | Cell | NORMAL | EMERGENCY |
   |---|---|---|
   | River | 1 | 1 |
   | Park / green | 2 | 1 |
   | Open | 5 | 2 |
   | Airspace zone evaluated as an obstacle for this flight | blocked | blocked |
   | Building ≥ altitude − profile `verticalClearanceM` | blocked | blocked |
   | Outside the bbox | blocked | blocked |

   `RoutePlanner.base_cost` (terrain + buildings, which depend on altitude and profile) is rebuilt per request. The cells of zones that are obstacles for this flight are then blocked from the repository snapshot.
3. **Endpoints:** checked in this order: coverage, then the zone check, then weather.
   - Outside the bbox → `OUTSIDE_COVERAGE`.
   - Inside the exact polygon of a zone that is an obstacle at take-off/landing → `START_BLOCKED`/`DESTINATION_BLOCKED`, with a `*_INSIDE` conflict. The point is **never moved out of a zone**.
   - Only inside the safety margin → the route joins the nearest free cell and still starts or ends at the exact selected point.
   - Inside a tall building → snaps to the nearest free cell within 150 m, with a warning.
4. **A\* (`astar.py`):** 8-connected; step cost = length × the entered cell's cost; Euclidean heuristic × min cost (admissible). No corner-cutting diagonals.
5. **Smoothing:** greedy line-of-sight over a supercover line, which also includes both cells at a corner crossing. A shortcut is accepted only if all crossed cells are free **and** it costs ≤ 1.02× the sub-path it replaces, which preserves the river and park preferences.
6. **Safety net:** every candidate line is checked against the exact obstacle-zone polygons: the smoothed line with exact endpoints first, then cell centres, then unsmoothed. If none is clean, the result is `NO_ROUTE`. A line through an obstacle zone is never returned.
7. **ETA:** for each segment, ground speed = √(v² − crosswind²) + along-track wind, floored at 30 % of cruise speed. If wind exceeds the profile's `maxWindKmh`, the result is `BLOCKED_WEATHER`; gusts above it only add a warning. The range check is a warning. A route takes about 80 ms.

### Data files (`data/`)
Schemas are in `app/schemas/layers.py`.
- `buildings.geojson` (OSM): `{id, height_m, height_source}`, where `height_source` is `osm_height`, `levels_x3`, or `default_15m` (15 m, estimated). OSM heights include spires (Varso Tower is 310 m, the Palace of Culture 237 m).
- `corridors.geojson` (OSM): `corridor_type` is `RIVER` (a single merged `vistula` feature) or `PARK`. Green areas under 1,000 m² are dropped.
- `airspace/demo_zones.geojson` and `landing_stations.geojson` are **synthetic** and generated by `scripts/build_demo_data.py` (edit its `ZONES` table).
  - The 11 DEMO zones cover P (Sejm polygon; Castle circle with an AMSL ceiling), RM (Palace of Culture block only), three RH school circles (0–60 m AGL, so inactive at 80 m), T, U, I (Vistula, where the depot station sits), an expired RL zone, and an UNKNOWN zone.
  - The script and a pytest both enforce that no station lies inside a non-information zone.
  - Don't enlarge the PKiN zone over Warszawa Centralna or Marszałkowska, which are example addresses.
- `drone_profiles.json`: sample DEMO profiles (`DEMO_DRONE_01` Standard, `DEMO_DRONE_02` Delivery).

### Frontend structure
- **`core/models.ts`:** wire types, plus the shared `ALTITUDE` constants and validators.
- **`core/api.ts`:** `API_BASE_URL`, coverage helpers, and `describeHttpError`, which surfaces the backend `detail`.
- **`core/planner-api.ts`:** HTTP for geocoding and routing, plus the drone profiles `httpResource`.
- **`core/planner.store.ts` (`PlannerStore`):** the single Signals store for points, settings and route state.
  - `request` is a computed value that is null until every input is valid, which drives the Calculate button.
  - Every setter calls `invalidate()`: a `ready` route becomes `stale` (still drawn, grey and dashed), and an in-flight request is cancelled.
  - A `requestId` drops late responses.
  - `setLocation` rejects out-of-bbox points with a per-point notice.
  - `loadDemoScenario(id)` loads one of `DEMO_SCENARIOS` (blood delivery from `/layers` stations; avoid-prohibited-zone; no-route courtyard at 20 m) and calls the same `calculate()`. These are the only hard-coded coordinates, and they are example data only.
- **`planner/location-input`:** search on submit only (results go through a `switchMap`, so superseded searches are dropped). The user must choose a result explicitly; out-of-coverage results are disabled. It also offers "Pick on map" (`store.pickTarget`) and manual lat/lon entry. `store.resetCount` clears its local state.
- **`planner/planner-panel`:** the altitude slider and numeric input, the mode, profile and weather selectors, and the Calculate / Clear Route / Reset Planner / Load Demo Scenario buttons.
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

### Not built yet (original spec phases 4–6)
- Drone animation and the bottom bar.
- `/routes/compare`.
- Choosing a landing station or drop point as the route end, and the "Holding position" state.
- Wind sliders: the demo wind is fixed in `config.DEMO_WEATHER`.

### Demo scenarios
- **Blood delivery:** depot → hospital pad, Delivery Drone, 80 m. About 4.4 km; it crosses the DRA-I Vistula zone with a warning.
- **Avoid a prohibited zone:** (52.2255, 21.0205) → (52.2250, 21.0370). The straight line crosses DEMO-P-SEJM, and the route goes around it (about 1.37 km).
- **No route available:** a courtyard at (52.22344, 21.01109) → hospital at 20 m gives NO_ROUTE, because it is enclosed by buildings ≥ 10 m; at 80 m the same trip routes.
- Pytest pins all three (`test_routes_api.py`). Re-check them if you change zones, costs or buildings.

## Workflow

The work runs in phases: 1 skeleton, 2 data, 3 routing with tests, 4 modes/altitude/wind, 5 UX, 6 polish/README. Finish, run, and verify each phase before starting the next. After each phase, run the builds and tests, then update `PROJECT_PROGRESS.md`. Never claim tests passed without running them. Required pytest coverage: obstacle avoidance, corner cutting, no-route, and every obstacle category staying blocked in EMERGENCY mode.
