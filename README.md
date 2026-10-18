# SkyRoute Warsaw

A "Google Maps for drones" prototype covering the **whole City of Warsaw** (all 18 districts). Enter two addresses anywhere in the city, choose a flight profile and what to optimise, and the backend plans a drone route that:
- avoids blocked UAS geographical zones (Polish DRA categories, evaluated for your flight's altitude and time),
- avoids buildings taller than the flight altitude,
- minimises your chosen objective: **safe corridors** (the Vistula and parks), **shortest** distance, or **fastest** (wind-aware) flight time.

> **Planning and simulation prototype.** It never controls real drones, and avoiding the loaded zones does **not** confirm real-world flight legality. The airspace zones, landing stations and drone profiles shipped here are **synthetic DEMO data**, not official PAŻP zones, and the DEMO zones exist only for central Warsaw. Routes elsewhere are explicitly flagged as **not checked against any zones**. No documented, permitted machine-readable source of official Polish zones was found; see [DATA_SOURCES.md](DATA_SOURCES.md). Check PAŻP DroneTower or DroneMap before any real flight.

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

The data in `data/` is committed, so no network is needed to run the app or the demo scenarios. Address search (Nominatim), LIVE weather (Open-Meteo) and the OSM map tiles need internet access. Without it, use map clicks or manual coordinates, and DEMO weather.

To refresh the data, run from the repo root:
1. `backend/.venv/Scripts/python scripts/fetch_boundaries.py`: the official boundary (seconds).
2. `scripts/fetch_osm.py`: citywide buildings, river and parks via Overpass (about 40 minutes).
3. `scripts/build_demo_data.py`: the DEMO zones and stations.

## Using the planner

The screen has three parts: the **drone list** on the left (a bottom sheet on phones), the **map** in the middle, and **route details** on the right (closed until a drone has a result; a full-height sheet on phones). The **Demo data** badge in the top bar opens the full disclaimer.

1. **Add drone** opens a short form for that drone. Each drone gets its own colour, used for its list entry, its A/B markers and its route line.
2. **Point A / Point B** can be set three ways:
   - type into the field: places you used before, the landing stations and the 18 districts are suggested instantly (all local data); press **Enter** (or choose *Search addresses for …*) to search addresses with OpenStreetMap Nominatim. Address search never runs while you type (Nominatim policy);
   - type coordinates such as `52.2297, 21.0122` and press Enter;
   - press the crosshair button and click the map (a hint above the map says which point is being set; **Esc** cancels).
   Drag a marker on the map to move a point. **Swap A and B** and **Clear points** are under the fields. Points outside the official Warsaw polygon are refused with an inline message.
3. **Flight mode:** *Normal* or *Emergency*. With *Balanced*, emergency routes are more direct. Emergency status grants no airspace permission. **Prohibited and restricted zones are always avoided** (with a safety margin) in both modes; there is no option for it. The form keeps no explanatory texts; this README and the legend explain the choices.
4. **Route optimisation:** *Balanced* (prefers the Vistula and parks, the default), *Fastest* (wind-aware flight time), *Safest* (multi-criteria risk cost: estimated crowds, noise over homes, landing space, schools and hospitals) or *Lowest energy* (wind- and payload-aware battery use). Weights live in the backend (`data/cost_model.json`, `costs.py`).
5. **Altitude** 20–120 m in 5 m steps (slider or number). This is a planning setting, not an authorization to fly. Every drone uses the Standard demo profile (not shown in the UI).
6. **Calculate route** (per drone) or **Calculate all** (in parallel; a failing drone shows its own error and does not affect the others). Any change marks that drone's route **outdated** (grey, dashed) until you recalculate.
7. **Route details:** the outcome in plain language (and what to do if there is no feasible route), distance, estimated time, energy against the usable battery, the zones the route avoids or passes, the cost breakdown, warnings and the safety note. Blocking zones are highlighted on the map. The **Airspace** tab lists the zones as evaluated for the selected drone's altitude.
8. **Per-drone actions** (⋯): route details, show on map, hide/show route, duplicate, delete (with **Undo**). Two routes that cross at a similar altitude get a warning badge and a marker on the map (a hint, not collision avoidance).
9. **Load demo fleet** adds three demo drones (an urgent flight from the depot to the hospital pad, a flight across the Sejm zone, and an enclosed courtyard at 20 m that has no feasible route). It is the only place with predefined points and never replaces your drones.
10. The fleet is remembered in this browser (settings only; routes are recalculated). The URL keeps the selected drone and the open details tab.

### Map layers and legend

- **Layers** (top right) groups the toggles: Airspace (zones, category filters with counts, data extent), Buildings, Boundaries (city, districts, river, parks) and Landing stations. Filters change the map display only; routing always uses every loaded zone.
- **Legend** (bottom right) explains the symbols. Both are collapsed by default and never cover each other or the map controls.

### Airspace zones

Zones are drawn by what they mean **for the selected drone's flight** (its altitude, now), with a colour, a fill pattern, a border style and a glyph, so they stay readable without colour vision:

| Look | Meaning for this flight |
|---|---|
| Red hatching, ticked border, ⊖ | Prohibited: blocked; routes always go around it |
| Amber dots, ticked border, ⚠ | Authorization or conditions required: not verifiable here, so routes go around it |
| Grey cross-hatch, ? | Unverified data: avoided to be safe |
| Blue outline, ⓘ | Information only: routes may cross it |
| Dashed outline, no fill | Not active at this altitude or time |
| Dashed grey rectangle | Extent of the zone dataset: elsewhere zones are unknown and routes say so |

Click a zone for a popover with its name, DRA category, what it means for the selected flight, its altitude band and validity, and further details. Points inside a blocked zone are refused (never moved), and that zone is shown.

## API

All endpoints are under `/api/v1`. JSON fields are camelCase.

| Method & path | Purpose |
|---|---|
| `GET /health` | Status, version, whether the official boundary is loaded |
| `GET /map/warsaw-boundary` | Official city boundary and 18 districts (GeoJSON), bounds and source (503 if missing) |
| `GET /map/coverage` | Routing coverage: geometry, status, source, routing limits, airspace dataset extent |
| `GET /map/buildings/14/{x}/{y}` | Building footprints for one web-mercator tile (gzip), for display |
| `GET /layers` | Citywide corridors, buildings of 50 m or taller, stations and building statistics |
| `GET /zones?altitudeM=&at=` | All loaded airspace zones, each with an `evaluation`, plus `source` and `extent` |
| `GET /zones/{zoneId}` | One zone, evaluated (404 if unknown) |
| `GET /geocoding/search?query=` | Address search across Warsaw. Results include `inCoverage` (official polygon) |
| `GET /drone-profiles` | Sample drone profiles |
| `GET /scenarios` | Routing scenarios: id, name, optimisation goal, mode. **Configuration only, never coordinates.** |
| `GET /weather?mode=DEMO\|LIVE&altitude_m=` | Wind at the flight altitude |
| `POST /routes/calculate` | Plans a route |

```json
POST /api/v1/routes/calculate
{
  "start": { "latitude": 52.16307, "longitude": 20.97081 },
  "destination": { "latitude": 52.16520, "longitude": 21.09020 },
  "mode": "NORMAL",
  "flightAltitudeMeters": 80,
  "droneProfileId": "DEMO_DRONE_01",
  "weatherMode": "DEMO",
  "scenario": "BLOOD_DELIVERY"
}
```

`start` and `destination` are always the user's selected points; nothing on the server replaces them.
- **With `scenario`:** the scenario's configuration sets `mode` and `routeObjective`. An explicitly sent `mode` or `routeObjective` that contradicts the scenario gets a 422 rather than being silently overridden.
- **Without `scenario`:** `mode` and `routeObjective` (`CORRIDORS` default, `SHORTEST`, `FASTEST`, `SAFEST`) are used as sent, so existing clients keep working. The optional `departureTime` (ISO 8601) evaluates zone validity periods and the time-of-day costs at that time.
- `flightAltitudeMeters` is optional (default: `altitude.defaultCruiseM` in `data/cost_model.json`). `payloadKg` is optional (default `energy.defaultPayloadKg`, at most the profile's `maxPayloadKg`, else 422).

The response contains:
- `start` and `destination`, echoed exactly as submitted; `scenario`, `scenarioDisplayName` and `optimizationGoal`.
- `status`, `message`, `geometry` (a GeoJSON LineString, `[lon, lat]`), `distanceM` and `etaS`.
- The echoed settings, and `weather` (including its samples along the route).
- `coverage`: whether both points are inside the official boundary, their districts, and the route length outside the airspace dataset extent.
- `search`: resolution, window size, attempts, A* expansions, time, and whether the result came from the cache.
- `zoneConflicts`, `airspace` (source, timestamp, version) and `planningVerificationStatus`. The last is always "SIMULATION_ONLY…", and adds "PARTIAL AIRSPACE DATA" when part of the route lies outside the zone dataset.
- `costBreakdown`: the multi-criteria cost per term (weight, mean 0..1, cost), energy (Wh) against the usable battery, flight time, population exposure (people/ha × km, an OSM-based estimate), and the departure hour used.
- `warnings` and `dataSources`.

Planning outcomes come back as HTTP 200 with one of these statuses:
- `OK`
- `NO_ROUTE`
- `OUTSIDE_COVERAGE` (outside Warsaw)
- `START_BLOCKED` or `DESTINATION_BLOCKED`
- `BLOCKED_WEATHER`
- `SEARCH_LIMIT`: the search budget ran out, so no route is shown and nothing is proven.
- `COVERAGE_UNAVAILABLE`: the boundary is missing, so routing is disabled.
- `INSUFFICIENT_BATTERY`: the route needs more energy than the battery minus the 20 % reserve.
- `RISK_DATA_UNAVAILABLE`: SAFEST was requested but the OSM risk raster is not loaded (other objectives still work).

A route never comes back as a straight line if it can't be calculated. Invalid requests get HTTP 422.

## How routing works

0. **One shared pipeline:** every scenario goes through `RouteService`, which resolves the scenario configuration, drone profile and wind, then runs the **same** A* engine. There are no per-scenario routing functions and no stored routes.
1. **City grid (precomputed):** the official Warsaw polygon (GUGiK PRG) is projected to EPSG:2180 and covered by a **25 m grid of 1,198 × 1,151 cells**. It holds the maximum building height (189,276 OSM buildings), river and park masks. `scripts/fetch_osm.py` builds it once; the backend loads it in about a second. Cells outside the city polygon are blocked.
2. **Zone evaluation:** for each request, every zone is checked against the flight's time, altitude and category. Only the zones that come out as obstacles (plus a **20 m safety margin**) are blocked. The rules are identical for NORMAL and EMERGENCY, and unknown data is treated conservatively.
3. **Objective costs:**
   - **Safe corridors:** river 1 / parks 2 / open 5 per metre (EMERGENCY: 1 / 1 / 2).
   - **Shortest:** 1 everywhere.
   - **Fastest:** each move's cost is *cruise speed ÷ ground speed* for that direction, using the nearest wind sample.
   - **Safest:** length × (1 + Σ weight × term) for estimated crowds (density², time of day), noise over homes (stronger at night), distance to emergency landing space, schools/hospitals/stadiums and tall structures, plus wind- and payload-aware energy. Weights: `data/cost_model.json`. The cost breakdown is reported for every objective.
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
- **Population density (SAFEST):** an estimate from OSM building floor area (residential vs other land use) and public transport stops, not census data. Land use, schools, hospitals, stadiums and stops © OpenStreetMap contributors (ODbL), fetched once via Overpass (`scripts/fetch_risk_layers.py`).
- **Airspace zones, landing stations and drone profiles:** synthetic DEMO data; see **[DATA_SOURCES.md](DATA_SOURCES.md)** for the official-data situation and how to load an official zone file.
- **Map tiles:** © OpenStreetMap contributors.

## Tests

```bash
cd backend  && .venv/Scripts/python -m pytest          # 318 tests, external APIs mocked
cd frontend && npx ng test --watch=false                # 79 tests (Vitest)
# Browser checks (Playwright in the backend venv, uses your installed Chrome; servers must be running):
backend/.venv/bin/python frontend/e2e/ui_check.py --out /tmp/shots   # no overlay overlaps, 1280x720 + 390x844
backend/.venv/bin/python frontend/e2e/flows.py --out /tmp/shots      # acceptance flows (20 checks)
```

## Limitations

- **Airspace data is synthetic and only covers central Warsaw.** The DEMO zones sit inside the dashed extent; everywhere else zones are unknown. Routes there are flagged "not checked", and none are drawn around airports or other sites. No official Polish zone API or file was available (see DATA_SOURCES.md).
- **Zone evaluation is simplified:** no authorizations or technical capabilities are modelled, daily schedules and AUP/UUP activations are not evaluated, and AMSL limits use a fixed terrain range.
- **Corridor search:** the result is optimal within the searched window. A detour that leaves the window is only found if the first window fails.
- **Coarse resolution on long routes:** cross-city windows are searched at 50–75 m. This is conservative, so narrow gaps can be closed and a route may come out longer or (rarely) as `NO_ROUTE`, where the result states the resolution.
- **Grid detail (25 m):** a building blocks a cell only if it covers the cell centre, so narrow gaps and footprint edges are approximate. Zones are rasterised conservatively and checked exactly.
- **Building heights:** OSM heights include spires and masts. 12,897 of 189,276 buildings use the estimated 15 m.
- **Weather:** samples follow the straight A–B line (nearest sample per segment), with no gust modelling, and the ETA ignores take-off, landing, climb and descent. *Fastest* equals *Shortest* in open air under uniform wind.
- **Geocoding:** public Nominatim allows 1 request/s for the whole server, and the cache is in memory.
- **SAFEST costs are DEMO values:** the density proxy ignores time-of-use per building type, the energy model holds a constant airspeed (no climb, hover or temperature), and the battery check applies to the chosen route, not the lowest-energy one.
- **Routing engine:** a hand-written A* on a NumPy grid, as the project spec requires (no NetworkX at runtime).
- **Scenarios differ only by optimisation goal and cost profile.** Blood, AED and Emergency share the same goal and give the same route. There is no AED-location dataset in the repository (none was added).
- **Multiple drones are planned independently.** Crossing routes at a similar altitude are only flagged; there is no deconfliction.
- **Not built yet:** drone animation (routes already keep timestamped points, spread over the total ETA), and choosing a landing station or drop point as the route end.
