"""One route-calculation service for every scenario.

RouteService resolves the scenario's configuration (optimisation goal, cost
profile), the drone profile and the weather, then calls the single shared
A* planner. Start and destination are always the request's own coordinates:
no scenario can replace them, and there is no per-scenario routing function.
"""

from __future__ import annotations

from datetime import datetime, timezone

from fastapi.concurrency import run_in_threadpool

from app.services.clock import to_warsaw, warsaw_now
from app.airspace.status import VERIFICATION_TEXT, SourceState, airspace_status
from app.routing.costs import FlightMode, RouteObjective
from app.routing.planner import RoutePlanner, plan_timed
from app.routing.scenarios import SCENARIOS, ScenarioConfig
from app.schemas.planning import (
    OBJECTIVE_OPTIMIZATION,
    Coordinate,
    CoverageCheck,
    LineStringGeometry,
    RouteRequest,
    RouteResponse,
    RouteStatus,
    SearchInfo,
    WeatherSource,
)
from app.services.drone_profiles import DroneProfileRegistry
from app.services.weather import WeatherService

BASE_SOURCES = [
    "Buildings, river & parks: © OpenStreetMap contributors (ODbL); unknown building heights use the configured "
    "routing policy",
    "Landing stations: synthetic sample locations, not operational facilities",
    "Drone profiles: synthetic sample performance values",
]


WEATHER_SOURCE_LABEL = {
    WeatherSource.SAMPLE: "Weather: SAMPLE wind",
    WeatherSource.OPEN_METEO: "Weather: Open-Meteo (live)",
    WeatherSource.SAMPLE_FALLBACK: "Weather: SAMPLE wind (live unavailable)",
    WeatherSource.CACHED: "Weather: Open-Meteo, last cached LIVE values (live currently unavailable)",
}


class UnknownProfileError(ValueError):
    pass


def resolve_settings(req: RouteRequest) -> tuple[ScenarioConfig | None, FlightMode, RouteObjective]:
    """Scenario configuration wins for mode/objective (the request validator
    already rejected explicit conflicts). Without a scenario, the request's own
    mode/routeObjective are used (backwards compatible)."""
    if req.scenario is None:
        return None, req.mode, req.route_objective
    cfg = SCENARIOS[req.scenario]
    return cfg, cfg.mode, cfg.route_objective


class RouteService:
    def __init__(self, planner: RoutePlanner, profiles: DroneProfileRegistry, weather: WeatherService):
        self.planner = planner
        self.profiles = profiles
        self.weather = weather

    async def calculate(self, req: RouteRequest) -> RouteResponse:
        profile = self.profiles.get(req.drone_profile_id)
        if profile is None:
            raise UnknownProfileError(
                f"Unknown droneProfileId '{req.drone_profile_id}'. Available: {', '.join(self.profiles.ids)}."
            )
        scenario, mode, objective = resolve_settings(req)
        start = (req.start.longitude, req.start.latitude)
        destination = (req.destination.longitude, req.destination.latitude)

        # Wind sampled along the A-B line at the flight altitude (LIVE), or fixed  wind.
        weather = await self.weather.get_for_route(req.weather_mode, req.flight_altitude_meters, start, destination)
        # One instant for zone validity, weather and the response: the request's time or now in Warsaw.
        at = to_warsaw(req.departure_time) if req.departure_time else warsaw_now()
        result, ms = await run_in_threadpool(
            plan_timed, self.planner, start, destination, mode, req.flight_altitude_meters, profile, weather, at,
            objective, req.planning_constraints,
        )

        warnings = list(result.warnings)
        if weather.source in (WeatherSource.SAMPLE_FALLBACK, WeatherSource.CACHED):
            warnings.insert(0, weather.message)
        if scenario and scenario.recommended_profile_id and scenario.recommended_profile_id != profile.id:
            rec = self.profiles.get(scenario.recommended_profile_id)
            warnings.append(f"{scenario.display_name}: the {rec.name if rec else scenario.recommended_profile_id} "
                            f"profile is suggested for this scenario; your selected {profile.name} profile was used.")

        path = result.path_lonlat
        source = result.airspace.source_info()
        cov = self.planner.coverage
        status = airspace_status(result.airspace, cov, at)
        verification = VERIFICATION_TEXT[SourceState(status.source_state)]
        if result.airspace_outside_extent_m > 0 and status.source_state != SourceState.UNAVAILABLE:
            verification += (f" PARTIAL AIRSPACE DATA: {result.airspace_outside_extent_m / 1000:.1f} km of the route "
                             "lies outside the loaded zone dataset and was not checked against any zones.")
        if weather.source in (WeatherSource.SAMPLE_FALLBACK, WeatherSource.CACHED):
            verification += (" WEATHER NOT CURRENT: live weather could not be retrieved, so the wind used is "
                             f"{'cached' if weather.source == WeatherSource.CACHED else 'a sample value'}.")
        return RouteResponse(
            status=result.status,
            message=result.message,
            start=req.start,
            destination=req.destination,
            scenario=scenario.id if scenario else None,
            scenario_display_name=scenario.display_name if scenario else "Custom settings",
            optimization_goal=scenario.optimization_goal if scenario else None,
            geometry=LineStringGeometry(coordinates=[list(p) for p in path]) if path else None,
            distance_m=result.distance_m,
            eta_s=result.eta_s,
            mode=mode,
            route_objective=objective,
            optimization=OBJECTIVE_OPTIMIZATION[objective],
            flight_altitude_meters=req.flight_altitude_meters,
            drone_profile_id=profile.id,
            weather=weather,
            route_start=Coordinate(longitude=path[0][0], latitude=path[0][1]) if path else None,
            route_destination=Coordinate(longitude=path[-1][0], latitude=path[-1][1]) if path else None,
            coverage=CoverageCheck(
                valid=result.status not in (RouteStatus.OUTSIDE_COVERAGE, RouteStatus.COVERAGE_UNAVAILABLE),
                area=cov.label,
                start_district=result.start_district,
                destination_district=result.destination_district,
                source=cov.source.get("source", "unavailable"),
                airspace_outside_extent_m=result.airspace_outside_extent_m,
            ),
            search=SearchInfo(**vars(result.search)) if result.search else None,
            zone_conflicts=result.conflicts,
            airspace=source,
            airspace_verification=status,
            planning_constraints_applied=result.planning_constraints_applied,
            planning_verification_status=verification,
            warnings=warnings,
            data_sources=[f"Airspace zones: {source.label} ({source.source_type.value}, version "
                          f"{source.dataset_version})", *BASE_SOURCES, WEATHER_SOURCE_LABEL[weather.source]],
            compute_ms=round(ms, 1),
            calculated_at=at,
        )
