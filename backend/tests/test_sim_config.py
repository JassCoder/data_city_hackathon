"""Simulation config, scenario files and the new drone profile fields."""

import copy
import json

import pytest

from app.config import SIM_CONFIG_FILE, SIM_SCENARIOS_DIR
from app.schemas.planning import DroneProfile
from app.services.drone_profiles import load_drone_profiles
from app.sim.config import AfterDelivery, SimConfigError, load_sim_config
from app.sim.scenario import ScenarioError, ZoneActivateEvent, load_scenario
from tests.conftest import PROFILE

CONFIG = json.loads(SIM_CONFIG_FILE.read_text(encoding="utf-8"))
DEMO = json.loads((SIM_SCENARIOS_DIR / "demo_city.json").read_text(encoding="utf-8"))


def write(tmp_path, raw, name="x.json"):
    p = tmp_path / name
    p.write_text(json.dumps(raw), encoding="utf-8")
    return p


def scenario(**over):
    raw = copy.deepcopy(DEMO)
    raw.update(over)
    return raw


# --- config -------------------------------------------------------------------------------

def test_shipped_config_is_valid():
    cfg = load_sim_config(SIM_CONFIG_FILE)
    assert cfg.tick_s == 1.0 and cfg.after_delivery == AfterDelivery.NEAREST_STATION
    assert cfg.default_profile_id == "DEMO_DRONE_01"


@pytest.mark.parametrize("path, value, message", [
    (("tickS",), 0, "greater than 0"),
    (("durations", "loadingS"), -5, "greater than 0"),
    (("afterDelivery",), "TELEPORT", "Input should be"),
    (("batteryWarningPct",), [20, 30], "descending"),
    (("batteryWarningPct",), [120], "between 0 and 100"),
    (("surprise",), 1, "Extra inputs are not permitted"),
])
def test_invalid_config_is_rejected(tmp_path, path, value, message):
    raw = copy.deepcopy(CONFIG)
    node = raw
    for k in path[:-1]:
        node = node[k]
    node[path[-1]] = value
    with pytest.raises(SimConfigError, match=message):
        load_sim_config(write(tmp_path, raw))


def test_missing_config_is_a_clear_error(tmp_path):
    with pytest.raises(SimConfigError, match="Missing simulation config"):
        load_sim_config(tmp_path / "none.json")


# --- drone profiles -----------------------------------------------------------------------

def test_profiles_carry_simulation_fields_and_the_battery_reserve():
    for p in load_drone_profiles().response.profiles:
        assert p.cruise_speed_mps <= p.max_speed_mps
        assert p.climb_rate_mps > 0 and p.descent_rate_mps > 0 and p.hover_power_w > 0
        assert 0 <= p.reserve_fraction < 1


def test_profile_rejects_cruise_above_max_speed():
    with pytest.raises(ValueError, match="exceeds maxSpeedMps"):
        DroneProfile.model_validate({**PROFILE.model_dump(), "cruise_speed_mps": 30, "max_speed_mps": 20})


# --- scenarios ----------------------------------------------------------------------------

def test_example_scenario_loads():
    s = load_scenario(SIM_SCENARIOS_DIR / "demo_city.json")
    assert s.seed == 42 and len(s.drones) == 3 and len(s.missions) == 3
    assert s.start_time.utcoffset() is not None
    assert s.missions[2].after_delivery == AfterDelivery.STAY_AT_DESTINATION
    assert s.events[0].type == "wind_change"


@pytest.mark.parametrize("over, message", [
    ({"surprise": 1}, "Extra inputs are not permitted"),
    ({"startTime": "2026-10-18T10:00:00"}, "needs a timezone offset"),
    ({"drones": []}, "at least 1"),
    ({"drones": DEMO["drones"] + [DEMO["drones"][0]]}, "duplicate drone ids"),
    ({"missions": [{**DEMO["missions"][0], "droneId": "ghost"}]}, "unknown drone 'ghost'"),
    ({"missions": [{**DEMO["missions"][0], "flightAltitudeMeters": 82}]}, "multiple of 5"),
    ({"missions": [{**DEMO["missions"][0], "flightAltitudeMeters": 150}]}, "less than or equal to 120"),
    ({"events": [{"atS": 5, "type": "meteor"}]}, "does not match any of the expected tags"),
    ({"events": [{"atS": -1, "type": "wind_change", "speedKmh": 3, "directionDeg": 0}]}, "greater than or equal to 0"),
    ({"events": [{"atS": 5, "type": "battery_fault", "droneId": "ghost", "lossPct": 10}]}, "unknown drone 'ghost'"),
    ({"events": [{"atS": 5, "type": "zone_deactivate", "zoneId": "z"}]}, "is not active"),
])
def test_invalid_scenarios_are_rejected_with_a_clear_message(tmp_path, over, message):
    with pytest.raises(ScenarioError, match=message):
        load_scenario(write(tmp_path, scenario(**over), "bad.json"))


def test_drone_without_position_needs_a_mission_start(tmp_path):
    raw = scenario(drones=[{"id": "d1"}], missions=[{**DEMO["missions"][0]}])
    with pytest.raises(ScenarioError, match="needs a position, or its first mission needs a start"):
        load_scenario(write(tmp_path, raw))
    raw["missions"][0]["start"] = {"latitude": 52.23, "longitude": 21.0}
    assert load_scenario(write(tmp_path, raw)).drones[0].position is None


def test_zone_events_need_exactly_one_closed_shape(tmp_path):
    base = {"atS": 10, "type": "zone_activate", "zoneId": "z1", "name": "Incident", "upperM": 120}
    ring = [[21.0, 52.23], [21.01, 52.23], [21.01, 52.24], [21.0, 52.23]]
    ok = load_scenario(write(tmp_path, scenario(events=[{**base, "polygon": ring}])))
    assert isinstance(ok.events[0], ZoneActivateEvent) and ok.events[0].category == "DRA-R"
    with pytest.raises(ScenarioError, match="exactly one of polygon or circle"):
        load_scenario(write(tmp_path, scenario(events=[base])))
    with pytest.raises(ScenarioError, match="must be closed"):
        load_scenario(write(tmp_path, scenario(events=[{**base, "polygon": ring[:-1] + [[21.0, 52.235]]}])))


def test_missing_or_broken_file_is_a_clear_error(tmp_path):
    with pytest.raises(ScenarioError, match="Missing scenario file"):
        load_scenario(tmp_path / "none.json")
    p = tmp_path / "broken.json"
    p.write_text("{ nope", encoding="utf-8")
    with pytest.raises(ScenarioError, match="not valid JSON"):
        load_scenario(p)
