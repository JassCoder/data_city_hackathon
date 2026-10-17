# MASTER PROMPT — SKYROUTE WARSAW (Angular + Python FastAPI)

## Role
You are a senior full-stack engineer (Angular, Python, GIS, pathfinding) acting as technical lead for a weekend hackathon. Build a real, working, interactive application, not a mockup. Prioritise a reliable end-to-end demo over completeness.

## Project
**SkyRoute Warsaw — a "Google Maps for drones" for Warsaw.**
A user picks a start and destination on a real Warsaw map. The backend computes a drone route that avoids restricted zones and tall buildings, prefers safe corridors (the Vistula river, parks), and returns it. The frontend shows the route and animates a drone along it.

This is a **planning and simulation prototype**. It never controls real drones. All zones and stations in the demo dataset are synthetic and must be labelled "DEMO DATA" in the UI. Poland already has official drone airspace systems (PAŻP, DroneTower/PansaUTM); our contribution is the route-planning layer on top.

## Tech stack
**Frontend:** Angular (latest stable from `ng new`), TypeScript, standalone components, Signals, Angular Material, SCSS, Leaflet with OpenStreetMap tiles.
**Backend:** Python 3.12+, FastAPI, Pydantic, Uvicorn, Shapely, PyProj, NumPy, HTTPX, Pytest.
**Data:** local GeoJSON files in `/data`. No database.
**Do NOT use** OSMnx or NetworkX at runtime, and no GeoPandas unless strictly needed. Write A* yourself on a NumPy grid.

## Repository
```
skyroute-warsaw/
  frontend/            Angular app
  backend/
    app/main.py
    app/routers/       routes.py, data.py, weather.py
    app/schemas/       Pydantic models
    app/routing/       grid.py (rasterise), astar.py, costs.py
    app/services/      data_loader.py, weather.py
    tests/
  data/
    zones.geojson          synthetic restricted zones
    buildings.geojson      OSM snapshot of demo area, with height
    corridors.geojson      river + parks
    landing_stations.geojson
  scripts/fetch_osm.py     one-off Overpass download for the demo area
  README.md
  PROJECT_PROGRESS.md
```

## Demo area
Central Warsaw bounding box, roughly Śródmieście + Powiśle + the Vistula, about 4 × 4 km. Map centre 52.2297, 21.0122.

## Routing model (core of the project)
1. **Grid:** project the demo bbox to metres (EPSG:2180, the Polish CRS) and build a grid of ~25 m cells.
2. **Rasterise once at startup** into a NumPy cost array using Shapely:
   | Cell type | Normal drone | Emergency drone |
   |---|---|---|
   | Vistula river corridor | 1 | 1 |
   | Park / green | 2 | 1 |
   | Open / low buildings | 5 | 2 |
   | Dense centre zone (`RESTRICTED`) | blocked | 3 |
   | School / kindergarten buffer (`RESTRICTED`) | blocked | 4 |
   | Building ≥ flight altitude − clearance | blocked | blocked |
   | Airport / government / military (`NO_FLY`) | blocked | blocked |

   Zone types: `NO_FLY` is blocked for everyone. `RESTRICTED` is blocked for normal drones but passable at a cost for emergency drones. Keep all weights in `costs.py` as config.
3. **A\*** with 8-direction moves, cost = step length × cell cost, Euclidean heuristic × minimum cell cost (admissible). Forbid diagonal moves that cut a blocked corner.
4. **Smooth** the path with line-of-sight checks, never crossing a blocked cell.
5. **Wind:** a global wind speed/direction. Above a profile limit (default 40 km/h), return status `BLOCKED_WEATHER`. Below it, adjust ETA per segment using the headwind/tailwind component.
6. Convert the path back to WGS84 and return a GeoJSON LineString (lon, lat order).

Return clear errors: start/destination inside a blocked cell, outside the demo area, or no route found.

## Landing
- 3–5 synthetic landing stations (hospital pad, rooftop pad, park pad) shown on the map.
- The user may pick a station or click a custom drop point. Reject the point if it lies in a `NO_FLY`/`RESTRICTED` zone. Physical landing safety is the operator's responsibility.
- With no landing point, the drone arrives and shows a "Holding position" state.

## API
```
GET  /api/v1/health
GET  /api/v1/layers           zones, corridors, buildings, stations (GeoJSON)
GET  /api/v1/weather          live Open-Meteo with demo fallback
POST /api/v1/routes/calculate
POST /api/v1/routes/compare   normal vs emergency, same A/B
```
Request: `start`, `destination`, `mode` (NORMAL|EMERGENCY), `altitudeM`, `wind` ({speedKmh, directionDeg} or "LIVE").
Response: `status`, `geometry`, `distanceM`, `etaS`, `warnings[]`, `dataSources`.

## UI
- **Left panel:** click-mode buttons (Start / Destination / Landing point), altitude slider (30–120 m), mode toggle Normal/Emergency, wind speed + direction sliders with a "Live weather" switch, buttons Calculate / Compare / Reset / **Load demo scenario**.
- **Centre:** Leaflet map with layer toggles and a legend: zones (red = no-fly, orange = restricted), corridors (blue/green), tall buildings (dark grey), stations (icons), route (blue = normal, red = emergency).
- **Right panel:** distance, ETA, status, warnings, and the normal vs emergency comparison.
- **Bottom bar:** drone animation controls Play / Pause / Reset, speed ×1/×5/×20, and progress.
- Recalculate automatically when altitude, mode or wind changes, so judges can see routes react live.

## Demo scenario (must always work offline)
"Blood delivery": from a station near the Vistula to a hospital in Śródmieście. The normal route follows the river and goes around the dense centre. The emergency route cuts through the centre and is visibly shorter. Lowering altitude makes it detour around the Palace of Culture. Raising wind above the limit shows the blocked state.

## Phases (finish, run, and verify each before the next)
1. Skeleton: Angular app with the Leaflet Warsaw map, FastAPI `/health`, and frontend calling the backend (CORS configured).
2. Data: `scripts/fetch_osm.py` saves buildings (height or levels × 3 m; unknown → 15 m, labelled), parks and river for the bbox into `/data`. Hand-write synthetic `zones.geojson` and `landing_stations.geojson`. Serve via `/layers` and render them.
3. Routing: grid, rasterisation, A*, smoothing, `/routes/calculate`. Pytest for obstacle avoidance, corner cutting, no-route, and NO_FLY blocking in emergency mode.
4. Modes, altitude and wind: emergency costs, `/routes/compare`, building height vs altitude, wind ETA/blocking, live Open-Meteo with demo fallback.
5. UX: landing stations and custom drop point, drone animation, dashboard panels, demo scenario button.
6. Polish: README (setup, how routing works, limitations), and UI cleanup. Docker only if time remains.

After each phase: run builds and tests, fix errors, state assumptions, update PROJECT_PROGRESS.md. Never claim tests passed without running them.

## Rules
- Keep it simple: a modular monolith with no auth and no database.
- Never present synthetic zones as real legal restrictions.
- External APIs must have offline fallbacks, so the demo never breaks.
- Prefer working features over placeholders.

**Start with Phase 1 now:** inspect the working directory and installed tools, scaffold both apps, and verify both start.
