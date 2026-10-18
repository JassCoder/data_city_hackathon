# SkyRoute Warsaw

A "Google Maps for drones" prototype covering the **whole City of Warsaw** (all 18 districts). Enter two addresses anywhere in the city, choose a flight profile and what to optimise, and the backend plans a drone route that:
- avoids blocked UAS geographical zones (Polish DRA categories, evaluated for your flight's altitude and time),
- avoids buildings taller than the flight altitude,
- minimises your chosen objective: **safe corridors** (the Vistula and parks), **shortest** distance, or **fastest** (wind-aware) flight time.

> **Planning and simulation prototype.** It never controls real drones. **No airspace zones are loaded by default**, so routes are explicitly unverified and do not confirm real-world flight legality. The bundled landing stations and drone profiles are synthetic sample data, not real facilities or manufacturer data. No documented, permitted machine-readable source of official Polish zones was found; see [DATA_SOURCES.md](DATA_SOURCES.md). Check PAŻP DroneTower or DroneMap before any real flight.

## Quick start

Requirements: Python 3.12+, Node 20+ (tested with Node 24).

```bash
# Backend: http://localhost:8000 (API docs at /docs)
cd backend
python -m venv .venv
.venv/Scripts/pip install -r requirements.txt      # macOS/Linux: .venv/bin/pip
.venv/Scripts/python -m uvicorn app.main:app --reload --port 8000

# Frontend: http://localhost:4200
cd frontend
npm install
npx ng serve --port 4200
```

The map, buildings, boundaries and routing raster are committed, so the planner runs offline. Address search (Nominatim), LIVE weather (Open-Meteo) and OSM map tiles need internet access. Without it, use map clicks or manual coordinates, and SAMPLE weather. Airspace defaults to no dataset; the app labels resulting routes unverified.

To refresh the data, run from the repo root:
1. `backend/.venv/Scripts/python scripts/fetch_boundaries.py`: the official boundary (seconds).
2. `scripts/fetch_osm.py`: citywide buildings, river and parks via Overpass (about 40 minutes).
3. Airspace is not bundled or loaded by default. Official zones can be loaded only from a permitted file using `SKYROUTE_AIRSPACE_PROVIDER=ed269|geojson` and `SKYROUTE_AIRSPACE_FILE`. `scripts/build_sample_data.py` can generate synthetic sample zones for local testing; explicitly configure that file to load it.

## Using the planner

**Layout:** the plan-route panel on the left and a large Warsaw map. Floating controls open on demand, so nothing covers the map permanently:
- **Layers** (top right):
  - A checkbox per map layer: Airspace zones, All buildings (zoom ≥ 15), Hospitals, Drone depots, Subscribed restaurants, All restaurants, Proposed pickup pads, Drones at facilities, Delivery routes, Warsaw boundary, 18 districts, River, Parks / green, Buildings ≥ 50 m, Sample landing stations.
  - Under *Airspace zones*, the DRA categories with counts computed from the loaded dataset. When official data is missing, a warning says that zero loaded features is not proof that there are no restrictions.
  - Visibility is display only; routes always avoid every applicable blocked zone. Choices are kept for the browser session.
  - Default layers: airspace zones, hospitals, depots, delivery routes, Warsaw boundary, river and parks.
- **Route Details** (directly below Layers):
  - The calculated route's overview: Point A/B, status, distance, flight time, altitude, mode, optimisation and the calculation time (Warsaw).
  - Weather (wind, gusts, source, forecast time), the drone, and safety warnings.
  - It opens by itself when a new route is ready.
- **Airspace Legend** (bottom):
  - The evaluated zone colours (the same styles as the map), the flight altitude, the evaluation time, the data provider, freshness and verification status.
  - Expandable sections: the zone list, coverage diagnostics and other map symbols.

**Plan route:**
1. **A — Point A: Starting address / B — Point B: Destination address:** type a street and building number (*Marszałkowska 104/122*, *Międzynarodowa 32/34A*, *Al. Jerozolimskie 54*), a place (*Warszawa Centralna*) or `lat, lon`, then press **Search** and choose a result.
   - **Accuracy:** each result shows its accuracy level.
     - **Building/address matched:** official GUGiK PRG address points, exact building number on the requested street, or OpenStreetMap.
     - **Street-level** or **place-level approximation.**
     - **Coordinates as entered.**
     If the building number isn't found, the list says so instead of silently using the street centre.
   - **Flats:** a flat number (`m. 15`, `lok. 3`, `100/5`) is kept with the address, but the point stays the building; apartments are never geolocated.
   - **Entrances:** for a building match, the building's **mapped OSM entrances** are offered (list and map pins). The staircase whose `addr:flats` covers your flat is marked. Choosing one moves the point there; this is for delivery planning only, not a landing approval.
   - You can also use **Select Point A/B on map**, or **Coordinates**. Points outside the official city polygon are refused.
2. **Flight Altitude:** 20–120 m in 5 m steps (default 80 m). Changing it marks the current route outdated.
3. **Flight Mode:** Normal or Emergency. Emergency prefers more direct permitted paths and never enters a blocked zone.
4. **Route Optimisation:**
   - **Fastest** (default): wind-aware flight time.
   - **Shortest:** distance.
   - **Balanced:** prefers the river and parks.
   The choice is sent to the backend as `optimization` and changes the cost model; hard restrictions are identical for all three.
5. **Drone Profile: Standard Drone:** read-only (`DEMO_DRONE_01`). Its speed and example range are shown.
6. **Weather:**
   - **LIVE** (default): Open-Meteo through the backend, at your altitude and along the route, with the forecast time.
   - **If LIVE fails:** the last live values are shown as **CACHED** (up to 3 h old); otherwise the status says live weather is unavailable and the route uses sample wind labelled *NOT live data*. Both cases are added to the route's verification status. LIVE is never silently relabelled.
   - **SAMPLE** can be chosen explicitly.
7. **Calculate Route / Clear Route** (and **Reset**). The backend picks the calculation time: now, in Europe/Warsaw. That one timestamp is used for zone validity and the weather forecast hour, and it is shown in Route Details.

Removed from the planner:
- **Scenario cards:** restricted-zone avoidance is always on. The `scenario` API field still works for compatibility.
- **The departure picker.**
- **The drone profile dropdown.**
- **The sample-route buttons.**

## API

All endpoints are under `/api/v1`. JSON fields are camelCase.

| Method & path | Purpose |
|---|---|
| `GET /health` | Status, version, whether the official boundary is loaded |
| `GET /map/warsaw-boundary` | Official city boundary and 18 districts (GeoJSON), bounds and source (503 if missing) |
| `GET /map/coverage` | Routing coverage: geometry, status, source, routing limits, airspace dataset extent |
| `GET /map/buildings/14/{x}/{y}` | Building footprints for one web-mercator tile (gzip), for display |
| `GET /layers` | Citywide corridors, buildings of 50 m or taller, stations and building statistics |
| `GET /zones?altitudeM=&at=&bbox=&format=` | Loaded airspace zones, each with an `evaluation`, plus `source`, `completeness` and `totalZones`. Default: the whole loaded dataset; with no provider configured, returns zero zones and explicitly reports unavailable airspace data. |
| `GET /zones/diagnostics?altitudeM=&at=` | Coverage diagnostics: totals per DRA group, blocked/conditional/obstacle counts, completeness, per-district coverage and zone counts, zones outside the city, duplicates removed, last reload error, warnings |
| `GET /zones/{zoneId}` | One zone, evaluated (404 if unknown) |
| `GET /geocoding/search?query=` | Address search across Warsaw: GUGiK PRG address points (exact building numbers) plus Nominatim. Each result has `accuracy` (ADDRESS / STREET / PLACE / COORDINATES), `inCoverage`, and `flat`/`flatResolved` when a flat was entered. The response adds `parsed` and a `note`. |
| `GET /geocoding/entrances?latitude=&longitude=&flat=` | Mapped OSM entrances of the building at a point; `matchesFlat` only from `addr:flats` |
| `GET /drone-profiles` | Sample drone profiles |
| `GET /scenarios` | Routing scenarios: id, name, optimisation goal, mode. **Configuration only, never coordinates.** |
| `GET /weather?mode=\|LIVE&altitude_m=` | Wind at the flight altitude |
| `POST /routes/calculate` | Plans a route. Simplified body: `{start, destination, mode, optimization: FASTEST\|SHORTEST\|BALANCED, flightAltitudeMeters, droneProfileId (default DEMO_DRONE_01), weatherMode}`. `routeObjective` and `scenario` are still accepted, and contradictions return 422. The response adds `optimization` and `calculatedAt` (Europe/Warsaw). |

```json
POST /api/v1/routes/calculate
{
  "start": { "latitude": 52.16307, "longitude": 20.97081 },
  "destination": { "latitude": 52.16520, "longitude": 21.09020 },
  "mode": "NORMAL",
  "flightAltitudeMeters": 80,
  "droneProfileId": "_DRONE_01",
  "weatherMode": "SAMPLE",
  "scenario": "BLOOD_DELIVERY"
}
```

`start` and `destination` are always the user's selected points; nothing on the server replaces them.
- **With `scenario`:** the scenario's configuration sets `mode` and `routeObjective`. An explicitly sent `mode` or `routeObjective` that contradicts the scenario gets a 422 rather than being silently overridden.
- **Without `scenario`:** `mode` and `routeObjective` (`CORRIDORS` default, `SHORTEST`, `FASTEST`) are used as sent, so existing clients keep working. The optional `departureTime` (ISO 8601) evaluates zone validity periods at that time.

The response contains:
- `start` and `destination`, echoed exactly as submitted; `scenario`, `scenarioDisplayName` and `optimizationGoal`.
- `status`, `message`, `geometry` (a GeoJSON LineString, `[lon, lat]`), `distanceM` and `etaS`.
- The echoed settings, and `weather` (including its samples along the route).
- `coverage`: whether both points are inside the official boundary, their districts, and the route length not checked against loaded airspace data (the full route when no dataset is loaded).
- `search`: resolution, window size, attempts, A* expansions, time, and whether the result came from the cache.
- `zoneConflicts`, `airspace` (source, timestamp, version) and `planningVerificationStatus`. The last is always "SIMULATION_ONLY…", and adds "PARTIAL AIRSPACE DATA" when part of the route lies outside the zone dataset.
- `warnings` and `dataSources`.

Planning outcomes come back as HTTP 200 with one of these statuses:
- `OK`
- `NO_ROUTE`
- `OUTSIDE_COVERAGE` (outside Warsaw)
- `START_BLOCKED` or `DESTINATION_BLOCKED`
- `BLOCKED_WEATHER`
- `SEARCH_LIMIT`: the search budget ran out, so no route is shown and nothing is proven.
- `COVERAGE_UNAVAILABLE`: the boundary is missing, so routing is disabled.

A route never comes back as a straight line if it can't be calculated. Invalid requests get HTTP 422.

## How routing works

0. **One shared pipeline:** every scenario goes through `RouteService`, which resolves the scenario configuration, drone profile and wind, then runs the **same** A* engine. There are no per-scenario routing functions and no stored routes.
1. **City grid (precomputed):** the official Warsaw polygon (GUGiK PRG) is projected to EPSG:2180 and covered by a **25 m grid of 1,198 × 1,151 cells**. It holds the maximum building height (189,276 OSM buildings), river and park masks. `scripts/fetch_osm.py` builds it once; the backend loads it in about a second. Cells outside the city polygon are blocked.
2. **Zone evaluation:** for each request, every zone is checked against the flight's time, altitude and category. Only the zones that come out as obstacles (plus a **20 m safety margin**) are blocked. The rules are identical for NORMAL and EMERGENCY, and unknown data is treated conservatively.
3. **Objective costs:**
   - **Safe corridors:** river 1 / parks 2 / open 5 per metre (EMERGENCY: 1 / 1 / 2).
   - **Shortest:** 1 everywhere.
   - **Fastest:** each move's cost is *cruise speed ÷ ground speed* for that direction, using the nearest wind sample.
   - **Always blocked:** obstacle zones, the city edge, and buildings at or above *altitude − the profile's vertical clearance*.
4. **Corridor search:** A* runs only on a window around A–B, with a margin of at least 1.5 km and 35% of the distance.
   - If no path exists inside the window, the window is widened (×2.5) up to the whole city.
   - Windows larger than 300,000 cells are coarsened conservatively: a coarse cell is blocked if *any* 25 m cell inside it is blocked.
   - Limits: 1.2 M A* expansions per attempt and a 20 s total. Running out gives `SEARCH_LIMIT`, never a guessed route.
   - Results are cached per request and dataset version.
5. **A\*:** 8 directions, no squeezing diagonally between blocked cells, with an octile heuristic that keeps results optimal for the searched window.
6. **Smoothing and safety checks:** line-of-sight shortcuts that keep the objective's cost. Every final segment is checked against the exact zone polygons **and** the 25 m building raster.
7. **ETA:** calculated per segment with crosswind correction and head/tailwind from the nearest wind sample. Wind over the profile's limit anywhere along the route gives `BLOCKED_WEATHER`.

Typical times on a laptop, measured end to end on real data:

| Route | Distance | Time |
|---|---|---|
| Śródmieście → Mokotów | about 3.5–4 km | 15–70 ms |
| Ursynów → Białołęka | about 20–27 km | 90–210 ms (searched at 50 m) |

## Data sources and attribution

- **City boundary and districts:** GUGiK – Państwowy Rejestr Granic (PRG), OGC API Features. The city is selected by TERYT `1465` and the districts by `1465NN_8`.
- **Buildings, river and parks:** © OpenStreetMap contributors (ODbL), a citywide snapshot fetched via Overpass. Building height comes from `height`, else `building:levels × 3 m`, else an estimated 15 m.
- **Geocoding:** © OpenStreetMap contributors via [Nominatim](https://nominatim.org/). It runs backend-only, at most 1 request/s, cached, on explicit search only, following the [usage policy](https://operations.osmfoundation.org/policies/nominatim/).
- **Weather:** [Open-Meteo](https://open-meteo.com/) (LIVE mode).
- **Airspace zones:** no dataset is loaded by default; official snapshots require a permitted file. Landing stations and drone profiles are synthetic sample data. See **[DATA_SOURCES.md](DATA_SOURCES.md)**.
- **Map tiles:** © OpenStreetMap contributors.

## Delivery simulation (fleet)

**Real locations, simulated infrastructure.** Hospitals (45) and restaurants (1,972) are real OpenStreetMap locations, imported once with `scripts/fetch_pois.py`. Everything else is simulated, stored in SQLite (`data/fleet/fleet.sqlite`, created and seeded on first start):
- drone stations, depots and pickup pads;
- drones and orders;
- subscriptions.

No hospital or restaurant has agreed to host drones, and nothing is approved for real flight.

- **Map layers** (layer control):
  - hospitals (clustered, medical cross; enabled stations have a green ring);
  - drone depots (blue; high-demand ones larger);
  - subscribed restaurants (orange; DEMO partners);
  - all restaurants (loaded only when switched on, clustered);
  - proposed pickup pads (purple);
  - drone badges (green = available / grey = none free);
  - delivery routes (teal; dashed = to pickup / return).
- **Popups:** *Set as Point A/B*. A restaurant with an enabled pad also offers *Order food delivery*, which sets Point A to the pad. An enabled hospital station also offers *Deliver to this station*, which sets Point B and lands there. These explicit actions are the only way a facility becomes Point A/B; scenarios never move the points.
- **Fleet dashboard** (toolbar):
  - **Overview:** counts, capacity utilisation and a district filter.
  - **New delivery order:** uses the planner's Point A and Point B. *Create order & assign drone* ranks drones by routed time, checks range, battery and landing capacity, and reserves atomically.
  - **Orders:** *Advance simulation* steps through TO_PICKUP → LOADING → IN_DELIVERY → DELIVERED → RETURNING → COMPLETED and updates parking occupancy. Charging drones can be marked ready.
  - **Demand & capacity planning:** simulated BASELINE / CENTRAL_PEAK demand with recommendations. Recommendations never change installed capacity.
  - **Admin (development):** depot capacity and enabling depots and stations, using the development token.
- **Capacity rule:** available = capacity − occupied − reserved. It is never negative, and `occupied + reserved ≤ capacity` is enforced by the database.
- **Defaults:**
  - hospital station 2 (`SKYROUTE_HOSPITAL_STATION_CAPACITY`);
  - standard depot 6, high-demand depot 12;
  - pad 1 (1–2 allowed).
- **Reset the simulation:** stop the backend and delete `data/fleet/fleet.sqlite`; it is re-seeded on the next start.
- **Admin mutations:** they need the header `X-Admin-Token`.
  - **In development:** the default is `dev-admin-token`; override it with `SKYROUTE_ADMIN_TOKEN`.
  - **In production** (`SKYROUTE_ENV=production`): they are refused unless a token is configured.

| Endpoint | Purpose |
|---|---|
| `GET /hospitals`, `/hospitals/{id}` | OSM hospitals plus their simulated station (`bbox`, `district`, `offset`, `limit`) |
| `GET/POST /depots`, `PATCH /depots/{id}`, `PATCH /stations/{id}` | Depots and hospital stations (mutations: admin) |
| `GET /restaurants`, `/restaurants/{id}`, `PATCH /restaurants/{id}/subscription` | Paginated or bbox restaurants; subscription (admin). ACTIVE creates a pad that needs review. |
| `GET/POST /landing-pads`, `PATCH /landing-pads/{id}`, `POST /landing-pads/check` | Proposed pads. `check` reports distance, blocked zones, building data and what map data cannot verify. |
| `GET /drones`, `/drones/{id}`, `POST /drones/{id}/finish-charging` | Simulated drones |
| `GET /fleet/summary`, `/fleet/availability`, `/fleet/demand?scenario=` | Dashboard figures and simulated capacity recommendations |
| `POST /orders`, `GET /orders`, `/orders/{id}`, `POST /orders/{id}/assign-drone`, `/advance`, `/cancel` | Order workflow |

## Tests

```bash
cd backend  && .venv/Scripts/python -m pytest          # 315 tests, external APIs mocked
cd frontend && npx ng test --watch=false                # 158 tests (Vitest)
```

## Limitations

- **Airspace zones:** no zone dataset is bundled or loaded by default. Without an explicitly configured file, every route is marked unverified and the entire route is reported as unchecked. No permitted official Polish UAS-zone API or file is available (re-checked 2026-10-18, see DATA_SOURCES.md). A permitted official file can be loaded via `SKYROUTE_AIRSPACE_PROVIDER=ed269|geojson`.
- **Zone evaluation is simplified:** no authorizations or technical capabilities are modelled, daily schedules and AUP/UUP activations are not evaluated, and AMSL limits use a fixed terrain range.
- **Corridor search:** the result is optimal within the searched window. A detour that leaves the window is only found if the first window fails.
- **Coarse resolution on long routes:** cross-city windows are searched at 50–75 m. This is conservative, so narrow gaps can be closed and a route may come out longer or (rarely) as `NO_ROUTE`, where the result states the resolution.
- **Grid detail (25 m):** a building blocks a cell only if it covers the cell centre, so narrow gaps and footprint edges are approximate. Zones are rasterised conservatively and checked exactly.
- **Building heights:** OSM heights include spires and masts. 12,897 of 189,276 buildings use the estimated 15 m.
- **Weather:** samples follow the straight A–B line (nearest sample per segment), with no gust modelling, and the ETA ignores take-off, landing, climb and descent. *Fastest* equals *Shortest* in open air under uniform wind.
- **Geocoding:** public Nominatim allows 1 request/s for the whole server, and the cache is in memory.
- **Routing engine:** a hand-written A* on a NumPy grid, as the project spec requires (no NetworkX at runtime).
- **Scenarios differ only by optimisation goal and cost profile.** Blood, AED and Emergency share the same goal and give the same route. There is no AED-location dataset in the repository (none was added).
- **Not built yet:** drone animation, normal-vs-emergency comparison, and choosing a landing station or drop point as the route end.
