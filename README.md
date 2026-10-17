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

1. **The map** opens showing the whole of Warsaw: the official city boundary, the 18 districts with their names, and the zones. **Show Entire Warsaw** (top left) fits the city again. From zoom 15, every building footprint is loaded from tiles; zoomed out, only buildings of 50 m or taller are drawn.
2. **Point A / Point B:** type an address anywhere in Warsaw (for example *Lotnisko Chopina* or *Pałac w Wilanowie*) and press **Search**, then choose the right place from the list. You can also click **Pick on map**, or enter coordinates under **Coordinates**. A plain map click fills A first, then B.
   - Every point is checked against the **official city polygon** (point-in-polygon, not a box). Places outside Warsaw are refused with an explanation, and outside search results can't be selected.
3. **Routing scenario:** **Normal Flight**, **Blood Delivery**, **AED / First Aid Delivery**, **Avoid Prohibited Zone** or **Emergency Flight**.
   - A scenario only changes *how* the route is optimised. It **always uses your Point A and Point B**: addresses, markers, altitude, drone profile and weather stay exactly as you set them.
   - Clicking a scenario recalculates immediately with the same points. If a point is missing, you'll see "Please select both the starting point and destination before calculating a route."
   - What each scenario does:

     | Scenario | Optimises | Notes |
     |---|---|---|
     | Normal Flight | Safe corridors (river/parks) | The standard route |
     | Blood Delivery | Estimated delivery time (wind-aware) | Suggests the Delivery Drone profile but never switches it |
     | AED / First Aid Delivery | Estimated response time (wind-aware) | |
     | Avoid Prohibited Zone | Shortest path around every active blocked zone | Lists the zones the direct line would cross; NO_ROUTE if none exists |
     | Emergency Flight | Estimated travel time (EMERGENCY mode) | No special airspace permission |

   - **Every scenario enforces all hard airspace restrictions**, and there is no switch to disable them. Scenarios with the same goal (Blood, AED, Emergency) honestly produce the same route.
   - Changing the flight mode or route optimisation by hand switches to "Custom settings".
4. **Flight Altitude:** 20–120 m in 5 m steps (default 80 m). This is a prototype above-ground-level setting, not an authorization to fly.
5. **Flight mode:** **NORMAL** or **EMERGENCY**. With *Safe corridors*, EMERGENCY uses weights that favour more direct paths. Neither mode ever enters a blocked zone.
6. **Route optimisation:**
   - **Safe corridors** (default): prefers the river and parks.
   - **Shortest:** minimises distance.
   - **Fastest:** minimises flight time from the drone's cruise speed and the wind at your altitude in each direction of travel. With uniform wind (always the case for DEMO weather), the fastest path in open air is the straight line, so *Fastest* only differs from *Shortest* around obstacles, or where LIVE wind varies along the route.
7. **Drone profile:** *Standard* (DEMO_DRONE_01) or *Delivery* (DEMO_DRONE_02), which set cruise speed, wind limit, vertical clearance and range.
8. **Weather:**
   - **DEMO:** fixed sample wind, reproducible.
   - **LIVE:** the Open-Meteo forecast sampled about every 5 km along the trip, at your flight altitude. If it can't be fetched, the app says so and uses DEMO wind.
9. **Calculate Route:**
   - The route is drawn blue for NORMAL and green for EMERGENCY.
   - The results show distance, ETA, districts (e.g. Włochy → Wilanów), the optimisation used, warnings and search statistics.
   - Changing any input marks the route **outdated** until you recalculate.
10. **Clear Route** keeps your inputs; **Reset Planner** restores the defaults.
11. **Load demo fixture (replaces Point A and B):** an explicit, collapsed option and the only place with predefined points. It never runs when you pick a scenario, and it doesn't change your scenario, mode, profile or weather. The fixtures are:
    - **Depot → hospital pad** (DEMO stations).
    - **Across the Sejm zone:** the straight line crosses the DEMO DRA-P zone.
    - **Enclosed courtyard (no route at 20 m):** sets 20 m.

### Airspace zones

The map shows the loaded zones **before** any route is calculated, coloured by what they mean for *your* planned flight. The zones are re-evaluated when you change the altitude.

| Colour | Meaning |
|---|---|
| RED | Blocked / prohibited for the planned operation (DRA-P) |
| ORANGE | Conditional / authorization required: DRA-R, RH, RM, RL and DRA-U. Shown as **Unavailable for this route**, because no authorization is recorded. |
| YELLOW | Technical requirements (DRA-T: unavailable, not verified) or information (DRA-I: warning only) |
| GRAY | Insufficient verification (unknown category or missing source). Treated as blocked. |
| Dashed outline | Not active for this flight (outside its validity period or altitude band) |
| Solid red outline | Routing obstacle |
| Dashed grey rectangle | **Extent of the airspace dataset.** The DEMO zones exist only inside it; elsewhere zones are unknown and routes say so. |

- **Zone details:** click a zone (or a zone in the right-hand list) to see its DRA category, status and reasons, altitude band, validity, conditions, source and verification status.
- **Filters and toggles:** filters by DRA category and the layer toggles change the display only; routing always uses every loaded zone.
- **Points inside a blocked zone:** the route is refused (the point is never secretly moved). The zone is highlighted, and its popup opens.
- **Dataset changes:** if the zone dataset changes, routes planned on the old version are marked outdated.

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
- **Without `scenario`:** `mode` and `routeObjective` (`CORRIDORS` default, `SHORTEST`, `FASTEST`) are used as sent, so existing clients keep working. The optional `departureTime` (ISO 8601) evaluates zone validity periods at that time.

The response contains:
- `start` and `destination`, echoed exactly as submitted; `scenario`, `scenarioDisplayName` and `optimizationGoal`.
- `status`, `message`, `geometry` (a GeoJSON LineString, `[lon, lat]`), `distanceM` and `etaS`.
- The echoed settings, and `weather` (including its samples along the route).
- `coverage`: whether both points are inside the official boundary, their districts, and the route length outside the airspace dataset extent.
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
- **Airspace zones, landing stations and drone profiles:** synthetic DEMO data; see **[DATA_SOURCES.md](DATA_SOURCES.md)** for the official-data situation and how to load an official zone file.
- **Map tiles:** © OpenStreetMap contributors.

## Tests

```bash
cd backend  && .venv/Scripts/python -m pytest          # 205 tests, external APIs mocked
cd frontend && npx ng test --watch=false                # 102 tests (Vitest)
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
- **Routing engine:** a hand-written A* on a NumPy grid, as the project spec requires (no NetworkX at runtime).
- **Scenarios differ only by optimisation goal and cost profile.** Blood, AED and Emergency share the same goal and give the same route. There is no AED-location dataset in the repository (none was added).
- **Not built yet:** drone animation, normal-vs-emergency comparison, and choosing a landing station or drop point as the route end.
