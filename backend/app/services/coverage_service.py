"""Separate coverage metrics for GET /map/coverage (no single blended "coverage %").

A. geographicRouting  share of the official Warsaw polygon where points can be
                      selected and routes computed; 100 % only when every
                      citywide validation check passes.
B. buildings          share of Warsaw inside the building snapshot's fetched
                      extent, plus height availability. OSM mapping
                      completeness itself is not verified.
C. officialAirspace   official zone data only (app/airspace/status.py); 
                      zones never count.
E. weather            provider support for Warsaw and the last LIVE outcome.

D (-zone coverage) is deliberately NOT here: it is development-only and
lives in GET /zones/diagnostics.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from shapely.geometry import box

from app.airspace.status import airspace_status
from app.config import WEATHER_SAMPLE_SPACING_KM
from app.geo.airports import AirportData
from app.geo.coverage import Coverage
from app.routing.grid import Grid, to_metres
from app.routing.planner import RoutePlanner
from app.services.weather import WeatherService

AREA_TOLERANCE = 0.01  # 1 %: polygon vs. district union vs. raster mask
EXPECTED_DISTRICTS = 18

_cache: dict[tuple, Any] = {}


def _city_m(coverage: Coverage):
    key = ("city_m", id(coverage.geom))
    if key not in _cache:
        _cache[key] = to_metres(coverage.geom)
    return _cache[key]


def _age_days(iso: str | None, now: datetime) -> int | None:
    if not iso:
        return None
    try:
        t = datetime.fromisoformat(iso.replace("Z", "+00:00"))
    except ValueError:
        return None
    return max(0, (now - (t if t.tzinfo else t.replace(tzinfo=timezone.utc))).days)


def geographic_routing(coverage: Coverage, grid: Grid) -> dict[str, Any]:
    method = ("Share of the official GUGiK PRG Warsaw polygon covered by the routing raster, reported as "
              "VALIDATED only when every check passes.")
    if not coverage.available or coverage.geom is None:
        return {"pct": 0.0, "status": "UNAVAILABLE", "checks": [], "method": method, "message": coverage.message}
    key = ("geo", id(coverage), len(coverage.districts), id(grid))
    if key in _cache:
        return _cache[key]
    city_m = _city_m(coverage)
    extent = box(grid.min_x, grid.min_y, grid.min_x + grid.cols * grid.cell, grid.min_y + grid.rows * grid.cell)
    district_area = sum(to_metres(d.geom).area for d in coverage.districts)
    mask_area = float(grid.coverage.sum()) * grid.cell ** 2
    checks = [
        {"name": "official_boundary", "passed": "TERYT 1465" in coverage.label and "PRG" in str(coverage.source.get("source", "")),
         "detail": f"{coverage.label}; {coverage.source.get('source', 'unknown source')}"},
        {"name": "all_18_districts", "passed": len(coverage.districts) == EXPECTED_DISTRICTS,
         "detail": f"{len(coverage.districts)} districts loaded"},
        {"name": "districts_tile_the_city", "passed": abs(district_area - city_m.area) <= AREA_TOLERANCE * city_m.area,
         "detail": f"district union {district_area / 1e6:.1f} km² vs city {city_m.area / 1e6:.1f} km²"},
        {"name": "raster_contains_city", "passed": bool(extent.buffer(1e-6).contains(city_m)),
         "detail": f"routing raster {grid.rows} x {grid.cols} cells of {grid.cell:g} m"},
        {"name": "routing_mask_matches_city", "passed": abs(mask_area - city_m.area) <= AREA_TOLERANCE * city_m.area,
         "detail": f"routable cells {mask_area / 1e6:.1f} km² vs city {city_m.area / 1e6:.1f} km²"},
    ]
    pct = round(100.0 * extent.intersection(city_m).area / city_m.area, 1)
    ok = all(c["passed"] for c in checks)
    out = {
        "pct": pct if ok else min(pct, 99.9),
        "status": "VALIDATED" if ok else "CHECKS_FAILED",
        "checks": checks,
        "districts": len(coverage.districts),
        "cityAreaKm2": round(city_m.area / 1e6, 1),
        "method": method,
        "message": ("Routing is supported anywhere inside the official City of Warsaw boundary (all 18 districts)."
                    if ok else "Citywide validation failed: see checks."),
    }
    _cache[key] = out
    return out


def building_coverage(grid: Grid, now: datetime) -> dict[str, Any]:
    meta = grid.meta or {}
    stats = meta.get("stats", {})
    sources = stats.get("heightSources", {})
    n = int(stats.get("buildings", 0))
    unknown = int(sources.get("unknown", stats.get("unknownHeights", 0)))
    declared = "City of Warsaw" in str(meta.get("coverage", ""))
    return {
        "pct": 100.0 if declared and n else 0.0,
        "status": "AVAILABLE" if n else "UNAVAILABLE",
        "basis": "DECLARED_EXTENT",
        "method": ("scripts/fetch_osm.py queries every Overpass tile covering the city bounds and writes the snapshot "
                   "only if all tiles succeed; buildings are kept when inside the official polygon. The figure is the "
                   "share of Warsaw inside that fetched extent. OSM mapping completeness is NOT verified."),
        "source": meta.get("source"),
        "fetchedAt": meta.get("fetched_at"),
        "ageDays": _age_days(meta.get("fetched_at"), now),
        "buildings": n,
        "heightSources": sources,
        "knownHeights": n - unknown,
        "unknownHeights": unknown,
        "unknownHeightPolicy": grid.unknown_policy.label if grid.unknown_policy else None,
        "limitations": ["Heights from building:levels are estimated (levels × 3 m).",
                        "OSM heights may include spires and masts.",
                        "Recently built or unmapped buildings are missing."],
    }


def weather_status(weather: WeatherService | None) -> dict[str, Any]:
    return {
        "provider": "Open-Meteo (LIVE) / fixed  wind",
        "supportsWarsaw": True,
        "status": "AVAILABLE" if weather is None or weather.last_live_error is None
                  or (weather.last_live_success and weather.last_live_success > weather.last_live_error_at)
                  else "LIVE_FAILING",
        "method": (f"Open-Meteo is a global forecast service, so every Warsaw location is supported. LIVE requests "
                   f"sample the A-B line every ~{WEATHER_SAMPLE_SPACING_KM:g} km; on failure the route uses  wind "
                   "and says so."),
        "lastLiveSuccess": weather.last_live_success if weather else None,
        "lastLiveError": weather.last_live_error if weather else None,
        "lastLiveErrorAt": weather.last_live_error_at if weather else None,
    }


def coverage_metrics(planner: RoutePlanner, airports: AirportData | None, weather: WeatherService | None) -> dict[str, Any]:
    now = datetime.now(timezone.utc)
    state = planner.airspace.state
    status = airspace_status(state, planner.coverage, now)
    buildings = building_coverage(planner.grid, now)
    return {
        "geographicRouting": geographic_routing(planner.coverage, planner.grid),
        "buildings": buildings,
        "officialAirspace": status.model_dump(mode="json", by_alias=True),
        "weather": weather_status(weather),
        "airports": {
            "status": "AVAILABLE" if airports and airports.available else "UNAVAILABLE",
            "count": len(airports.airports) if airports else 0,
            "icao": sorted(a.icao for a in airports.airports if a.icao) if airports else [],
            "fetchedAt": airports.metadata.get("fetchedAt") if airports else None,
            "regulatoryStatus": "INFORMATIVE: airport footprints are not drone zones",
        },
        "providers": [
            {"layer": "boundary", "provider": "GUGiK PRG (OGC API Features)", "refreshed": planner.coverage.source.get("retrievedAt")},
            {"layer": "buildings", "provider": "OpenStreetMap / Overpass", "refreshed": buildings["fetchedAt"]},
            {"layer": "airports", "provider": "OpenStreetMap / Overpass",
             "refreshed": airports.metadata.get("fetchedAt") if airports else None},
            {"layer": "airspace", "provider": state.dataset.label, "refreshed": state.dataset.loaded_at,
             "state": status.source_state},
            {"layer": "weather", "provider": "Open-Meteo", "refreshed": weather.last_live_success if weather else None},
        ],
    }
