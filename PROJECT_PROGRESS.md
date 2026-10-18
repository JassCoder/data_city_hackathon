# Project progress

## Current state (2026-10-18)

- No airspace dataset is bundled or loaded by default. The backend starts with the `none` provider; routes explicitly report that airspace is unchecked and unverified. A permitted official file must be selected explicitly. `scripts/build_sample_data.py` generates optional synthetic sample zones for local testing only.
- Synthetic sample stations and drone profiles remain in the UI and are labelled as such. The phase notes below are historical implementation records; older references to a bundled zone file and generator are no longer current.

## Phase 1: Skeleton (done, 2026-10-17)

**Built**
- `backend/`: FastAPI app with CORS for `localhost:4200`, `GET /api/v1/health` (returns version, map centre,  bbox), and pytest coverage for health and CORS.
- `frontend/`: Angular 22 (standalone, zoneless, Signals) with an Angular Material theme and a Leaflet/OSM map centred on Warsaw. It draws the  bbox and shows a "" badge. Backend status comes from `httpResource` on `/health`, with a retry button.
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
- **`scripts/build__data.py`:** the generator for the hand-written synthetic data. Zones and stations are defined in tables at the top of the file.
  - `zones.geojson`: NO_FLY around Sejm/Wiejska and the Royal Castle area; RESTRICTED for the dense centre (Centrum/Palace of Culture) and 3 school buffers of 100 m (Powiśle, Śródmieście Płd., Mirów). All are `source: ""`.
  - `landing_stations.geojson`: a hospital pad (west of the centre), a Powiśle rooftop pad, a Rydz-Śmigły park pad, and a Vistula boulevard depot. All are `source: ""`.
  - The script refuses to write if any station falls inside a zone.
- **Backend:**
  - `app/schemas/layers.py` holds the Pydantic GeoJSON models (enums for zone, corridor, height source, station type and status).
  - `app/services/data_loader.py` loads and validates all 4 files at startup (FastAPI lifespan), checks geometry type and validity, and raises `DataLoadError` naming the missing or invalid file and the script that creates it.
  - It keeps full-detail Shapely geometries for Phase 3 routing and pre-serialises the `/layers` body once. Buildings and corridors are simplified at 1 m and coordinates rounded to 6 decimals; zones and stations are not simplified.
  - `GET /api/v1/layers` returns `{bbox, zones, corridors, buildings, stations}`. A GZip middleware was added: 2.8 MB becomes 0.47 MB, served in about 0.7 s locally.
- **Frontend:**
  - `core/layers.ts`: typed `LayersService` (`httpResource`, fetched once) with summary counts.
  - The map renders the bbox (dashed), NO_FLY (red), RESTRICTED (orange), RIVER (blue), PARK (green), and buildings (grey, dark when ≥ 50 m, tooltip with height and source). Stations use Material-icon markers with popups (name, type, status, capacity,  tag).
  - There is a Leaflet layer-toggle control, a legend with the  disclaimer, a "Data layers" summary in the right panel, a loading bar, and retry on error.

**Verified**
- `pytest`: 10 passed. Covered: all files load, zone types are valid, no station is inside a zone, stations and zones are inside the bbox, building height rules, a clear error for a missing file, rejection of an invalid zone_type, and the `/layers` shape plus gzip.
- `ng build`: OK with no warnings. `ng test`: 2 passed (layers fetched exactly once, summary and station marker rendered).
- In the browser (Edge driven by Playwright), all 7 layers render. A building tooltip inside the restricted zone shows its height and source, the zone tooltip shows in the gaps, the station popup opens, the toggles work (including the re-enable ordering), and there were no page errors.

**Assumptions / decisions**
- Synthetic zones and stations come from `build__data.py` rather than being typed into GeoJSON by hand, so circles are exact and placements are checked. The output GeoJSON is committed.
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
- **Drone profiles:** `data/drone_profiles.json`, a set that is the single source of truth.
- **Weather (`services/weather.py`):**  (fixed 14 km/h from 250°, gusts 22) and LIVE (Open-Meteo, 10-minute cache). On failure it uses explicit `_FALLBACK` with a "Live weather is not available" message.
- **API:**
  - Endpoints: `GET /geocoding/search`, `GET /drone-profiles`, `GET /weather`, `POST /routes/calculate`.
  - Strict camelCase Pydantic models (`CamelModel`, `extra="forbid"`, strict numbers).
  - Planning outcomes are returned as statuses; contract errors as 422.

**Built: frontend**
- Typed models (`core/models.ts`) and `PlannerApi`.
- `PlannerStore` (Signals): points, settings, the computed `request`, and invalidation to `stale`. In-flight requests are cancelled and late responses dropped through a request id. It also handles map-click picking, Clear, Reset and the  scenario.
- The `LocationInput` component, used twice for Point A and Point B:
  - Search on submit only, through a `switchMap`.
  - An explicit result list with out-of-coverage results disabled, plus Nominatim attribution.
  - Pick on map, manual coordinates, and the selected-address display.
- `PlannerPanel`:
  - Altitude `mat-slider` (20–120, step 5) synced with a validated number input.
  - NORMAL/EMERGENCY toggle and a profile `mat-select` loaded from the API.
  - /LIVE weather toggle with a live weather readout.
  - Calculate (with loading state and a hint listing what's missing), Clear Route, Reset Planner, Load  Scenario.
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
- **`ng test`: 56 passed.** Covered: address search action, no autocomplete, result selection without auto-picking, stale search dropped, manual coordinates, coverage notice, map marker sync, the route line by mode and staleness, slider and number input, mode, profile and weather selectors, payload generation, Calculate button state, loading, API and unreachable-backend errors, stale-route prevention, Clear, Reset,  scenario.
- **`ng build`: OK with no warnings** (after the budget change below).
- **Live end-to-end in Edge (Playwright) against both servers, with real Nominatim:**
  - Searched "Warszawa Centralna" and "Centrum Nauki Kopernik", chose the results, and both markers appeared.
  - The POST carried the exact geocoded coordinates, and a 3.04 km route was drawn.
  - Switching to "Stadion Narodowy" marked the route stale; recalculating sent the new coordinates and produced a different 3.39 km route.
  - EMERGENCY at 40 m drew a red route. The Delivery profile with LIVE weather used real Open-Meteo wind.
  - The airport result was disabled. A map click inside the Sejm zone gave DESTINATION_BLOCKED, and a click outside the bbox gave the coverage notice.
  - Clear and Reset worked, and the  scenario produced a 4.43 km route. There were no page errors.

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
  - `GeoJsonZoneFileProvider`, used for  and converted snapshots.
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
- **set:** `scripts/build__data.py` writes `data/airspace/_zones.geojson` with 11 synthetic zones covering all categories, real circles, AGL and AMSL bands, an expired zone and a zone with incomplete metadata.
- **Removed:** the old `data/zones.geojson` and the `EMERGENCY_RESTRICTED_COST` switch. Hard restrictions are now identical for both modes.

**Built: frontend**
- **`core/airspace.ts` (`AirspaceService`):**
  - `/zones` is re-evaluated when the altitude changes, and the last value stays visible while reloading.
  - DRA category filters (display only) and highlight/focus of a conflicting zone.
  - A dataset version change marks the route stale; a route on a newer version triggers an airspace reload.
- **Map:**
  - Zones on the shared canvas below buildings: fill by class, solid red outline for obstacles, dashed when inactive.
  - Popups with all metadata and a  badge (pick-mode clicks inside zones still pick points).
  - A /official banner, a new legend (RED/ORANGE/YELLOW/GRAY plus outline semantics and the data source) and an "Airspace zones" layer toggle.
  - EMERGENCY routes are now green, so they don't clash with red zones.
- **`planner/airspace-panel`:** source badge with version and disclaimer, DRA filters with counts, a zone list (click to focus), and an error state with retry.
- **Route results:** verification status, a conflict list with "Show zone", and a NO_ROUTE explanation.
- ** scenarios:** Blood delivery, Avoid a prohibited zone, and No route available.
- **Fix:** `httpResource.value()` throws in the error state, so every read now goes through `safeValue()`. Before this, an outage of /layers, /drone-profiles, /weather or /health could crash the template instead of showing a message.

**Verified**
- **pytest: 119 passed.** Covered:
  - Evaluation: every category, RH/RL likelihood text, an I-zone with a PROHIBITED restriction, missing source, validity, AGL/AMSL/unknown reference, endpoint climb.
  - Geometry and providers: geodesic circle accuracy (< 0.01 m), set labelling, invalid GeoJSON, ED-269 parsing (polygon, circle in feet, applicability, missing DRA label).
  - Avoidance: prohibited-polygon avoidance in both modes, safety margin, restricted zone conditional on altitude band, expired zone passable, I-zone crossed with a warning, unknown conditions blocked, MultiPolygon, circle.
  - Edge cases: route near a boundary ending at the exact selected point, start and destination inside a zone, NO_ROUTE enclosure, diagonal corner, recomputation after an obstacle change, broken-update fallback.
  - APIs: the zones API (fields, altitude and time evaluation, 404, 422), the deterministic  avoidance and no-route scenarios, and real-data routes never crossing obstacle zones at 40 m and 80 m in either mode.
- **`ng test`: 73 passed, `ng build` clean.** Covered: zone rendering without a route, red/orange/yellow/gray styling and obstacle outlines, popup metadata, filters, airspace loading error, altitude re-evaluation, highlight, banner/legend source, pick inside a zone, verification status and conflicts, dataset-version invalidation,  scenarios.
- **Live in Edge (Playwright) against both servers:**
  - 11  zones visible before any route.
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

## Phase 5: Whole-city coverage + route optimisation options (done, 2026-10-17)

**Built: data**
- `scripts/fetch_boundaries.py`: the official boundary from GUGiK PRG OGC API Features. City TERYT `1465` (516.7 km²) and the 18 districts (`1465NN_8`), validated (count, area match within 1%) and cached in `data/boundaries/`.
- `scripts/fetch_osm.py` rewritten for the whole city:
  - 16 tiled Overpass queries per layer, with retries; about 40 minutes.
  - **189,276 buildings** (174 at 50 m or taller), rasterised into a **25 m citywide grid of 1,198 × 1,151 cells** (`data/osm/grid_warsaw_25m.npz`, 0.3 MB).
  - 263 gzipped z14 building tiles for display (12 MB).
  - Citywide corridors (river + 2,822 parks), plus `tall_buildings.geojson`.
  - Invalid geometries from rounding are repaired.
  - The old central `buildings.geojson` was removed.

**Built: backend**
- `app/geo/coverage.py`: polygon `Coverage` with districts and prepared geometries. A missing boundary gives `available=False` and routing returns `COVERAGE_UNAVAILABLE`; there is no rectangle fallback.
- `grid.py`:
  - Loads the precomputed raster; the coverage mask comes from the city polygon.
  - `pool_blocked()` for conservative coarsening.
  - `build_grid()` kept for synthetic tests.
- **Corridor A\* (`planner.py`):**
  - Searches a window around A–B (margin of at least 1.5 km and 35% of the distance), widened ×2.5 up to the whole city when no path is found.
  - Windows larger than 300k cells are coarsened (any blocked sub-cell blocks the coarse cell).
  - Budgets of 1.2 M expansions per attempt and 20 s total; exhaustion gives `SEARCH_LIMIT`.
  - A route cache keyed by request, wind samples and dataset version, plus a per-settings cost-array cache.
  - Final segments are checked against the exact zones and the 25 m building raster.
- `astar.py`: flat-list implementation with an octile heuristic, node and time budgets, and an optional **direction-dependent move cost**.
- **Route objectives (requested mid-phase):**
  - `routeObjective` = `CORRIDORS` (default) | `SHORTEST` | `FASTEST`.
  - `FASTEST` uses, for each of the 8 move directions, *cruise speed ÷ ground speed* from the nearest wind sample (a region raster plus a per-sample table), with an admissible heuristic.
- **Weather:** LIVE samples the Open-Meteo next-hour forecast along the A–B line (one point per ~5 km, max 8, one multi-location request) at 10/80/120 m, interpolated to the flight altitude and cached. The ETA uses the nearest sample per segment, and wind above the limit at any sample gives `BLOCKED_WEATHER`.
- **Airspace:** datasets can declare an `extent`; the  extent is central Warsaw. The length of route outside it is reported (`coverage.airspaceOutsideExtentM`, a warning, and "PARTIAL AIRSPACE DATA" in the verification status).
- **API:**
  - New `GET /map/warsaw-boundary`, `GET /map/coverage` and `GET /map/buildings/14/{x}/{y}`.
  - The route response gained `routeObjective`, `coverage` (districts, validity, source) and `search` (resolution, window, attempts, expansions, time, cached).
  - The geocoding viewbox comes from the city bounds, and `inCoverage` is a point-in-polygon test.
  - `/health` reports `coverageAvailable`.

**Built: frontend**
- `core/map-data.ts` (boundary + coverage resources) and `core/geo.ts` (point-in-polygon with holes and MultiPolygons). The store validates points against the city polygon.
- **Map:**
  - Starts on an approximate city view, then **fits the official boundary**.
  - City outline, 18 district outlines with permanent labels, and a **Show Entire Warsaw** control.
  - A labelled fallback banner if the boundary is missing.
  - Building footprint tiles loaded on demand from zoom 15 (cached, at most 30 in view); tall buildings always shown.
  - A dashed outline of the airspace dataset extent.
  - A `ResizeObserver` calls `invalidateSize`, and zero-size containers no longer jump to maximum zoom.
- **Planner:** a **Route optimisation** toggle (Safe corridors / Shortest / Fastest) with an explanation. The weather readout shows the wind at the chosen altitude.
- **Results:** the optimisation used, start → destination districts, search statistics, and labels for `SEARCH_LIMIT` and `COVERAGE_UNAVAILABLE`.
- **Styles:** the map styles moved to the global `src/styles/map.scss` (they were already global via `ViewEncapsulation.None`; this stays under the component style budget).
- **:** the no-route scenario moved to an enclosed courtyard in Praga-Północ (the old one is not enclosed in the fresh OSM snapshot).

**Verified**
- **pytest: 164 passed.** New `test_citywide.py` and `test_weather.py`, plus objective tests. They cover:
  - The official boundary (18 districts, TERYT codes) and point-in-polygon versus bounding box.
  - Each test point lies in its named district.
  - The 5 district pairs (Śródmieście→Mokotów, Wola→Praga-Południe, Ursynów→Białołęka, Bemowo→Wawer, Wilanów→Bielany): feasibility not assumed; districts, budgets and zone clearance checked.
  - Long-distance performance and caching, airspace-extent flagging, start or destination outside Warsaw, a zone near the destination, the map endpoints, building tiles, and missing boundary data (503 / `COVERAGE_UNAVAILABLE`).
  - Corridor widening, conservative coarsening, `SEARCH_LIMIT`, and `NO_ROUTE` over the whole coverage.
  - Weather sampling, altitude interpolation, caching and fallback.
  - Shortest versus corridors, Fastest choosing the longer but calm gap under variable wind, and objectives respecting zones.
- **`ng test`: 86 passed; `ng build` clean.** Added: point-in-polygon, boundary and districts rendering with fit-on-load, Show Entire Warsaw, the fallback banner, tile maths, tiles loaded only at street zoom, the objective selector and payload, and the objective, districts and search display.
- **Live in Edge (Playwright) against both servers:**
  - The whole city on load with 18 district labels.
  - Real Nominatim search: Lotnisko Chopina (Włochy) → Pałac w Wilanowie (Wilanów).
  - Safe corridors 9.06 km / Shortest 8.19 km / Fastest 8.19 km, each in 63–221 ms, with "8.2 km outside the loaded airspace data" flagged.
  - Show Entire Warsaw works; street zoom loaded 9 tiles (3,642 footprints in view).
  - A point outside Warsaw is refused. No page errors.
- **District pairs measured** (Safe corridors / Shortest / Fastest):

  | Pair | Safe corridors | Shortest | Fastest | Searched at |
  |---|---|---|---|---|
  | Śródmieście→Mokotów | 4.08 km | 3.49 km | 3.49 km | 25 m |
  | Wola→Praga-Południe | 8.81 km | 8.18 km | 8.19 km | 25 m |
  | Ursynów→Białołęka | 26.6 km | 19.95 km | 20.3 km | 50 m |
  | Bemowo→Wawer | 24.8 km | 20.0 km | 20.2 km | 50 m |
  | Wilanów→Bielany | 21.5 km | 16.7 km | 16.8 km | 50 m |

  Every search took ≤ 240 ms.

**Decisions / assumptions**
- **Precomputed raster instead of rasterising 189k buildings at startup:** startup takes about 1 s. The same building data is served as tiles for display.
- **Corridor plus conservative coarsening** instead of a single fine citywide search. It is fast and never unsafe, but a coarse result may be longer than a fine one, and `NO_ROUTE` states the resolution searched.
- **NumPy A\* kept,** per the project spec (no NetworkX at runtime).
- **No zones were invented** for the rest of the city (airports and so on). Uncovered route length is reported instead.
- **Route optimisation is a separate field** from NORMAL/EMERGENCY, to keep the agreed API contract.

## Phase 6: Dynamic routing scenarios, no hard-coded endpoints (done, 2026-10-18)

**What the inspection found**
- **No hard-coded route polylines existed.** Every displayed route was already calculated by A* from the submitted points.
- **The one behaviour that replaced Point A/B:** the frontend "Load  Scenario" buttons (`loadScenario`: "Blood delivery", "Avoid a prohibited zone", "No route available"). They set fixed coordinates or stations, plus altitude, drone profile and mode. The "Blood delivery" label made it look like a routing mode.
- **Not in the app before:** "AED / First Aid", "Normal Flight" and "Emergency Flight" as scenarios (NORMAL/EMERGENCY existed only as the flight-mode toggle, which never touched the points). There is also no AED-location dataset in the repo; none was invented.

**Built: backend**
- `app/routing/scenarios.py`: a configuration-driven `Scenario` enum and `ScenarioConfig`, holding display name, description, `OptimizationGoal` (→ `RouteObjective`), cost-profile mode, `use_weather`, a suggested profile only, and `respect_restricted_zones=True`, asserted for every scenario. **No coordinates.**
  - NORMAL → corridors.
  - BLOOD_DELIVERY and AED_DELIVERY → MINIMIZE_ETA (fastest).
  - AVOID_PROHIBITED_ZONE → MINIMIZE_DISTANCE (shortest around all active blocked zones).
  - EMERGENCY → MINIMIZE_ETA with EMERGENCY mode.
- `app/services/route_service.py` `RouteService`: one shared pipeline (resolve scenario → profile → wind sampling → the **same** `RoutePlanner`/A* → response). The router is now thin. `get_route_service` is built from the overridable planner, profiles and weather dependencies.
- **API:**
  - `RouteRequest.scenario` is optional, so older requests still work. An explicit `mode`/`routeObjective` that contradicts the scenario gets a **422** (detected via `model_fields_set`) instead of being silently overridden.
  - The response echoes `start` and `destination` exactly, plus `scenario`, `scenarioDisplayName` and `optimizationGoal`.
  - New `GET /api/v1/scenarios` (configuration only).
  - A suggested profile produces a warning but never changes the user's `droneProfileId`.

**Built: frontend**
- **Store:** `PlannerStore` is the flight-planner store.
  - Its fields map to the requested names: `start`/`destination` (`SelectedLocation` with label + coordinates), `altitude`, `droneProfileId`, `weatherMode`, the new `selectedScenario`, and `route` (idle / loading / ready / stale / error).
  - `selectScenario(id)` sets the scenario and its mode/objective, keeps A, B, altitude, profile and weather, invalidates, then recalculates with the same coordinates. If a point is missing it shows "Please select both the starting point and destination before calculating a route." and sends nothing.
  - Manual mode/objective changes switch to custom settings (`scenario` omitted).
  - Stale and late responses are dropped through the existing `requestId`.
- **Planner panel:** a "Routing scenario" grid with 5 buttons loaded from `/scenarios`. The active one is highlighted (`aria-pressed`) and shows its description and suggested profile, which is not applied.
- ** fixtures:** the  buttons became `_FIXTURES` ("Depot → hospital pad", "Across the Sejm zone", "Enclosed courtyard"), behind a collapsed **"Load  fixture (replaces Point A and B)"** toggle. They set points (and 20 m for the courtyard) only, never the scenario, mode, profile or weather, and are never called by scenario selection.
- **Results:** the route results show the scenario name.

**Hard-coded coordinate audit** (app code, after the change)

| Location | Classification |
|---|---|
| `backend/app/config.py` `MAP_CENTER` | Map / weather configuration: default map centre and the point for  wind / `GET /weather`. Never a route endpoint. |
| `backend/app/config.py` `_BBOX` | Dataset metadata: the extent of the synthetic  airspace dataset. |
| `config.py` / `core/map-data.ts` `FALLBACK_VIEW` | Map view shown only if the boundary is missing. Not a route. |
| `planner/location-input.ts` help text "e.g. 52.2297 and 21.0122" | UI hint text. |
| `core/planner.store.ts` `_FIXTURES` | **Explicit nstration fixture**, only via "Load  fixture". |
| `scripts/build__data.py`, `data/airspace/_zones.geojson`, `data/landing_stations.geojson` | Synthetic set (zones, stations). |
| `data/boundaries/*`, `data/osm/*`, `data/corridors.geojson`, `data/tall_buildings.geojson` | Real geographic datasets (GUGiK PRG, OSM). |
| `*.spec.ts`, `backend/tests/*` | Test fixtures. |
| Unwanted hard-coded routing behaviour | **None remaining.** The old `loadScenario` (scenario-like labels that replaced A/B, profile, mode and altitude) was refactored into explicit fixtures. |

**Verified**
- **pytest: 205 passed.** New `test_scenarios.py` (41 tests), each across all 5 scenarios where relevant:
  - Submitted coordinates are echoed, and the route starts and ends exactly there; changing the scenario never changes the endpoints.
  - Changing Point A or B changes the route.
  - The -P-SEJM direct line is avoided, with `DIRECT_LINE_BLOCKED` reported; a synthetic full wall gives NO_ROUTE.
  - A meaningful NO_ROUTE for the enclosed courtyard; missing start, destination or both → 422.
  - Objective mapping; Blood, AED and Emergency giving an identical route; the suggested profile not applied; conflicting settings → 422; unknown scenario → 422; legacy requests without a scenario; `/scenarios` containing no coordinates.
- **`ng test`: 102 passed; `ng build` clean.** Covered:
  - Selecting each scenario keeps the same A and B objects and sends their exact coordinates plus the scenario.
  - Altitude, profile and weather are kept; no predefined coordinates are loaded when a point is missing.
  - A scenario change cancels the outdated request; manual changes → custom.
  - The panel highlights the active scenario; address text and selection are unchanged; map markers keep their lat/lng across scenario routes.
  -  fixtures sit behind an explicit toggle.
- **Acceptance test in Edge (Playwright), live servers, real Nominatim — 66/66 checks:**
  - **Trip 1** (Warszawa Centralna → Stadion Narodowy, sent as 52.2288207, 21.00316 → 52.2397726, 21.0454432):
    - NORMAL 3.41 km; Blood / AED / Emergency 3.16 km (identical); Avoid Prohibited Zone 3.22 km (shortest path, PKiN zone listed as avoided).
  - **Trip 2** (Łazienki Królewskie → Dworzec Gdański):
    - NORMAL 7.26 km; Blood / AED / Emergency 6.01 km; Avoid 5.78 km.
  - For every scenario in both trips: the backend received **the same coordinates as NORMAL** and echoed them; the route starts and ends at those exact points; addresses and marker positions were unchanged; the button was highlighted; no fixture coordinates were sent.
  - With no points selected, the scenario shows the message and sends nothing.
  - An independent Shapely check: no trip-1 route touches any obstacle zone. No page errors.

## Phase 7: Citywide airspace coverage, diagnostics and shared obstacles (done, 2026-10-18)

### Root cause (from code inspection)
The zones clustered in Śródmieście because of the **data**, not a code filter. Checked against the code:

| Suspected cause | Finding |
|---|---|
| Provider loads only the  region | **Yes, by data:** the only dataset is `_zones.geojson`. All 11 zones lie inside `_BBOX`, which covers **3.3 %** of the city. |
| Frontend filters zones to a bbox / viewport fetching | No: `/zones` was requested once for all zones, and every returned zone was drawn |
| Backend returns a few hard-coded features | No: it returned every feature in the file |
| Only one DRA category loaded | No: P, R/RH/RM/RL, T, U, I and UNKNOWN were all loaded |
| Polygon/MultiPolygon parsing, lon/lat order, projection | Correct (now covered by tests: round trip, holes, swapped-order detection) |
| Zones hidden behind layers | No: canvas order is corridors < zones < buildings, and the route/markers are in higher panes |
| Validity/altitude filtering discards zones | No: inactive zones are still returned and drawn (dashed) |
| A  configuration overrides official data | No: the provider is chosen by `SKYROUTE_AIRSPACE_PROVIDER`; a citywide file loads in full |

**Data source re-check (DATA_SOURCES.md):**
- Still no permitted UAS-zone source.
- PAŻP's AIXM 5.1 AIP Data Set is subscription-only, for aviation use only, and covers manned-aviation airspace rather than DRA zones. It was not integrated.
- **Nothing was fabricated:** no zones were invented for other districts or the airports.

### Changes
- **Backend:**
  - **`GET /zones`:**
    - `bbox` filter: STRtree, exact geometry intersection, 422 on a malformed box;
    - `format=geojson` (FeatureCollection);
    - `completeness` (COMPLETE/PARTIAL/NONE plus the % of the city covered) and `totalZones`.
  - **`GET /zones/diagnostics` (`app/airspace/diagnostics.py`):**
    - totals per DRA group and blocked/conditional/obstacle counts;
    - per-district coverage % and status (``/`OFFICIAL_SNAPSHOT`/`OFFICIAL`/`PARTIAL`/`UNAVAILABLE`, never "verified") with zone counts and notes ("zero is not an error");
    - zones outside the city (with a coordinate-order hint), duplicates removed, the last reload error, warnings.
  - **Providers:**
    - `dedupe_zones`: exact duplicates are dropped; conflicting ids reject the dataset;
    - `CompositeProvider`: several files in `SKYROUTE_AIRSPACE_FILE`, merged with deduplication.
  - **Shared obstacles:** routing and map already shared one `AirspaceState` + `evaluate()`. Tests now prove that the map's obstacles are the router's (altitude flip on the same zone).
- **Frontend:**
  - **Map:** red #DC2626 / #B91C1C, weight 2, fill 0.35; information zones blue; popup adds the zone ID and the dataset update; legend updated.
  - **Airspace panel:** loading bar, PARTIAL banner, freshness (age; stale after 28 days or undated), and a **Coverage diagnostics** debug panel (fetched only while open).
  - **Planned departure:** sent as `departureTime`, used for zone evaluation (`&at=`), and invalidates the route.
- **Test fixtures:** `backend/tests/citywide_zones.py` holds **synthetic** TEST zones across north/south/east/west Warsaw, a MultiPolygon, a ring with a hole, a temporary zone, an unknown zone, a zone straddling the boundary, a zone outside the city, and airport fixtures (pytest only). `python -m tests.citywide_zones out.geojson` writes them for a manual run.

### Verification
- **Tests:** backend **239 passed** (new `test_citywide_airspace.py`, 34 tests); frontend **114 passed**; `ng build` clean.
- **E2E (Playwright/Edge, real UI, Nominatim):** 6 district pairs (Włochy→Mokotów, Bemowo→Bielany, Białołęka→Śródmieście, Ursynów→Wawer, Praga-Południe→Rembertów, Wilanów→Żoliborz).
  - **With the citywide TEST fixture loaded:**
    - all 12 zones drawn, 100 % coverage;
    - every pair geocoded into the named districts, markers unchanged, every route OK;
    - no route intersects any obstacle zone (Shapely); TEST-RL-RING and TEST-T-EAST-MID were crossed by the direct line and avoided;
    - diagnostics listed 18 districts.
  - **With the default :**
    - PARTIAL banner (3.3 %); 13 districts `UNAVAILABLE`;
    - routes OK and flagged as simulation with partial airspace data;
    - -T-UW and -P-SEJM crossed by the direct line and avoided.
  - No page errors in either run.

## Phase 7b: Full-Warsaw geographic coverage – backend (done, 2026-10-18; frontend part pending)

- **Buildings:**
  - Unknown heights stay unknown: 12,897 footprints have `height_m: null` and `height_source: "unknown"` (formerly an invented 15 m).
  - Routing applies an explicit policy, `SKYROUTE_UNKNOWN_BUILDING_POLICY=assume:15|block`.
  - The raster was rebuilt offline with `scripts/rebuild_buildings_from_tiles.py`; 0.36 % of building cells changed.
- **Airports:** real OSM footprints in `scripts/fetch_airports.py` → `data/airports.geojson` (EPWA, EPBC, plus 2 airfields just outside the city). They are an informative layer, never zones.
- **Optional planning constraints:** airport footprints, avoided with the request flag `planningConstraints`. They are NON-REGULATORY.
- **New endpoints:** `GET /map/districts`, `GET /buildings?bbox=` and `GET /airports?bbox=`.
- **Separate coverage metrics** in `/map/coverage`:
  - geographic routing: 100 %, VALIDATED by 5 checks;
  - buildings: fetched extent, plus known and unknown heights;
  - official airspace: source states OFFICIAL / OFFICIAL_SNAPSHOT / SYNTHETIC / UNAVAILABLE / STALE; synthetic zones never count;
  - weather: the last LIVE outcome.
- **Routes without current official data** are labelled "UNVERIFIED SIMULATION".
- **Tests:** `test_citywide_coverage.py` (18 tests) routes in every district.
- **Pending:** the frontend coverage panel and the split zone layers.

## Phase 8: Citywide hospitals, depots, restaurant partners and fleet (done, 2026-10-18)

### Architecture
- **Real geographic records** (read-only, committed):
  - `scripts/fetch_pois.py` queries Overpass (nodes, ways, relations), clips to the GUGiK polygon and deduplicates.
  - Output: `data/pois/hospitals.geojson` and `restaurants.geojson`. Neither the browser nor the backend calls Overpass.
- **Simulated infrastructure** (`backend/app/fleet/`, SQLite at `data/fleet/fleet.sqlite`, stdlib `sqlite3`):
  - Facilities: hospital stations, depots and restaurant pads. Plus drones, subscriptions and orders.
  - Capacity invariants are database CHECKs (`occupied + reserved <= capacity`, none negative).
  - Every change runs in `BEGIN IMMEDIATE` transactions with conditional UPDATEs, so reservations are atomic.
  - Simulation records reference OSM ids, so a POI re-import never deletes them. `sync_pois` adds stations for new hospitals.
- **Seed** (deterministic, first start only):
  - **Hospital stations:** one PROPOSED station per hospital (capacity `HOSPITAL_STATION_CAPACITY` = 2). 6 spatially spread ones are SIMULATION_ENABLED and labelled DEMO.
  - **Depots:**
    - the existing Vistula depot `st-depot` is preserved;
    - 9 planned depots come from a greedy p-median (`app/fleet/planning.py`) over simulated demand. Demand = real restaurants and hospitals × assumed district multipliers, plus district base demand;
    - candidates are a 1.2 km grid snapped to open cells outside obstacle zones;
    - standard depots get 6 spaces, the 3 highest-demand depots get 12;
    - 4 or 8 drones per depot.
  - **Restaurant partners:** 6 named restaurants become DEMO partners (fictional agreements) with proposed pads (capacity 1).
- **Assignment:**
  - Required landing facilities must be enabled, open and have space.
  - The nearest 4 depots with available drones are shortlisted by straight line, one drone per profile. Battery must be ≥ 25 %.
  - Each candidate gets 3 legs from the shared `RoutePlanner` (FASTEST): to pickup, delivery and return. The usable range check (battery, 15 % reserve) includes the return leg.
  - Candidates are ranked by routed time. The drone and the landing reservations are taken atomically; a concurrent loser falls through to the next drone.
  - Failures are explicit: `NO_DRONE_AVAILABLE` with a reason per candidate, or `FAILED` (station full or closed, with the nearest alternative).
- **Parking rules:**
  - The home depot space stays held as a return reservation while the drone flies.
  - Pickup and destination facilities go reserved → occupied → free.
  - Completion: the drone is CHARGING and its battery is reduced by the distance flown.
- **API:**
  - Hospitals, depots, restaurants (paginated / bbox), landing pads (plus a `check` endpoint), drones.
  - `fleet/summary|availability|demand`.
  - Orders: create, assign, advance, cancel.
  - Admin mutations need `X-Admin-Token` (development token; refused in production without `SKYROUTE_ADMIN_TOKEN`).
- **Frontend:**
  - **Data service:** `core/fleet.ts`.
  - **Map layers:**
    - Hospitals (clustered by a small in-house clusterer, `map/cluster.ts`), depots, subscribed restaurants, all restaurants (lazy, clustered), proposed pads, drone badges and delivery routes;
    - popups offer Set A/B, Order food delivery, Deliver to station and View fleet.
  - **Fleet dashboard** (toolbar button):
    - stats, utilisation bars and a district filter;
    - an order form on the planner's Point A/B. A facility id is sent only while the point still sits on that facility;
    - an orders list with Advance / Cancel;
    - simulated demand and recommendations;
    - development admin controls: depot capacity, enabling depots and stations.
  - **Legacy overlay:** the synthetic "Sample landing stations" overlay is now off by default.

### Results (real data, 2026-10-18)
- **Hospitals:** 45 after deduplication (54 raw, 46 inside Warsaw), in 14 districts. Bemowo, Rembertów, Ursus and Włochy have no hospital mapped in OSM.
- **Restaurants:** 1,972 after deduplication (2,147 raw, 1,976 inside Warsaw), in all 18 districts.
- **Depots:** 10, with 78 simulated spaces; 52 drones.
- **Partners:** 6 demo partners with pads; 6 demo hospital stations.
- **Plan quality:** covers 99 % of the simulated demand within 6 km; mean straight-line distance 1.9 km.

### Verification
- **Tests:** backend **285 passed** (`test_fleet.py`, 28 new); frontend **132 passed** (fleet panel, fleet layers, clustering, app action); `ng build` clean.
- **E2E** (Playwright/Edge, real UI, Nominatim, all checks passed, no page errors):
  - **A – medical:** Plac Zbawiciela → Warszawski Szpital Dla Dzieci station (capacity 2).
    - SR-022 was reserved and the station showed 1 reserved, 1 free.
    - 6 simulated steps followed. The station was occupied while landed, then freed; the drone returned home CHARGING.
    - An earlier attempt to the Ursynów station was correctly refused: the round trip of 20–25 km exceeds the usable range.
  - **B – restaurant:** the demo partner "Tasty" popup was opened, then "Order food delivery" set Point A to the pad. Point B was set to Stadion Narodowy by search.
    - The drone came from depot-07, and the pad was reserved → occupied while loading → freed.
  - **C – busy centre:**
    - Under CENTRAL_PEAK, depot 05 (Śródmieście) needs ~21.9 drones at peak against 12 spaces: HIGH.
    - Central depots are more utilised than outlying ones.
    - Raising the capacity to 22 in admin dropped utilisation from 1.83 to 1.0; it was then restored.

## Phase 9: UI redesign, simplified planner, LIVE weather, building-level addresses (done, 2026-10-18)

- **Layout:**
  - The right column was removed; the map fills the space next to the plan-route panel.
  - **Layers** (top right, `MapLayersControlComponent` + `MapLayerStore`):
    - all 15 layers with the specified defaults, kept per browser session;
    - DRA categories as sub-options with dynamic counts;
    - a warning when official data is missing.
    The map registers each Leaflet layer under its key instead of using Leaflet's layer control. Building tiles load only while the layer is on and at zoom ≥ 15.
  - **Route Details** (directly below; `RouteDetailsPanelComponent`):
    - overview, weather, drone and safety sections, plus the calculation time;
    - no zone list;
    - it opens by itself for a new route.
  - **Airspace Legend** (bottom; `AirspaceLegendComponent`):
    - colours shared with the map styles, altitude, evaluation time, provider, freshness and verification;
    - the zone list, diagnostics and map symbols are in expandable sections.
  - One top-right panel opens at a time.
  - Responsive: at 414 px there is no horizontal overflow, and panels stay inside the map.
- **Planner:**
  - **Removed from the UI:** scenario cards, the departure picker, the profile dropdown and the sample-route buttons. The scenario and fixture store methods remain, and the API still accepts `scenario`.
  - **Defaults:** Flight Mode Normal/Emergency; Route Optimisation **Fastest** (default) / Shortest / Balanced; fixed **Standard Drone** (`DEMO_DRONE_01`, read-only); weather **LIVE** (`WeatherStatusComponent`).
- **Contract:**
  - `optimization` (FASTEST / SHORTEST / BALANCED → route objective); a contradiction with `routeObjective` or `scenario` returns 422.
  - `droneProfileId` defaults to `DEMO_DRONE_01`. The profile ids were restored from the mangled `_DRONE_0x`, with a one-time fleet-DB migration.
  - The backend sets the calculation time (`app/services/clock.py`, Europe/Warsaw, with an EU daylight-saving fallback because this Windows Python has no tz database). It is returned as `calculatedAt`.
- **Weather:**
  - LIVE is real Open-Meteo data.
  - On failure: CACHED last-live values (≤ 3 h), otherwise sample wind labelled *NOT live data*. In both cases the verification status says "WEATHER NOT CURRENT".
- **Addresses** (`app/services/address.py`):
  - A parser for street, building number (incl. `32/34A`), flat (`m.`, `lok.`, `/`) and coordinates.
  - **GUGiK PRG address points** (UUG service), with every result re-checked against the requested street.
  - Nominatim with `addressdetails` classified into accuracy levels; a ranked, deduplicated list with an explanatory note.
  - Flats are kept, never geolocated.
- **Entrances:**
  - `scripts/fetch_entrances.py` → 26,772 mapped OSM entrances.
  - `GET /geocoding/entrances` links them to the building footprint (building tiles); `matchesFlat` comes only from `addr:flats`.
  - The UI offers them after a building-level match (list and map pins).
- **Tests:** backend **315 passed** (`test_address_and_contract.py`, 30 new); frontend **158 passed** (overlays spec: 23; planner, address, entrance, map and layout updates); `ng build` clean.
- **E2E** (Playwright/Edge, real GUGiK, Nominatim and Open-Meteo; all checks passed, no page errors):
  - **Layout:** Layers top right, Route Details directly below, the Legend at the bottom, no right column.
  - **Weather:** LIVE Open-Meteo values with the forecast time.
  - **Layers:** DRA counts of 0 with the missing-data warning. The districts and hospitals toggles work.
  - **Address A:** "Korotyńskiego 19 m. 60" → PRG building match, flat 60 kept, 4 mapped staircases with *III (flats 53–78) serves flat 60* first. Choosing it moved Point A onto the entrance.
  - **Address B:** "Al. Jerozolimskie 54" → PRG building match.
  - **Route:** the request carried exactly `{start, destination, mode, optimization: FASTEST, flightAltitudeMeters, droneProfileId: DEMO_DRONE_01, weatherMode: LIVE}`, with the start at the entrance. The route was OK at 3.79 km with Open-Meteo wind, and Route Details opened with every section.
  - **Phone (414 px):** no overflow.

## Phase 10: Red geofencing of restricted zones (done, 2026-10-18)
- **Why no zones showed:** no airspace dataset is loaded (`SKYROUTE_AIRSPACE_PROVIDER=none`). A re-check on 2026-10-18 found no documented, permitted PAŻP dataset, API or ED-269/ED-318 file (pansa.pl/strefy-geograficzne). DroneMap's backend stays unused (undocumented). No zones were fabricated.
- **Red geofencing:** restricted zones (DRA-R/RH/RM/RL, no authorization) now evaluate as RED, like DRA-P: fill #DC2626 at 0.30 opacity, solid #B91C1C boundary, weight 2. ORANGE is now U-space, or restricted with an authorization. Legend and diagnostics labels follow.
- **APIs:** `GET /zones/summary` and `GET /airspace/status`. `/map/coverage` reports `routing.airspaceSafetyMarginM`, which the legend shows as a configurable modelling assumption.
- **Frontend:** the banner reads "Official airspace data unavailable. Routing is an unverified simulation." unless an official file is loaded. Choosing the second point calculates the route at once; settings changes still only invalidate it.
- **Tests:** `test_geofence.py` covers a deterministic detour around a restricted polygon with exact endpoints, multipolygons, several zones, a hole (not blocked, but unreachable through the ring), entry through a gap, a blocked destination in both modes, and the summary/status endpoints. Backend 328 passed; frontend 162 passed; build clean.
- **Live check (synthetic zones loaded temporarily, then removed):** the TEST-RM-SOUTH zone was drawn red, choosing A and then B calculated automatically with the exact points, and the 2.41 km route did not intersect the zone, while the straight line did.

## Phase 11: Planning constraints (airports, military, government) and no manual coordinates (done, 2026-10-18)
- **Request:** routes crossed Chopin Airport. The user asked for airport, army and government areas to be red and avoided.
- **What was built:**
  - `scripts/fetch_planning_constraints.py` writes `data/planning_constraints.geojson` with real OSM footprints: 2 airports, 86 military areas and 477 government buildings, including the Sejm, KPRM, MON and the President's Chancellery.
  - `app/airspace/constraints.py` adds them to the shared airspace dataset as BLOCKED/RED obstacles at every altitude and in every mode, under their own category `PLANNING`. Official-data status is unchanged.
- **Frontend:**
  - A "Planning constraints" category with its own count.
  - A popup notice and a legend row stating they are not official zones.
  - The manual Coordinates entry was removed from both point inputs.
- **Tests:**
  - `test_planning_constraints.py` (8) covers: real footprints, the RED/obstacle evaluation, Chopin avoided in both modes on the real grid, a destination inside the airport or the Sejm blocked, no effect on official status, the on/off switch, reloads, and the reserved category.
  - Backend 336 passed; frontend 162 passed; build clean.
- **Live check:** an A→B route across Chopin Airport (picked on the map) was 6.64 km around the airport and intersected none of the 565 constraints.

## Phase 12: Round-trip drone flight simulation (done, 2026-10-18)
- **Buttons:** "Calculate Route" is now **Find Route**. **Start Simulation** is enabled only for a valid, current route.
- **Flight:**
  - The drone flies the displayed route A → B, shows "Destination Reached" and waits 1.5 s.
  - It then flies a return route B → A, calculated separately by the routing engine (same settings, endpoints swapped), and ends with "Round Trip Completed".
  - With no valid return route it stops at B with the reason.
- **Controls:** Pause / Resume / Stop / Restart and 1×, 2×, 5×, 10× playback (1× = 20 simulated seconds per second). An optional "keep the drone in view" setting.
- **Progress:** phase, location (and district), simulated ground speed, travelled and remaining distance, elapsed and remaining time, percentage, and a progress bar.
- **Map:** a rotating SVG quadcopter above all layers, green flown trail, the return route dashed in purple, and A/B markers and red areas kept visible.
- **Safety:** the animation interpolates only along route geometry from the backend. A change to any setting, the points or the dataset stops the simulation.
- **Tests:** `simulation.spec.ts` (11), map and panel specs. Frontend 175 passed; build clean. Backend unchanged.
- **Live check:** two real address pairs (Al. Jerozolimskie 54 → Korotyńskiego 19; Grójecka 17 → Nowy Świat 10).
  - Both completed the round trip, with return routes that differ from the reversed outbound.
  - Sampled drone positions stayed within 0.02 m of the routes, and neither route crossed a red area.
  - The drone ended 0.00 m from A, and Pause held the position.

## Next
- Obtain a permitted official zone export from PAŻP and validate the ED-269 mapping against it (see DATA_SOURCES.md).
- Spec phase 4 remainder: `/routes/compare`.
- Spec phase 5: drone animation, landing station / drop-point selection, "Holding position".
- Spec phase 6: polish and optional Docker.
