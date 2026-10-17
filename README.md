# SkyRoute Warsaw

A "Google Maps for drones" prototype for central Warsaw. Enter two addresses, choose a flight profile, and the backend plans a drone route that:
- avoids blocked UAS geographical zones (Polish DRA categories, evaluated for your flight's altitude and time),
- avoids buildings taller than the flight altitude,
- prefers safe corridors (the Vistula and parks).

> **Planning and simulation prototype.** It never controls real drones, and avoiding the loaded zones does **not** confirm real-world flight legality. The airspace zones, landing stations and drone profiles shipped here are **synthetic DEMO data**, not official PAŻP zones. No documented, permitted machine-readable source of official Polish zones was found; see [DATA_SOURCES.md](DATA_SOURCES.md). Check PAŻP DroneTower or DroneMap before any real flight.

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

The data in `data/` is committed, so no network is needed to run the app or the demo scenario. Address search (Nominatim) and LIVE weather (Open-Meteo) need internet access. Without it, use map clicks or manual coordinates, and DEMO weather.

## Using the planner

1. **Point A / Point B:** type an address (for example *Warszawa Centralna, Warszawa* or *Centrum Nauki Kopernik, Warszawa*) and press **Search**, then choose the right place from the list. You can also click **Pick on map**, or enter coordinates under **Coordinates**. A plain map click fills A first, then B.
2. **Flight Altitude:** 20–120 m in 5 m steps (default 80 m), set with the slider or the number box. This is a prototype above-ground-level setting, not an authorization to fly.
3. **Flight mode:**
   - **NORMAL:** prefers the river and parks.
   - **EMERGENCY:** prefers more direct paths. It still never enters no-fly or restricted zones.
4. **Drone profile:** *Standard* (DEMO_DRONE_01) or *Delivery* (DEMO_DRONE_02). The profile sets cruise speed, wind limit, vertical clearance and range.
5. **Weather:**
   - **DEMO:** fixed sample wind, so results are reproducible.
   - **LIVE:** current wind from Open-Meteo. If live data can't be fetched, the app says so explicitly and uses DEMO wind.
6. **Calculate Route:** this button is enabled once both points and all settings are valid. The route is drawn blue for NORMAL and green for EMERGENCY, with its distance, ETA and warnings. Changing any input marks the route as **outdated** (grey, dashed) until you recalculate.
7. **Clear Route** removes the result but keeps your inputs. **Reset Planner** clears everything back to the defaults.
8. **Load Demo Scenario** offers three examples, each calculated through the same API:
   - **Blood delivery:** Vistula depot → hospital pad (DEMO stations).
   - **Avoid a prohibited zone:** the straight line crosses the DEMO DRA-P zone at Sejm, and the route goes around it.
   - **No route available:** a courtyard enclosed by buildings at 20 m.

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

- **Zone details:** click a zone (or a zone in the right-hand list) to see its DRA category, status and reasons, altitude band, validity, conditions, source and verification status.
- **Filters and toggles:** filters by DRA category and the "Airspace zones" layer toggle change the display only; routing always uses every loaded zone.
- **Points inside a blocked zone:** if Point A or B is inside one, the route is refused (it is never secretly moved). The zone is highlighted, and its popup opens.
- **Dataset changes:** if the zone dataset changes, routes planned on the old version are marked outdated.

Points outside the routing area are refused with a precise message. That includes, for example, Chopin Airport and Saska Kępa. The routing area is Śródmieście, Powiśle and the Vistula (lat 52.215–52.250, lon 20.985–21.050), shown as the dashed rectangle. Address results outside it are shown but cannot be selected.

## API

All endpoints are under `/api/v1`. JSON fields are camelCase.

| Method & path | Purpose |
|---|---|
| `GET /health` | Status, version, demo bbox |
| `GET /layers` | Corridors, buildings, stations (GeoJSON) and the bbox |
| `GET /zones?altitudeM=&at=` | All loaded airspace zones, each with `evaluation` (status, display class, obstacle flag, reasons), plus `source` (provider, type, timestamp, dataset version) |
| `GET /zones/{zoneId}` | One zone, evaluated (404 if unknown) |
| `GET /geocoding/search?query=` | Address search. Returns `displayName`, `latitude`, `longitude`, `placeId`, `source`, `inCoverage` |
| `GET /drone-profiles` | Sample drone profiles (the only source of profile definitions) |
| `GET /weather?mode=DEMO\|LIVE` | Wind used for routing |
| `POST /routes/calculate` | Plans a route |

```json
POST /api/v1/routes/calculate
{
  "start": { "latitude": 52.22882, "longitude": 21.00316 },
  "destination": { "latitude": 52.24178, "longitude": 21.0286 },
  "mode": "NORMAL",
  "flightAltitudeMeters": 80,
  "droneProfileId": "DEMO_DRONE_01",
  "weatherMode": "DEMO"
}
```

An optional `departureTime` (ISO 8601) evaluates zone validity periods at that time. The default is now.

The response contains:
- `status` and `message`
- `geometry`: a GeoJSON LineString, `[lon, lat]`
- `distanceM` and `etaS`
- the echoed settings and `weather`
- `zoneConflicts`: zones the direct line would cross, information zones crossed, zones near the route, or the zone containing a rejected point
- `airspace`: the zone dataset source, timestamp and version
- `planningVerificationStatus`: always "SIMULATION_ONLY…"
- `warnings` and `dataSources` Planning outcomes come back as HTTP 200 with one of these statuses:
- `OK`
- `NO_ROUTE`
- `OUTSIDE_COVERAGE`
- `START_BLOCKED` or `DESTINATION_BLOCKED` (the point lies inside a zone)
- `BLOCKED_WEATHER`

When there is no route, `geometry` is `null`; the API never returns a fake straight line. Invalid requests get HTTP 422: non-numeric or out-of-range coordinates, an unknown mode or profile, or an altitude outside 20–120 m or not in 5 m steps.

## How routing works

1. **Grid:** at startup, the demo area is projected to EPSG:2180 (metres) and rasterised into a grid of 25 m cells (161 × 182) with Shapely and NumPy. Each airspace zone, enlarged by a **20 m safety margin**, is also rasterised once.
2. **Zone evaluation:** for every request, each zone is evaluated for the flight's time, altitude and category. Only the zones that come out as obstacles are blocked. The rules are the same for NORMAL and EMERGENCY. Unknown data is treated conservatively.
3. **Costs:**
   - **Per-metre multipliers:** river 1, parks 2, open areas 5 for NORMAL; 1 / 1 / 2 for EMERGENCY.
   - **Blocked cells:** obstacle zones (with their margin), cells outside the area, and cells with a building at or above *altitude − the profile's vertical clearance*.
4. **A\* search:** 8 directions, no squeezing diagonally between blocked cells, with an admissible Euclidean heuristic.
5. **Smoothing:** line-of-sight shortcuts that never cross a blocked cell and never undo the corridor preference.
6. **Safety check:** every final segment is tested against the exact obstacle-zone polygons. If one touches a zone, the result is `NO_ROUTE`; a line through a zone is never returned.
7. **ETA:** calculated per segment from the profile's cruise speed, with crosswind correction and head/tailwind. If the wind exceeds the profile's limit, the result is `BLOCKED_WEATHER`.

A route takes about 80 ms to calculate.

## Data sources and attribution

- **Buildings, river and parks:** © OpenStreetMap contributors (ODbL), a snapshot fetched with `scripts/fetch_osm.py` via the Overpass API. Building height comes from `height`, else `building:levels × 3 m`, else an estimated 15 m.
- **Geocoding:** © OpenStreetMap contributors, via [Nominatim](https://nominatim.org/). It is called only from the backend, at most 1 request/s, cached for 24 h, and runs only on explicit search (no autocomplete), following the [usage policy](https://operations.osmfoundation.org/policies/nominatim/). The provider sits behind an interface, so an autocomplete-capable commercial provider can replace it.
- **Weather:** [Open-Meteo](https://open-meteo.com/) (LIVE mode).
- **Airspace zones, landing stations and drone profiles:** synthetic DEMO data (`scripts/build_demo_data.py`, `data/drone_profiles.json`). An official zone file (ED-269 style, or normalized GeoJSON) can be loaded with `SKYROUTE_AIRSPACE_PROVIDER` / `SKYROUTE_AIRSPACE_FILE` once PAŻP provides one. The full research and requirements are in **[DATA_SOURCES.md](DATA_SOURCES.md)**.
- **Map tiles:** © OpenStreetMap contributors.

## Tests

```bash
cd backend  && .venv/Scripts/python -m pytest          # 119 tests, external APIs mocked
cd frontend && npx ng test --watch=false                # 73 tests (Vitest)
```

## Limitations

- **Airspace data is synthetic.** No official Polish zone API or file was available, so official integration is limited to a file-based interface. Its ED-269 mapping has not been validated against a real PAŻP export.
- **Zone evaluation is simplified:**
  - No authorizations or technical capabilities are modelled, so every DRA-R/T/U zone in the flight's band is unavailable.
  - Daily schedules within a validity period and AUP/UUP activations are not evaluated.
  - AMSL limits use a fixed terrain range instead of a terrain model.
- **Coverage:** only the demo area (about 4.4 × 3.9 km) can be routed.
- **Grid resolution (25 m):** a building blocks a cell only if it covers the cell centre, so very narrow gaps and the edges of building footprints are approximate. Zones are rasterised conservatively, and the final line is checked against the exact zone polygons.
- **Building heights:** OSM heights include spires and masts. 759 of 6,637 buildings use the estimated 15 m.
- **Weather:** a single 10 m wind reading for central Warsaw, with no wind at altitude and no gust modelling. The ETA ignores take-off, landing, climb and descent.
- **Geocoding:** public Nominatim allows 1 request/s for the whole server, and the cache is in memory, so it resets on restart.
- **EMERGENCY mode** is a cost preference only. It never gets special access to zones, so its routes are only somewhat more direct.
- **Routing engine:** a hand-written A* on a NumPy grid, as the project spec requires (no NetworkX at runtime).
- **Not built yet:** drone animation, normal-vs-emergency comparison, and choosing a landing station or drop point as the route end.
