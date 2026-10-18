"""SAFEST objective and cost breakdown through the API, on the real /data files."""

import json

import pytest
from shapely.geometry import LineString, shape

from app.config import AIRSPACE_DEMO_FILE
from tests.test_routes_api import KOPERNIK, URL, body

SEJM_WEST = {"latitude": 52.2255, "longitude": 21.0205}
SEJM_EAST = {"latitude": 52.2250, "longitude": 21.0370}


def test_safest_route_with_breakdown(client):
    r = client.post(URL, json=body(routeObjective="SAFEST")).json()
    assert r["status"] == "OK" and r["routeObjective"] == "SAFEST"
    b = r["costBreakdown"]
    terms = {t["term"]: t for t in b["terms"]}
    assert set(terms) == {"population", "obstacle_proximity", "noise", "emergency_landing", "sensitive_areas",
                          "energy", "time"}
    assert all(0 <= t["mean"] <= 1 and t["cost"] >= 0 for t in terms.values())
    assert b["totalCost"] == pytest.approx(b["lengthM"] + sum(t["cost"] for t in terms.values()), abs=1.0)
    assert 0 < b["energyWh"] < b["batteryUsableWh"]
    assert b["populationExposure"] > 0  # central Warsaw is populated
    assert "not census" in b["note"]
    assert any("not a census" in s for s in r["dataSources"])


def test_breakdown_is_reported_for_other_objectives_and_safest_is_cheapest(client):
    results = {o: client.post(URL, json=body(routeObjective=o)).json() for o in ("CORRIDORS", "SHORTEST", "SAFEST")}
    assert all(r["status"] == "OK" and r["costBreakdown"] for r in results.values())
    safest = results["SAFEST"]["costBreakdown"]["totalCost"]
    assert all(safest <= r["costBreakdown"]["totalCost"] * 1.02 for r in results.values())
    shortest = results["SHORTEST"]["costBreakdown"]
    assert results["SAFEST"]["costBreakdown"]["populationExposure"] < shortest["populationExposure"]


def test_safest_never_enters_the_prohibited_zone(client):
    r = client.post(URL, json=body(start=SEJM_WEST, destination=SEJM_EAST, routeObjective="SAFEST")).json()
    assert r["status"] == "OK"
    zones = json.loads(AIRSPACE_DEMO_FILE.read_text(encoding="utf-8"))["features"]
    sejm = next(shape(z["geometry"]) for z in zones if z["properties"]["id"] == "DEMO-P-SEJM")
    assert not LineString(r["geometry"]["coordinates"]).intersects(sejm)


def test_payload_above_profile_maximum_is_422(client):
    res = client.post(URL, json=body(payloadKg=5.0))  # DEMO_DRONE_01 carries at most 0.5 kg
    assert res.status_code == 422 and "payloadKg" in res.json()["detail"]
    assert client.post(URL, json=body(payloadKg=-1)).status_code == 422


def test_payload_is_echoed_in_the_breakdown(client):
    light = client.post(URL, json=body(payloadKg=0.0)).json()["costBreakdown"]
    heavy = client.post(URL, json=body(payloadKg=0.5)).json()["costBreakdown"]
    assert (light["payloadKg"], heavy["payloadKg"]) == (0.0, 0.5)
    assert heavy["energyWh"] > light["energyWh"]


def test_omitted_altitude_uses_the_cost_model_default(client):
    b = body()
    del b["flightAltitudeMeters"]
    r = client.post(URL, json=b).json()
    assert r["status"] == "OK" and r["flightAltitudeMeters"] == 80  # data/cost_model.json defaultCruiseM


def test_emergency_safest_is_allowed_and_keeps_restrictions(client):
    r = client.post(URL, json=body(start=SEJM_WEST, destination=SEJM_EAST, mode="EMERGENCY",
                                   routeObjective="SAFEST")).json()
    assert r["status"] == "OK"
    assert any(c["relation"] == "DIRECT_LINE_BLOCKED" for c in r["zoneConflicts"])


def test_safest_is_deterministic_across_planners(client):
    """Same inputs on a fresh cost model (no caches) give the identical route."""
    from app.main import app
    from app.routing.risk.surface import CostModel

    planner = app.state.planner
    first = client.post(URL, json=body(routeObjective="SAFEST", destination=KOPERNIK)).json()
    original = planner.risk
    planner.risk = CostModel(original.cfg, original.spec, original.providers)
    planner._route_cache.clear()
    planner._cost_cache.clear()
    try:
        second = client.post(URL, json=body(routeObjective="SAFEST", destination=KOPERNIK)).json()
    finally:
        planner.risk = original
    assert second["search"]["cached"] is False
    assert first["geometry"] == second["geometry"] and first["costBreakdown"] == second["costBreakdown"]
