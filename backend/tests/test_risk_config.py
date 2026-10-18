import copy
import json

import pytest

from app.config import COST_MODEL_FILE
from app.routing.risk.config import CostModelError, load_cost_model, validate_altitudes

RAW = json.loads(COST_MODEL_FILE.read_text(encoding="utf-8"))


def write(tmp_path, raw):
    p = tmp_path / "cost_model.json"
    p.write_text(json.dumps(raw), encoding="utf-8")
    return p


def edited(**changes):
    """Copy of the shipped config with dotted-path edits, e.g. {"weights.noise": -1}."""
    raw = copy.deepcopy(RAW)
    for path, value in changes.items():
        *parents, key = path.split(".")
        node = raw
        for p in parents:
            node = node[p]
        node[key] = value
    return raw


def test_shipped_config_is_valid():
    cfg = load_cost_model(COST_MODEL_FILE)
    assert cfg.altitude.default_cruise_m <= cfg.altitude.legal_ceiling_m == 120
    validate_altitudes(cfg, 20, 120, 5)


def test_missing_file_is_a_clear_error(tmp_path):
    with pytest.raises(CostModelError, match="Missing cost model"):
        load_cost_model(tmp_path / "nope.json")


@pytest.mark.parametrize("change, message", [
    ({"weights.noise": -0.1}, "greater than or equal to 0"),
    ({"weights.crowds": 1.0}, "Extra inputs are not permitted"),
    ({"surprise": {}}, "Extra inputs are not permitted"),
    ({"population.hourlyMultiplier": [1.0] * 23}, "at least 24"),
    ({"population.exponent": 0.5}, "greater than or equal to 1"),
    ({"timezone": "Mars/Olympus"}, "unknown timezone"),
    ({"altitude.defaultCruiseM": 130}, "exceeds altitude.legalCeilingM"),
])
def test_invalid_configs_are_rejected(tmp_path, change, message):
    with pytest.raises(CostModelError, match=message):
        load_cost_model(write(tmp_path, edited(**change)))


def test_missing_weight_is_rejected(tmp_path):
    raw = copy.deepcopy(RAW)
    del raw["weights"]["energy"]
    with pytest.raises(CostModelError, match="Field required"):
        load_cost_model(write(tmp_path, raw))


def test_api_altitude_range_above_legal_ceiling_fails_startup(tmp_path):
    cfg = load_cost_model(write(tmp_path, edited(**{"altitude.legalCeilingM": 100})))
    with pytest.raises(CostModelError, match="above the legal ceiling"):
        validate_altitudes(cfg, 20, 120, 5)


@pytest.mark.parametrize("cruise", [15, 82])
def test_default_cruise_must_be_a_valid_request_altitude(tmp_path, cruise):
    cfg = load_cost_model(write(tmp_path, edited(**{"altitude.defaultCruiseM": cruise})))
    with pytest.raises(CostModelError, match="defaultCruiseM"):
        validate_altitudes(cfg, 20, 120, 5)
