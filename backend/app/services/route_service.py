"""One route-calculation service for every scenario.

RouteService resolves the scenario's configuration (optimisation goal, cost
profile), the drone profile and the weather, then calls the single shared
A* planner. Start and destination are always the request's own coordinates:
no scenario can replace them, and there is no per-scenario routing function.
"""

from __future__ import annotations

from datetime import datetime, timezone

from fastapi.concurrency import run_in_threadpool

from app.airspace.models import SourceType
from app.routing.costs import FlightMode, RouteObjective
from app.routing.planner import RoutePlanner, plan_timed
from app.routing.scenarios import SCENARIOS, ScenarioConfig
from app.schemas.planning import (
    Coordinate,
    CostBreakdown,
    CoverageCheck,
    LineStringGeometry,
    RouteRequest,
    RouteResponse,
    RouteStatus,
    SearchInfo,
    TermCostInfo,
    WeatherSource,
)
from app.services.drone_profiles import DroneProfileRegistry
from app.services.weather import WeatherService

BASE_SOURCES = [
    "Buildings, river & parks: © OpenStreetMap contributors (ODbL)",
    "Population density, land use, schools/hospitals, stops: estimated proxy from OpenStreetMap (ODbL), not a census",
    "Landing stations: synthetic DEMO DATA",
    "Drone profiles: sample DEMO data",
]

VERIFICATION = {
    SourceType.DEMO: "SIMULATION_ONLY: DEMO airspace (synthetic zones). Not a check of real-world flight legality.",
    SourceType.PERMITTED_SNAPSHOT: "SIMULATION_ONLY: official zone snapshot, not checked for currency. "
    "Not a check of real-world flight legality; confirm in PAŻP DroneTower/DroneMap.",
    SourceType.OFFICIAL: "SIMULATION_ONLY: official zone data. Not a check of real-world flight legality; "
    "confirm in PAŻP DroneTower/DroneMap.",
}

WEATHER_SOURCE_LABEL = {
    WeatherSource.DEMO: "Weather: DEMO sample wind",
    WeatherSource.OPEN_METEO: "Weather: Open-Meteo (live)",
    WeatherSource.DEMO_FALLBACK: "Weather: DEMO sample wind (live unavailable)",
}


BREAKDOWN_NOTE = ("Cost model: data/cost_model.json (DEMO weights; Lowest energy uses its own preset, every other "
                  "objective is explained with the Safest weights). Population density is an estimate from OSM "
                  "floor area and stops, not census data.")


class InvalidRouteRequestError(ValueError):
    """A request that is well-formed but invalid for the chosen profile (HTTP 422)."""


class UnknownProfileError(InvalidRouteRequestError):
    pass


DEGRADED_NOTE = ("Risk layers not loaded (run scripts/fetch_risk_layers.py): crowd, noise and sensitive-site "
                 "terms are 0 and open space comes from the park mask. Energy and battery figures are complete.")


def cost_breakdown(result, risk_data_available: bool = True) -> CostBreakdown | None:
    b = result.breakdown
    if b is None:
        return None
    return CostBreakdown(
        total_cost=round(b.total_cost, 1), length_m=round(b.length_m, 1),
        terms=[TermCostInfo(term=name, weight=t.weight, mean=round(t.mean, 4), cost=round(t.cost, 1))
               for name, t in b.terms.items()],
        energy_wh=round(b.energy_wh + result.vertical_energy_wh, 1),
        vertical_energy_wh=round(result.vertical_energy_wh, 1),
        battery_usable_wh=round(result.battery_usable_wh, 1),
        payload_kg=result.payload_kg, flight_time_s=round(b.flight_time_s, 1),
        population_exposure=round(b.population_exposure, 2), max_density_per_ha=round(b.max_density_per_ha, 1),
        local_hour=result.local_hour, note=BREAKDOWN_NOTE if risk_data_available else DEGRADED_NOTE,
    )


def resolve_settings(req: RouteRequest) -> tuple[ScenarioConfig | None, FlightMode, RouteObjective]:
    """Scenario configuration wins for mode/objective (the request validator
    already rejected explicit conflicts). Without a scenario, the request's own
    mode/routeObjective are used (backwards compatible)."""
    if req.scenario is None:
        return None, req.mode, req.route_objective
    cfg = SCENARIOS[req.scenario]
    # An explicit mode is honoured when the scenario allows it (validated in RouteRequest).
    mode = req.mode if "mode" in req.model_fields_set else cfg.mode
    return cfg, mode, cfg.route_objective


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
        if req.payload_kg is not None and req.payload_kg > profile.max_payload_kg:
            raise InvalidRouteRequestError(f"payloadKg {req.payload_kg:g} exceeds the {profile.name} maximum of "
                                           f"{profile.max_payload_kg:g} kg.")
        scenario, mode, objective = resolve_settings(req)
        altitude = req.flight_altitude_meters
        if altitude is None:
            altitude = int(self.planner.risk.cfg.altitude.default_cruise_m)
        start = (req.start.longitude, req.start.latitude)
        destination = (req.destination.longitude, req.destination.latitude)

        # Wind sampled along the A-B line at the flight altitude (LIVE), or fixed DEMO wind.
        weather = await self.weather.get_for_route(req.weather_mode, altitude, start, destination)
        at = req.departure_time or datetime.now(timezone.utc)
        if at.tzinfo is None:
            at = at.replace(tzinfo=timezone.utc)
        result, ms = await run_in_threadpool(
            plan_timed, self.planner, start, destination, mode, altitude, profile, weather, at, objective,
            req.payload_kg,
        )

        warnings = list(result.warnings)
        if weather.source == WeatherSource.DEMO_FALLBACK:
            warnings.insert(0, weather.message)
        if scenario and scenario.recommended_profile_id and scenario.recommended_profile_id != profile.id:
            rec = self.profiles.get(scenario.recommended_profile_id)
            warnings.append(f"{scenario.display_name}: the {rec.name if rec else scenario.recommended_profile_id} "
                            f"profile is suggested for this scenario; your selected {profile.name} profile was used.")

        path = result.path_lonlat
        source = result.airspace.source_info()
        cov = self.planner.coverage
        verification = VERIFICATION[source.source_type]
        if result.airspace_outside_extent_m > 0:
            verification += (f" PARTIAL AIRSPACE DATA: {result.airspace_outside_extent_m / 1000:.1f} km of the route "
                             "lies outside the loaded zone dataset and was not checked against any zones.")
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
            flight_altitude_meters=altitude,
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
            cost_breakdown=cost_breakdown(result, self.planner.risk.data_available),
            airspace=source,
            planning_verification_status=verification,
            warnings=warnings,
            data_sources=[f"Airspace zones: {source.label} ({source.source_type.value}, version "
                          f"{source.dataset_version})", *BASE_SOURCES, WEATHER_SOURCE_LABEL[weather.source]],
            compute_ms=round(ms, 1),
        )
