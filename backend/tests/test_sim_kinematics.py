"""Movement along a leg and the shared energy model (planner == simulation)."""

import math

import pytest

from app.routing.costs import FlightMode, RouteObjective
from app.routing.planner import RoutePlanner
from app.routing.risk.energy import landing_energy_wh, takeoff_energy_wh
from app.schemas.planning import RouteStatus
from app.sim.kinematics import Leg, cruise_step, energy_to_finish_wh, leg_energy_wh
from tests.conftest import CALM, EAST, NOW, PROFILE, WEST, make_planner

DRONE = RoutePlanner.drone_energy(PROFILE)
LINE = [(21.000, 52.233), (21.010, 52.233), (21.020, 52.234)]  # ~1.4 km, roughly eastwards


def calm(x, y):
    return 0.0, 0.0


def from_west(speed_kmh):
    return lambda x, y: (speed_kmh, 270.0)  # blows towards the east


def fly(leg: Leg, wind, payload=0.0, dt=1.0):
    """Ticks until the leg is done; returns (energy Wh, seconds)."""
    energy = t = 0.0
    while not leg.done:
        _, e, _ = cruise_step(DRONE, payload, leg, wind, dt)
        energy += e
        t += dt
    return energy, t


def test_leg_geometry_and_progress():
    leg = Leg.from_lonlat("outbound", "Point B", LINE)
    assert 1300 < leg.length_m < 1500
    _, _, heading = leg.heading_at(0)
    assert heading == pytest.approx(90, abs=1)  # first segment due east
    assert leg.advance(500) == 500 and leg.progress_m == 500
    assert leg.advance(1e6) == pytest.approx(leg.length_m - 500)  # never past the end
    assert leg.done and leg.remaining_m == 0
    lon, lat = leg.lonlat_at(leg.length_m)
    assert (lon, lat) == pytest.approx(LINE[-1], abs=1e-6)


def test_moving_follows_the_polyline_not_the_vertices():
    leg = Leg.from_lonlat("outbound", "Point B", LINE)
    moved, _, g = cruise_step(DRONE, 0.0, leg, calm, 1.0)
    assert moved == pytest.approx(PROFILE.cruise_speed_mps) and g == pytest.approx(PROFILE.cruise_speed_mps)
    lon, lat = leg.lonlat_at(leg.progress_m)
    assert LINE[0][0] < lon < LINE[1][0]  # between the first two vertices
    assert leg.remaining_path()[0] == pytest.approx((lon, lat), abs=1e-9)


def test_headwind_costs_more_energy_than_tailwind_over_the_same_route():
    east = Leg.from_lonlat("outbound", "B", LINE)
    west = Leg.from_lonlat("outbound", "A", list(reversed(LINE)))
    wind = from_west(25)
    e_tail, t_tail = fly(east, wind)
    e_head, t_head = fly(west, wind)
    assert e_head > e_tail * 1.2 and t_head > t_tail
    # The per-tick simulation agrees with the leg-energy prediction used for battery checks.
    assert leg_energy_wh(DRONE, 0.0, Leg.from_lonlat("x", "B", LINE), wind) == pytest.approx(e_tail, rel=0.01)


def test_payload_costs_energy():
    e0, _ = fly(Leg.from_lonlat("o", "B", LINE), calm, payload=0.0)
    e1, _ = fly(Leg.from_lonlat("o", "B", LINE), calm, payload=PROFILE.max_payload_kg)
    assert e1 == pytest.approx(e0 * DRONE.power_w(PROFILE.max_payload_kg) / DRONE.power_w(0), rel=1e-3)


def test_vertical_energy_uses_the_profile_rates_and_powers():
    alt = 80
    assert takeoff_energy_wh(DRONE, 0.5, alt) == pytest.approx(
        (PROFILE.cruise_power_w + 0.5 * PROFILE.payload_power_w_per_kg + PROFILE.climb_extra_power_w)
        * (alt / PROFILE.climb_rate_mps) / 3600)
    assert landing_energy_wh(DRONE, 0.0, alt) == pytest.approx(PROFILE.descent_power_w * (alt / PROFILE.descent_rate_mps) / 3600)
    leg = Leg.from_lonlat("o", "B", LINE)
    assert energy_to_finish_wh(DRONE, 0.0, leg, calm, alt) == pytest.approx(
        leg_energy_wh(DRONE, 0.0, leg, calm) + landing_energy_wh(DRONE, 0.0, alt))


@pytest.mark.parametrize("wind_kmh", [0.0, 25.0])
def test_simulated_cruise_energy_matches_the_planner(wind_kmh):
    weather = CALM.model_copy(update={"wind_speed_kmh": wind_kmh, "wind_direction_deg": 270.0})
    r = make_planner().plan(WEST, EAST, FlightMode.NORMAL, 80, PROFILE, weather, NOW, RouteObjective.SHORTEST, 0.5)
    assert r.status == RouteStatus.OK
    simulated, seconds = fly(Leg.from_lonlat("outbound", "B", r.path_lonlat), from_west(wind_kmh), payload=0.5)
    assert simulated == pytest.approx(r.breakdown.energy_wh, rel=0.01)
    assert seconds == pytest.approx(r.eta_s, abs=1.0)  # same wind triangle, 1 s ticks


def test_planner_battery_check_includes_take_off_and_landing():
    planner = make_planner()
    ok = planner.plan(WEST, EAST, FlightMode.NORMAL, 120, PROFILE, CALM, NOW, RouteObjective.SHORTEST, 0.0)
    cruise, vertical = ok.breakdown.energy_wh, ok.vertical_energy_wh
    assert vertical > 0
    # A battery whose usable part covers the cruise but not the climb and descent.
    usable = cruise + vertical / 2
    weak = PROFILE.model_copy(update={"battery_wh": usable / (1 - PROFILE.reserve_fraction)})
    r = planner.plan(WEST, EAST, FlightMode.NORMAL, 120, weak, CALM, NOW, RouteObjective.SHORTEST, 0.0)
    assert r.status == RouteStatus.INSUFFICIENT_BATTERY
    assert "including take-off and landing" in r.message
    assert math.isclose(r.vertical_energy_wh, vertical)
