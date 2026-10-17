# Project progress

## Phase 1: Skeleton (done, 2026-10-17)

**Built**
- `backend/`: FastAPI app with CORS for `localhost:4200`, `GET /api/v1/health` (returns version, map centre, demo bbox), and pytest coverage for health and CORS.
- `frontend/`: Angular 22 (standalone, zoneless, Signals) with an Angular Material theme and a Leaflet/OSM map centred on Warsaw. It draws the demo bbox and shows a "DEMO DATA" badge. Backend status comes from `httpResource` on `/health`, with a retry button.
- Three-column layout (left/right panels are placeholders), plus the disclaimer footer.

**Verified**
- `pytest`: 2 passed.
- `ng build`: OK. `ng test` (Vitest): 2 passed.
- Ran both dev servers together. The CORS header and preflight are OK, and a headless browser screenshot shows the map rendering with "Backend online".

**Assumptions / decisions**
- The repo root is this folder (`Data City/`), not a nested `skyroute-warsaw/`.
- Phase 1 used a provisional bbox, replaced in Phase 2.
- Angular CLI is used via `npx ng` (not installed globally). The Python venv is at `backend/.venv`.
- The frontend API URL is hardcoded in `frontend/src/app/core/api.ts` (`http://localhost:8000/api/v1`).
- Added `routers/health.py`, which the spec does not list. All other routers follow the spec layout.

## Phase 2: Data layers (done, 2026-10-17)

**Built**
- **Bbox:** S 52.215, W 20.985, N 52.250, E 21.050 (about 4.4 × 3.9 km), defined once in `backend/app/config.py` and exposed in `/layers` (and `/health`). This replaces the Phase 1 bbox.
- **`scripts/fetch_osm.py`:** Overpass via HTTPX, with 3 mirror endpoints tried in order. It assembles ways and multipolygon relations into Shapely polygons and writes `buildings.geojson` (6,637 buildings: 614 `osm_height`, 5,264 `levels_x3`, 759 `default_15m`; 74 are ≥ 50 m) and `corridors.geojson` (1 merged Vistula RIVER feature from riverbank polygons, plus 720 PARK features). It writes nothing unless every query succeeds; this was verified by pointing it at a dead endpoint, and the files were unchanged.
- **`scripts/build_demo_data.py`:** the generator for the hand-written synthetic data. Zones and stations are defined in tables at the top of the file.
  - `zones.geojson`: NO_FLY around Sejm/Wiejska and the Royal Castle area; RESTRICTED for the dense centre (Centrum/Palace of Culture) and 3 school buffers of 100 m (Powiśle, Śródmieście Płd., Mirów). All are `source: "DEMO"`.
  - `landing_stations.geojson`: a hospital pad (west of the centre), a Powiśle rooftop pad, a Rydz-Śmigły park pad, and a Vistula boulevard depot. All are `source: "DEMO"`.
  - The script refuses to write if any station falls inside a zone.
- **Backend:**
  - `app/schemas/layers.py` holds the Pydantic GeoJSON models (enums for zone, corridor, height source, station type and status).
  - `app/services/data_loader.py` loads and validates all 4 files at startup (FastAPI lifespan), checks geometry type and validity, and raises `DataLoadError` naming the missing or invalid file and the script that creates it.
  - It keeps full-detail Shapely geometries for Phase 3 routing and pre-serialises the `/layers` body once. Buildings and corridors are simplified at 1 m and coordinates rounded to 6 decimals; zones and stations are not simplified.
  - `GET /api/v1/layers` returns `{bbox, zones, corridors, buildings, stations}`. A GZip middleware was added: 2.8 MB becomes 0.47 MB, served in about 0.7 s locally.
- **Frontend:**
  - `core/layers.ts`: typed `LayersService` (`httpResource`, fetched once) with summary counts.
  - The map renders the bbox (dashed), NO_FLY (red), RESTRICTED (orange), RIVER (blue), PARK (green), and buildings (grey, dark when ≥ 50 m, tooltip with height and source). Stations use Material-icon markers with popups (name, type, status, capacity, DEMO tag).
  - There is a Leaflet layer-toggle control, a legend with the DEMO disclaimer, a "Data layers" summary in the right panel, a loading bar, and retry on error.

**Verified**
- `pytest`: 10 passed. Covered: all files load, zone types are valid, no station is inside a zone, stations and zones are inside the bbox, building height rules, a clear error for a missing file, rejection of an invalid zone_type, and the `/layers` shape plus gzip.
- `ng build`: OK with no warnings. `ng test`: 2 passed (layers fetched exactly once, summary and station marker rendered).
- In the browser (Edge driven by Playwright), all 7 layers render. A building tooltip inside the restricted zone shows its height and source, the zone tooltip shows in the gaps, the station popup opens, the toggles work (including the re-enable ordering), and there were no page errors.

**Assumptions / decisions**
- Synthetic zones and stations come from `build_demo_data.py` rather than being typed into GeoJSON by hand, so circles are exact and placements are checked. The output GeoJSON is committed.
- Within the requested bbox, the Vistula only crosses the NE part; it exits east around lat 52.225, so the south of the area has no river corridor.
- Parks/green below 1,000 m² are dropped (traffic-island grass). `landuse=grass` is 624 of the 720 green features.
- Buildings intersecting the bbox are kept whole, not clipped. Corridors are clipped to the bbox.
- Station placement was checked against OSM. The hospital and park pads are on open ground. The rooftop pad sits on a 21 m building, below the 30 m minimum altitude, so it won't be a blocked cell in Phase 3. The depot is 8 m from the water on the west bank.
- The depot and hospital pad sit on opposite (east/west) sides of the dense centre to set up the Phase 3 "blood delivery" normal-vs-emergency contrast.
- Zones are drawn on the same Leaflet canvas as buildings, beneath them. This keeps building tooltips reachable inside zones; with SVG zones on top, the zones swallowed the hover.
- Building heights from OSM include spires (for example, Varso Tower is 310 m).

## Phase 3: Dynamic planner + routing (done, 2026-10-17)
This phase was requested as "Phase 2: Dynamic Address Search and Flight Configuration". It covers the spec's routing phase plus the profile, weather and mode parts of phase 4.

**Starting point:** no hard-coded route coordinates existed. Routing had not been built (`app/routing/` was empty), and the left panel was a placeholder. Everything below is new; Phase 1/2 features are unchanged.

**Built: backend**
- **Routing engine (`app/routing/`):**
  - EPSG:2180 grid of 161×182 cells (25 m), rasterised at startup in about 0.4 s.
  - A* on NumPy with 8 directions and no corner cutting.
  - Cost-aware line-of-sight smoothing.
  - Endpoint handling: coverage check, inside-a-zone rejection, and snapping out of tall buildings within 150 m.
  - A final zone-intersection safety net.
  - Wind-corrected ETA and blocking above the profile's wind limit.
  - A route takes about 80 ms.
- **Geocoding (`services/geocoding.py`):**
  - `GeocodingProvider` protocol with a `NominatimProvider` (Warsaw-bounded, `jsonv2`).
  - `TTLCache` (24 h, 512 entries) and a global `RateLimiter` (1 request/s; a queue longer than 5 s returns 429).
  - Descriptive User-Agent, and attribution returned to the UI.
  - Every result carries `inCoverage`.
- **Drone profiles:** `data/drone_profiles.json`, a DEMO dataset that is the single source of truth.
- **Weather (`services/weather.py`):** DEMO (fixed 14 km/h from 250°, gusts 22) and LIVE (Open-Meteo, 10-minute cache). On failure it uses explicit `DEMO_FALLBACK` with a "Live weather is not available" message.
- **API:**
  - Endpoints: `GET /geocoding/search`, `GET /drone-profiles`, `GET /weather`, `POST /routes/calculate`.
  - Strict camelCase Pydantic models (`CamelModel`, `extra="forbid"`, strict numbers).
  - Planning outcomes are returned as statuses; contract errors as 422.

**Built: frontend**
- Typed models (`core/models.ts`) and `PlannerApi`.
- `PlannerStore` (Signals): points, settings, the computed `request`, and invalidation to `stale`. In-flight requests are cancelled and late responses dropped through a request id. It also handles map-click picking, Clear, Reset and the demo scenario.
- The `LocationInput` component, used twice for Point A and Point B:
  - Search on submit only, through a `switchMap`.
  - An explicit result list with out-of-coverage results disabled, plus Nominatim attribution.
  - Pick on map, manual coordinates, and the selected-address display.
- `PlannerPanel`:
  - Altitude `mat-slider` (20–120, step 5) synced with a validated number input.
  - NORMAL/EMERGENCY toggle and a profile `mat-select` loaded from the API.
  - DEMO/LIVE weather toggle with a live weather readout.
  - Calculate (with loading state and a hint listing what's missing), Clear Route, Reset Planner, Load Demo Scenario.
- `RouteResults`: status, distance, ETA, mode, altitude, drone, wind, warnings, data sources, an outdated banner, and errors.
- Map:
  - A/B pins and a route line in its own SVG pane: blue for NORMAL, red for EMERGENCY, grey dashed when stale.
  - Dotted links to snapped endpoints, fit-to-route, crosshair while picking, and click-to-pick.

**Verified**
- **pytest: 70 passed.** Covered:
  - Geocoding: parsing with mocked Nominatim, malformed entries, empty/short/long queries, provider and network failure (503), busy (429), cache hit and expiry, rate-limit spacing.
  - Routing: request validation (string, out-of-range or missing coordinates, bad enums, altitude 10/125/82/"80", the legacy `altitudeM` field, identical points), unknown profile.
  - Behaviour: start/destination changes change the route, avoidance of a known polygon, a real-data route never touching any zone in either mode, unreachable destination, NO_FLY and RESTRICTED blocking EMERGENCY, building height vs altitude.
  - Endpoints, weather and costs: outside coverage, destination in a zone, snapping, BLOCKED_WEATHER, headwind/tailwind ETA, LIVE parse and fallback, EMERGENCY shorter than the NORMAL river detour.
- **`ng test`: 56 passed.** Covered: address search action, no autocomplete, result selection without auto-picking, stale search dropped, manual coordinates, coverage notice, map marker sync, the route line by mode and staleness, slider and number input, mode, profile and weather selectors, payload generation, Calculate button state, loading, API and unreachable-backend errors, stale-route prevention, Clear, Reset, demo scenario.
- **`ng build`: OK with no warnings** (after the budget change below).
- **Live end-to-end in Edge (Playwright) against both servers, with real Nominatim:**
  - Searched "Warszawa Centralna" and "Centrum Nauki Kopernik", chose the results, and both markers appeared.
  - The POST carried the exact geocoded coordinates, and a 3.04 km route was drawn.
  - Switching to "Stadion Narodowy" marked the route stale; recalculating sent the new coordinates and produced a different 3.39 km route.
  - EMERGENCY at 40 m drew a red route. The Delivery profile with LIVE weather used real Open-Meteo wind.
  - The airport result was disabled. A map click inside the Sejm zone gave DESTINATION_BLOCKED, and a click outside the bbox gave the coverage notice.
  - Clear and Reset worked, and the demo scenario produced a 4.43 km route. There were no page errors.

**Decisions / assumptions**
- **NumPy A\* instead of NetworkX:** the request's fallback suggested NetworkX, but the spec forbids it at runtime. The NumPy A* meets every listed requirement.
- **EMERGENCY may not enter RESTRICTED zones,** per this request; the original spec allowed it at a cost. `costs.EMERGENCY_RESTRICTED_COST` is the single switch to restore that. EMERGENCY now only uses cheaper open and park costs.
- **The new request contract and controls replace the spec's versions:**
  - The contract uses `flightAltitudeMeters` (20–120, step 5), `droneProfileId` and `weatherMode`, replacing `altitudeM`, the 30–120 m range and wind sliders.
  - Route invalidation replaces auto-recalculation.
- **The synthetic dense-centre zone was shrunk** to the Palace of Culture block. In its Phase 2 size it covered Warszawa Centralna and Marszałkowska, two of the requested example addresses, which made them unusable as endpoints (START_BLOCKED).
- **Taking off or landing inside a zone** is rejected, not snapped. Points in tall buildings, or in cells merely touching a zone, snap up to 150 m with a warning.
- **Chopin Airport and Międzynarodowa 32/34A** geocode correctly but lie outside the routing area, so they get the coverage message by design.
- **LIVE weather is connected** (Open-Meteo) rather than only showing an "unavailable" message. When it fails, the fallback is explicit.
- **The initial bundle budget** in `angular.json` was raised from 500 kB to 1 MB (warning) and from 1 MB to 1.5 MB (error). The app is 816 kB because of Angular Material and Leaflet, and as a single page there is nothing to lazy-load.
- **Search stays enabled while a search runs,** so users can correct a query; `switchMap` drops the older response.

## Phase 4: Restricted airspace (DRA zones) + automatic avoidance (done, 2026-10-17)

**Official data research** (details in `DATA_SOURCES.md`): checked pansa.pl (zone pages and the "Dane" data page), dronemap.pansa.pl, airspace.pansa.pl and drony.gov.pl.
- No documented, permitted machine-readable zone source (API, WFS, ED-269 file) was found.
- DroneMap's backend is undocumented, so it is not used.
- **No official integration was possible.** The file-based interface (ED-269 or normalized GeoJSON) is ready for a permitted PAŻP export.

**Built: backend (`app/airspace/`)**
- **Model (`models.py`):** a normalized `AirspaceZone` with all the requested fields, explicit `None` = unknown, and `circle` kept next to its geodesic polygon.
- **Providers (`providers.py`, `factory.py`):**
  - `GeoJsonZoneFileProvider`, used for DEMO data and converted snapshots.
  - `Ed269FileProvider`, an ED-269-style parser: volumes merged into an envelope, feet converted to metres, circles turned into 128-vertex geodesic polygons, applicability mapped to validity, DRA label detection.
  - The provider is selected through `SKYROUTE_AIRSPACE_PROVIDER` / `SKYROUTE_AIRSPACE_FILE`.
- **Evaluation (`evaluation.py`):** applied per flight, in order:
  - validity period;
  - altitude band (AGL; AMSL via a terrain range; unknown reference means the zone applies; take-off and landing include the climb from the ground);
  - category rules (P blocked; R/RH/RM/RL and U unavailable without an authorization; T unavailable unless verified; I a warning; unknown or no source blocked).
  - Each zone gets a `displayClass` (RED/ORANGE/YELLOW/GRAY/INACTIVE) and an `isObstacle` flag.
- **Repository (`repository.py`):** an immutable state snapshot with metric geometry, an STRtree, and per-zone grid cells including a 20 m safety margin. `refresh()` hot-reloads changed data; a broken update keeps the last good version.
- **Grid:** now terrain and buildings only.
- **Planner:**
  - Zones are evaluated per request, and only the obstacle cells are blocked.
  - A point inside an obstacle zone is rejected with the zone named and never relocated. A point inside only the margin is joined from the margin.
  - Every final segment is checked against the exact obstacle polygons.
  - Conflicts are reported: `DIRECT_LINE_BLOCKED`, `ROUTE_CROSSES_INFO`, `NEAR_ROUTE`, `START/DESTINATION_INSIDE`.
- **API:**
  - New `GET /zones?altitudeM=&at=&mode=` and `GET /zones/{id}` (404).
  - `POST /routes/calculate` gained the optional `departureTime`, plus `zoneConflicts`, `airspace` (source, timestamp, version) and `planningVerificationStatus` (always SIMULATION_ONLY).
  - `/layers` no longer contains zones.
- **DEMO dataset:** `scripts/build_demo_data.py` writes `data/airspace/demo_zones.geojson` with 11 synthetic zones covering all categories, real circles, AGL and AMSL bands, an expired zone and a zone with incomplete metadata.
- **Removed:** the old `data/zones.geojson` and the `EMERGENCY_RESTRICTED_COST` switch. Hard restrictions are now identical for both modes.

**Built: frontend**
- **`core/airspace.ts` (`AirspaceService`):**
  - `/zones` is re-evaluated when the altitude changes, and the last value stays visible while reloading.
  - DRA category filters (display only) and highlight/focus of a conflicting zone.
  - A dataset version change marks the route stale; a route on a newer version triggers an airspace reload.
- **Map:**
  - Zones on the shared canvas below buildings: fill by class, solid red outline for obstacles, dashed when inactive.
  - Popups with all metadata and a DEMO badge (pick-mode clicks inside zones still pick points).
  - A DEMO/official banner, a new legend (RED/ORANGE/YELLOW/GRAY plus outline semantics and the data source) and an "Airspace zones" layer toggle.
  - EMERGENCY routes are now green, so they don't clash with red zones.
- **`planner/airspace-panel`:** source badge with version and disclaimer, DRA filters with counts, a zone list (click to focus), and an error state with retry.
- **Route results:** verification status, a conflict list with "Show zone", and a NO_ROUTE explanation.
- **Demo scenarios:** Blood delivery, Avoid a prohibited zone, and No route available.
- **Fix:** `httpResource.value()` throws in the error state, so every read now goes through `safeValue()`. Before this, an outage of /layers, /drone-profiles, /weather or /health could crash the template instead of showing a message.

**Verified**
- **pytest: 119 passed.** Covered:
  - Evaluation: every category, RH/RL likelihood text, an I-zone with a PROHIBITED restriction, missing source, validity, AGL/AMSL/unknown reference, endpoint climb.
  - Geometry and providers: geodesic circle accuracy (< 0.01 m), DEMO dataset labelling, invalid GeoJSON, ED-269 parsing (polygon, circle in feet, applicability, missing DRA label).
  - Avoidance: prohibited-polygon avoidance in both modes, safety margin, restricted zone conditional on altitude band, expired zone passable, I-zone crossed with a warning, unknown conditions blocked, MultiPolygon, circle.
  - Edge cases: route near a boundary ending at the exact selected point, start and destination inside a zone, NO_ROUTE enclosure, diagonal corner, recomputation after an obstacle change, broken-update fallback.
  - APIs: the zones API (fields, altitude and time evaluation, 404, 422), the deterministic DEMO avoidance and no-route scenarios, and real-data routes never crossing obstacle zones at 40 m and 80 m in either mode.
- **`ng test`: 73 passed, `ng build` clean.** Covered: zone rendering without a route, red/orange/yellow/gray styling and obstacle outlines, popup metadata, filters, airspace loading error, altitude re-evaluation, highlight, banner/legend source, pick inside a zone, verification status and conflicts, dataset-version invalidation, demo scenarios.
- **Live in Edge (Playwright) against both servers:**
  - 11 DEMO zones visible before any route.
  - Avoid-scenario route of 1.37 km; an independent Shapely check found no intersection with any obstacle polygon (≥ 36 m clearance).
  - No-route scenario shows NO_ROUTE with no line drawn.
  - A map pick inside the Sejm DRA-P zone gives DESTINATION_BLOCKED, highlights the zone and opens its popup.
  - At 40 m the school circles become "Unavailable"; the DRA-P filter hides those zones.
  - Adding a zone to the data file at runtime changed the version; the new zone appeared and the route was recalculated around it (1.69 km, 46 m clear). The file was restored afterwards.
  - No page errors.

**Decisions / assumptions**
- **NumPy A\* kept instead of NetworkX.** The project spec forbids NetworkX at runtime, and every requested routing property is implemented and tested.
- **R/T/U zones are routing obstacles** because no authorizations or capabilities are modelled. `FlightContext.authorizations` is the hook to add them later.
- **The UI no-route scenario** comes from real building geometry (a courtyard enclosed by buildings ≥ 10 m at 20 m altitude). Zone-enclosure no-route cases are covered by tests with synthetic polygons.
- **Terrain range 75–120 m AMSL** is used for AMSL limits, because there is no DEM.

## Next
- Obtain a permitted official zone export from PAŻP and validate the ED-269 mapping against it (see DATA_SOURCES.md).
- Spec phase 4 remainder: `/routes/compare`.
- Spec phase 5: drone animation, landing station / drop-point selection, "Holding position".
- Spec phase 6: polish and optional Docker.
