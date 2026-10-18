"""SAFEST objective inside the citywide planner (synthetic world, no real data)."""

from datetime import datetime, timezone

import pytest
from shapely.geometry import LineString

from app.routing.costs import FlightMode, RouteObjective
from app.routing.grid import lonlat_to_xy, to_metres
from app.schemas.planning import RouteStatus
from tests.conftest import CALM, COST_MODEL, EAST, NOW, PROFILE, WEST, lon_box, make_planner, zone

SAFEST = RouteObjective.SAFEST
WALL = lon_box(21.0045, 52.2300, 21.0055, 52.2350)  # open at the northern edge
TALL = lon_box(21.0045, 52.2290, 21.0055, 52.2370)  # spans the whole test area


def cells_of(*lonlat):
    grid = make_planner().grid
    return [grid.cell_of(*lonlat_to_xy(lon, lat)) for lon, lat in lonlat]


(WR, WC), (_, EC) = cells_of(WEST, EAST)
CROWD = (slice(WR - 4, WR + 5), slice(WC + 8, EC - 8))  # straddles the straight WEST-EAST line


def weights(**w):
    return COST_MODEL.model_copy(update={"weights": COST_MODEL.weights.model_copy(update=w)})


def plan(planner, objective=SAFEST, weather=CALM, mode=FlightMode.NORMAL, profile=PROFILE, at=NOW, payload=None):
    return planner.plan(WEST, EAST, mode, 80, profile, weather, at, objective, payload)


def line(r):
    return LineString([lonlat_to_xy(*c) for c in r.path_lonlat])


def crosses_crowd(r, planner):
    grid = planner.grid
    rs, cs = CROWD
    x0, y0 = grid.min_x + cs.start * grid.cell, grid.min_y + rs.start * grid.cell
    x1, y1 = grid.min_x + cs.stop * grid.cell, grid.min_y + rs.stop * grid.cell
    return line(r).intersects(LineString([(x0, y0), (x1, y0), (x1, y1), (x0, y1), (x0, y0)]).convex_hull)


def test_crowd_weight_zero_goes_through_and_high_weight_detours():
    world = {"crowded": [(CROWD, 700.0)]}
    through = make_planner(world=world, cost_model=weights(population=0.0))
    around = make_planner(world=world, cost_model=weights(population=10.0))
    r0, r1 = plan(through), plan(around)
    assert r0.status == r1.status == RouteStatus.OK
    assert crosses_crowd(r0, through) and not crosses_crowd(r1, around)
    assert r1.distance_m > r0.distance_m
    assert r1.breakdown.population_exposure < r0.breakdown.population_exposure


@pytest.mark.parametrize("mode", list(FlightMode))
@pytest.mark.parametrize("category", ["DRA-P", "DRA-R", "DRA-RH", "DRA-T", "DRA-U", "UNKNOWN"])
def test_obstacle_zones_stay_blocked_even_when_the_crowd_fills_the_gap(category, mode):
    # The only gap around the zone is crowded: SAFEST must still take it, never the zone.
    world = {"crowded": [((slice(WR + 6, 27), slice(0, 27)), 2000.0)]}
    planner = make_planner(zones=[zone("Z", WALL, category=category)], world=world,
                           cost_model=weights(population=50.0))
    r = plan(planner, mode=mode)
    assert r.status == RouteStatus.OK
    assert not line(r).intersects(to_metres(WALL))


def test_buildings_above_the_ceiling_block_safest():
    planner = make_planner(buildings=[(TALL, 150.0)])
    assert plan(planner).status == RouteStatus.NO_ROUTE
    low = make_planner(buildings=[(TALL, 40.0)])  # 40 m < 80 m - 10 m clearance: flyable
    assert plan(low).status == RouteStatus.OK


def test_wind_above_the_limit_blocks_safest():
    storm = CALM.model_copy(update={"wind_speed_kmh": PROFILE.max_wind_kmh + 5})
    assert plan(make_planner(), weather=storm).status == RouteStatus.BLOCKED_WEATHER


def test_insufficient_battery_is_a_status_with_the_shortfall():
    weak = PROFILE.model_copy(update={"battery_wh": 0.5})
    r = plan(make_planner(), profile=weak)
    assert r.status == RouteStatus.INSUFFICIENT_BATTERY
    assert r.path_lonlat is None and r.breakdown.energy_wh > r.battery_usable_wh
    assert "reserve" in r.message


def test_payload_defaults_and_limits():
    planner = make_planner()
    assert planner.resolve_payload(PROFILE, None) == min(COST_MODEL.energy.default_payload_kg, PROFILE.max_payload_kg)
    with pytest.raises(ValueError):
        planner.resolve_payload(PROFILE, PROFILE.max_payload_kg + 0.1)
    light, heavy = plan(planner, payload=0.0), plan(planner, payload=PROFILE.max_payload_kg)
    assert heavy.breakdown.energy_wh > light.breakdown.energy_wh


def test_every_objective_reports_a_breakdown_and_safest_minimises_it():
    world = {"crowded": [(CROWD, 700.0)], "residential": [CROWD]}
    planner = make_planner(world=world)
    results = {o: plan(planner, objective=o) for o in RouteObjective}
    assert all(r.status == RouteStatus.OK and r.breakdown is not None for r in results.values())
    safest = results[SAFEST].breakdown.total_cost
    # Compared under the same (SAFEST) weights; LOWEST_ENERGY is explained with its own preset.
    # Sampled along the smoothed line, so allow a small tolerance.
    assert all(safest <= r.breakdown.total_cost * 1.02 for o, r in results.items()
               if o != RouteObjective.LOWEST_ENERGY)


def test_departure_time_changes_the_cost_context():
    # Crowd and noise weights 0: the same straight route is evaluated at noon and 01:00 local.
    planner = make_planner(world={"crowded": [(CROWD, 700.0)], "residential": [CROWD]},
                           cost_model=weights(population=0.0, noise=0.0))
    day = plan(planner, at=datetime(2026, 10, 17, 10, 0, tzinfo=timezone.utc))
    night = plan(planner, at=datetime(2026, 10, 17, 23, 0, tzinfo=timezone.utc))
    assert (day.local_hour, night.local_hour) == (12, 1)
    assert day.path_lonlat == night.path_lonlat
    assert night.breakdown.population_exposure < day.breakdown.population_exposure  # fewer people at night
    assert night.breakdown.terms["noise"].mean > day.breakdown.terms["noise"].mean  # noise matters more


# --- risk raster missing: explicit degradation, never a crash ---------------------------------

def degraded_planner():
    from app.routing.risk.osm import grid_only_providers
    from app.routing.risk.surface import CostModel

    planner = make_planner()
    planner.risk = CostModel(COST_MODEL, planner.risk.spec, grid_only_providers(planner.grid),
                             unavailable_reason="Missing risk raster test.npz.")
    return planner


def test_safest_without_risk_data_is_an_explicit_status():
    r = plan(degraded_planner())
    assert r.status == RouteStatus.RISK_DATA_UNAVAILABLE
    assert r.path_lonlat is None and "Missing risk raster" in r.message


def test_other_objectives_still_work_without_risk_data():
    r = plan(degraded_planner(), objective=RouteObjective.CORRIDORS)
    assert r.status == RouteStatus.OK
    assert r.breakdown.energy_wh > 0 and r.breakdown.population_exposure == 0


def test_build_planner_starts_without_the_risk_raster(monkeypatch, tmp_path):
    import app.main as main

    monkeypatch.setattr(main, "RISK_RASTER_FILE", tmp_path / "missing.npz")
    planner = main.build_planner(COST_MODEL)
    assert not planner.risk.data_available and "Missing risk raster" in planner.risk.unavailable_reason


def test_route_cache_distinguishes_cost_models():
    """Regression: swapping the cost model (other weights) must not return a cached route."""
    from app.routing.risk.surface import CostModel

    planner = make_planner(world={"crowded": [(CROWD, 700.0)]}, cost_model=weights(population=0.0))
    through = plan(planner)
    planner.risk = CostModel(weights(population=10.0), planner.risk.spec, planner.risk.providers)
    around = plan(planner)
    assert around.search is not None and not around.search.cached
    assert around.breakdown.population_exposure < through.breakdown.population_exposure


def test_lowest_energy_minimises_energy_in_wind():
    windy = CALM.model_copy(update={"wind_speed_kmh": 30.0, "wind_direction_deg": 0.0})  # from the north
    planner = make_planner(world={"crowded": [(CROWD, 700.0)]})
    results = {o: plan(planner, objective=o, weather=windy) for o in RouteObjective}
    assert all(r.status == RouteStatus.OK for r in results.values())
    lowest = results[RouteObjective.LOWEST_ENERGY].breakdown.energy_wh
    assert all(lowest <= r.breakdown.energy_wh * 1.01 for r in results.values())
    # Only the energy term is weighted.
    terms = results[RouteObjective.LOWEST_ENERGY].breakdown.terms
    assert terms["energy"].weight > 0 and terms["population"].weight == 0


def test_lowest_energy_works_without_the_risk_raster():
    r = plan(degraded_planner(), objective=RouteObjective.LOWEST_ENERGY)
    assert r.status == RouteStatus.OK
