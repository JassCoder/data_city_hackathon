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
- **Airspace:** datasets can declare an `extent`; the DEMO extent is central Warsaw. The length of route outside it is reported (`coverage.airspaceOutsideExtentM`, a warning, and "PARTIAL AIRSPACE DATA" in the verification status).
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
- **Demo:** the no-route scenario moved to an enclosed courtyard in Praga-Północ (the old one is not enclosed in the fresh OSM snapshot).

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
- **The one behaviour that replaced Point A/B:** the frontend "Load Demo Scenario" buttons (`loadDemoScenario`: "Blood delivery", "Avoid a prohibited zone", "No route available"). They set fixed coordinates or stations, plus altitude, drone profile and mode. The "Blood delivery" label made it look like a routing mode.
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
- **Demo fixtures:** the demo buttons became `DEMO_FIXTURES` ("Depot → hospital pad", "Across the Sejm zone", "Enclosed courtyard"), behind a collapsed **"Load demo fixture (replaces Point A and B)"** toggle. They set points (and 20 m for the courtyard) only, never the scenario, mode, profile or weather, and are never called by scenario selection.
- **Results:** the route results show the scenario name.

**Hard-coded coordinate audit** (app code, after the change)

| Location | Classification |
|---|---|
| `backend/app/config.py` `MAP_CENTER` | Map / weather configuration: default map centre and the point for DEMO wind / `GET /weather`. Never a route endpoint. |
| `backend/app/config.py` `DEMO_BBOX` | Dataset metadata: the extent of the synthetic DEMO airspace dataset. |
| `config.py` / `core/map-data.ts` `FALLBACK_VIEW` | Map view shown only if the boundary is missing. Not a route. |
| `planner/location-input.ts` help text "e.g. 52.2297 and 21.0122" | UI hint text. |
| `core/planner.store.ts` `DEMO_FIXTURES` | **Explicit demonstration fixture**, only via "Load demo fixture". |
| `scripts/build_demo_data.py`, `data/airspace/demo_zones.geojson`, `data/landing_stations.geojson` | Synthetic demo dataset (zones, stations). |
| `data/boundaries/*`, `data/osm/*`, `data/corridors.geojson`, `data/tall_buildings.geojson` | Real geographic datasets (GUGiK PRG, OSM). |
| `*.spec.ts`, `backend/tests/*` | Test fixtures. |
| Unwanted hard-coded routing behaviour | **None remaining.** The old `loadDemoScenario` (scenario-like labels that replaced A/B, profile, mode and altitude) was refactored into explicit fixtures. |

**Verified**
- **pytest: 205 passed.** New `test_scenarios.py` (41 tests), each across all 5 scenarios where relevant:
  - Submitted coordinates are echoed, and the route starts and ends exactly there; changing the scenario never changes the endpoints.
  - Changing Point A or B changes the route.
  - The DEMO-P-SEJM direct line is avoided, with `DIRECT_LINE_BLOCKED` reported; a synthetic full wall gives NO_ROUTE.
  - A meaningful NO_ROUTE for the enclosed courtyard; missing start, destination or both → 422.
  - Objective mapping; Blood, AED and Emergency giving an identical route; the suggested profile not applied; conflicting settings → 422; unknown scenario → 422; legacy requests without a scenario; `/scenarios` containing no coordinates.
- **`ng test`: 102 passed; `ng build` clean.** Covered:
  - Selecting each scenario keeps the same A and B objects and sends their exact coordinates plus the scenario.
  - Altitude, profile and weather are kept; no predefined coordinates are loaded when a point is missing.
  - A scenario change cancels the outdated request; manual changes → custom.
  - The panel highlights the active scenario; address text and selection are unchanged; map markers keep their lat/lng across scenario routes.
  - Demo fixtures sit behind an explicit toggle.
- **Acceptance test in Edge (Playwright), live servers, real Nominatim — 66/66 checks:**
  - **Trip 1** (Warszawa Centralna → Stadion Narodowy, sent as 52.2288207, 21.00316 → 52.2397726, 21.0454432):
    - NORMAL 3.41 km; Blood / AED / Emergency 3.16 km (identical); Avoid Prohibited Zone 3.22 km (shortest path, PKiN zone listed as avoided).
  - **Trip 2** (Łazienki Królewskie → Dworzec Gdański):
    - NORMAL 7.26 km; Blood / AED / Emergency 6.01 km; Avoid 5.78 km.
  - For every scenario in both trips: the backend received **the same coordinates as NORMAL** and echoed them; the route starts and ends at those exact points; addresses and marker positions were unchanged; the button was highlighted; no fixture coordinates were sent.
  - With no points selected, the scenario shows the message and sends nothing.
  - An independent Shapely check: no trip-1 route touches any obstacle zone. No page errors.

## Phase 7: Multi-criteria SAFEST objective (done, 2026-10-18)

**Built: backend** (`app/routing/risk/`, UI-free, depends only on its provider protocols)
- `data/cost_model.json` holds every weight and parameter (pydantic, unknown keys rejected, weights ≥ 0). JSON instead of YAML so no dependency was added. Startup fails if `defaultCruiseM` > `legalCeilingM` (120 m) or the API accepts altitudes above the ceiling. The altitude stays per request; omitted = `defaultCruiseM`.
- Providers: `PopulationDensityProvider`, `LandUseProvider`, `ObstacleProvider`, `WindProvider` (rasters on the routing grid). Synthetic providers for tests; OSM providers from the new `data/osm/risk_warsaw_25m.npz` (`scripts/fetch_risk_layers.py`: Overpass land use, schools/hospitals/stadiums, transit stops + floor area from the building tiles).
- Cell terms (each 0..1): population `(density × hourly multiplier / 800 per ha)²`, obstacle proximity, noise (residential × day/night), distance to emergency landing space, sensitive sites. Direction terms: energy (P / ground speed, wind triangle, payload) and time, normalised by the worst case the hard limits allow.
- Edge cost = length × (1 + Σ wᵢ·termᵢ) + length × (energy and time terms). A* heuristic = octile × (1 + min direction cost): admissible, checked against Dijkstra on random grids.
- Every route gets a `costBreakdown`; route energy above battery × (1 − 20 % reserve) → `INSUFFICIENT_BATTERY` for all objectives (user decision). Optional `payloadKg`. Missing risk raster → the app still starts and SAFEST answers `RISK_DATA_UNAVAILABLE`.
- Drone profiles gained DEMO energy fields (cruise power, payload power, battery).

**Built: frontend:** "Safest" route optimisation, cost breakdown panel (open for SAFEST), new status labels.

**Crowd-weight sweep** (`scripts/sweep_crowd_weight.py`, depot → hospital pad, Delivery Drone, 80 m, DEMO wind, 12:00 local):

| Crowd weight | Length | Energy | Population exposure (people/ha·km) |
|---|---|---|---|
| 0 | 3,299 m | 38.5 Wh | 1,816 |
| 0.5 | 3,360 m | 39.1 Wh | 1,317 |
| 1 | 3,410 m | 39.6 Wh | 1,047 |
| 2 | 3,465 m | 40.1 Wh | 448 |
| 5 | 3,565 m | 41.0 Wh | 274 |

At weight 5 the route takes 85 % less crowd exposure for 8 % more distance and 6.5 % more energy. The sweep exposed a route-cache bug (the key ignored the cost model), now fixed with a regression test.

**Verified:** pytest **311 passed** (new: config, providers, terms/energy, search incl. Dijkstra comparison and determinism, OSM provider, planner integration, API). `ng test` 104 passed; `ng build` clean. Density is a proxy from OSM floor area and stops, not census data; the UI and API say so.

## Phase 8: UI/UX redesign, multiple drones (done, 2026-10-18, branch `ui-redesign`)

**Decisions** (approved): local instant suggestions + Nominatim only on Enter (policy); Balanced/Fastest/Safest/Lowest energy → CORRIDORS/FASTEST/SAFEST/new LOWEST_ENERGY (`objectivePresets.lowestEnergy`); Blood/AED scenarios may fly in EMERGENCY (`allowedModes`); Angular Material removed in favour of tokens + small native components; Playwright (Python, system Chrome) for browser checks. B612 was dropped after a glyph test showed no Polish diacritics (system font stack instead).

**Built**
- Backend: `LOWEST_ENERGY` objective (energy-only preset; works without the risk raster); `ScenarioConfig.extra_modes` / `allowedModes` in `/scenarios`. pytest 318 passed.
- Frontend:
  - Shell: slim top bar with one "Demo data" badge (popover with the full disclaimer and the PANSA DroneMap/DroneTower pointer) and backend status; drone sidebar (bottom sheet < 768 px); map; details drawer (full-height sheet on mobile).
  - Map overlays: one Layers panel and one Legend, adopted as Leaflet corner controls so they cannot overlap; pick hint and boundary warning as strips above the map.
  - Airspace visual language: colour + pattern + border + glyph per meaning for the selected flight; popovers lead with "For <drone> at <altitude>: …".
  - Fleet: add/edit/duplicate/hide/focus/delete (undo) drones with their own colours; point fields with local suggestions, typed coordinates, map pick (Esc), drag; flight mode + missions; optimisation locked by a mission; Calculate per drone and Calculate all (parallel, failures isolated); crossing warning at similar altitude; fleet remembered per browser; URL keeps drone and tab.
  - Details: plain-language outcome + next step, distance/time/energy, zones avoided/crossed (deduplicated), cost breakdown, safety note; Airspace tab grouped by meaning.
  - Initial bundle 200.9 kB → 128.7 kB gzipped; dark scheme and reduced motion supported.

**Verified**
- `ng test`: 79 passed (fleet logic and store, suggestions, routing options, editor, details, map, app); `ng build` clean.
- `e2e/ui_check.py`: 0 overlaps at 1280×720 and 390×844, default and with panels open.
- `e2e/flows.py`: 20/20 acceptance checks (three coloured routes at once; A/B by suggestion, typed coordinates, map pick with Esc, marker drag; zone popup for the selected flight; one forced server error stays on its drone; mobile sheets). The flows found and fixed one bug: the automatic fit was undone when the drawer opened (animated zoom + `invalidateSize` pan), hiding Point A behind the sidebar.

**Follow-up (user request, 2026-10-18):** flight mode reduced to Normal / Emergency with no mission sub-options; zone avoidance shown as a fixed rule (every request already avoids prohibited and restricted zones); one drone profile (Standard) for every drone, with profile and payload removed from the UI. Requests now always send `mode` + `routeObjective` without a scenario; saved fleets are migrated. `ng test` 78 passed, `flows.py` 20/20, `ui_check.py` 0 overlaps.

## Phase 9: Headless drone simulation engine (done, 2026-10-18, branch `simulation`)

**Decisions** (approved): new DEMO profile fields and the battery reserve moved into the profile; the planner's battery check includes take-off and landing; safe emergency landings end IDLE (grounded), FAILED only without a safe site / empty battery; cruise speed in both modes; JSON scenarios; scenario drones may name a profile (default Standard).

**Built** (`backend/app/sim/`): config and scenario models with validation; explicit state machine; drone object; append-only event log; movement along planner legs with the shared energy model (climb/descent/hover added to `energy.py`); engine with fixed ticks, seeded RNG, mission lifecycle, pre-flight energy check, station capacity; per-tick reserve monitoring and emergency landings (station → open space → in place); temporary zones with re-plan / hold / divert; `scripts/run_simulation.py`; example scenarios `demo_city.json` and `ten_drones_hour.json`.

**Verified:** pytest 391 passed (new: config/scenarios 25, state machine/log 14, kinematics/energy 8, engine 13, safety 10, performance 3). Simulated cruise energy is within 1 % of the planner's and flight time within 1 s. Headwind costs more energy than tailwind over the same route. A low battery leads to an emergency landing, and the battery never goes below 0. Same seed → identical logs (synthetic and real data). **10 drones × 1 simulated hour: 1.9 s** engine time on the development laptop (+0.6 s loading the world), 82 route plans, 19 of 20 missions delivered (one correctly rejected by the pre-flight check).

## Phase 10: Simulation view in the UI (done, 2026-10-18, branch `sim-ui`)

**Decisions** (approved): client-paced REST stepping (no WebSocket); engine additions (runtime injection recorded for replay, airborne-only `drone_failure`, zone duration, history ring buffer, per-mission energy and breakdowns, leg ids/geometry, `zoneId`s on reactions); lazy `/simulate` route; REPLAY is read-only; "Simulate my planned drones"; reuse the installed Playwright; branch `sim-ui`; PR description written to a file, pushing only after asking.

**Built:** session API (`app/sim/session.py`, `routers/simulations.py`) on one simulation world with its own planner (simulated zones never reach `/routes/calculate`); Angular routing (planner page + lazy simulation page); playback bar, telemetry list, event feed with jump-to, drone details drawer, zone drawing, wind, failure; map layer with per-frame markers, state visuals, split routes, trails, zones and station rings; `data/sim_scenarios/twenty_drones.json`.

**Verified:** pytest 419 passed (new: `test_sim_api.py` 25, engine injection/failure/legs 3). Vitest 147 passed (new sim specs: interpolation, buffer, timeline, commands, event feed, geometry, fleet scenario, session service, layer, panels, zone draft). `frontend/e2e/sim_flows.py` 32/32, planner `flows.py` 20/20 and `ui_check.py` 0 overlaps after the routing refactor. **Frame rate: 20 drones at 60x, 60 fps average, 95th-percentile frame 16.7 ms, no frames > 50 ms, no long tasks; also 60 fps with Chrome CPU throttling at 4x and 59.6 fps at 6x** (headless Chrome on the development Mac, street zoom with all tags visible). Initial bundle 152 kB gzipped (+24 kB for the router); the simulation view is a 25 kB lazy chunk.

## Next
- Obtain a permitted official zone export from PAŻP and validate the ED-269 mapping against it (see DATA_SOURCES.md).
- Spec phase 4 remainder: `/routes/compare`.
- Spec phase 5: landing station / drop-point selection in the planner.
- Simulation: branching from the past (runs are deterministic, so a session could be rewound and changed), WebSocket push if many viewers share a session.
- Spec phase 6: polish and optional Docker.
