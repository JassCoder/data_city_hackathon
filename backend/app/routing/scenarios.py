"""Routing scenarios: configuration only, never route endpoints.

A scenario chooses what the shared A* engine optimises (and the cost profile).
Start and destination always come from the request; nothing here can set or
override them. Hard airspace restrictions apply to every scenario: there is no
switch to disable them.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum

from app.routing.costs import FlightMode, RouteObjective


class Scenario(StrEnum):
    NORMAL = "NORMAL"
    BLOOD_DELIVERY = "BLOOD_DELIVERY"
    AED_DELIVERY = "AED_DELIVERY"
    AVOID_PROHIBITED_ZONE = "AVOID_PROHIBITED_ZONE"
    EMERGENCY = "EMERGENCY"


class OptimizationGoal(StrEnum):
    PREFER_SAFE_CORRIDORS = "PREFER_SAFE_CORRIDORS"  # river/parks preferred (RouteObjective.CORRIDORS)
    MINIMIZE_DISTANCE = "MINIMIZE_DISTANCE"  # RouteObjective.SHORTEST
    MINIMIZE_ETA = "MINIMIZE_ETA"  # wind-aware flight time (RouteObjective.FASTEST)


GOAL_OBJECTIVE = {
    OptimizationGoal.PREFER_SAFE_CORRIDORS: RouteObjective.CORRIDORS,
    OptimizationGoal.MINIMIZE_DISTANCE: RouteObjective.SHORTEST,
    OptimizationGoal.MINIMIZE_ETA: RouteObjective.FASTEST,
}


@dataclass(frozen=True)
class ScenarioConfig:
    id: Scenario
    display_name: str
    description: str
    optimization_goal: OptimizationGoal
    mode: FlightMode
    use_weather: bool = True
    # Shown as a suggestion only; the user's selected profile is never changed.
    recommended_profile_id: str | None = None
    # Always True: listed so clients can show it, not so it can be turned off.
    respect_restricted_zones: bool = True
    # Modes a request may choose explicitly (the first one, `mode`, is the default).
    # Mode only changes the CORRIDORS terrain weights; airspace rules are identical.
    extra_modes: tuple[FlightMode, ...] = ()

    @property
    def allowed_modes(self) -> tuple[FlightMode, ...]:
        return (self.mode, *self.extra_modes)

    @property
    def route_objective(self) -> RouteObjective:
        return GOAL_OBJECTIVE[self.optimization_goal]


SCENARIOS: dict[Scenario, ScenarioConfig] = {
    c.id: c
    for c in (
        ScenarioConfig(
            Scenario.NORMAL, "Normal Flight",
            "Standard route between your points; prefers the river and park corridors.",
            OptimizationGoal.PREFER_SAFE_CORRIDORS, FlightMode.NORMAL,
        ),
        ScenarioConfig(
            Scenario.BLOOD_DELIVERY, "Blood Delivery",
            "Minimises estimated delivery time between your points (wind-aware), within all airspace limits.",
            OptimizationGoal.MINIMIZE_ETA, FlightMode.NORMAL, recommended_profile_id="DEMO_DRONE_02",
            extra_modes=(FlightMode.EMERGENCY,),
        ),
        ScenarioConfig(
            Scenario.AED_DELIVERY, "AED / First Aid Delivery",
            "Minimises estimated response time between your points (wind-aware), within all airspace limits.",
            OptimizationGoal.MINIMIZE_ETA, FlightMode.NORMAL, extra_modes=(FlightMode.EMERGENCY,),
        ),
        ScenarioConfig(
            Scenario.AVOID_PROHIBITED_ZONE, "Avoid Prohibited Zone",
            "Shortest path between your points around every active blocked zone; zones on the direct "
            "line are listed as avoided. NO_ROUTE if no valid path exists.",
            OptimizationGoal.MINIMIZE_DISTANCE, FlightMode.NORMAL,
        ),
        ScenarioConfig(
            Scenario.EMERGENCY, "Emergency Flight",
            "Minimises estimated travel time between your points. Emergency status grants no airspace "
            "permission: every restriction still applies.",
            OptimizationGoal.MINIMIZE_ETA, FlightMode.EMERGENCY,
        ),
    )
}

assert all(c.respect_restricted_zones for c in SCENARIOS.values()), "hard restrictions apply to every scenario"
