"""Routing scenarios are configuration only: every scenario routes between the
submitted start and destination with the one shared A* engine and all hard
airspace restrictions."""

import pytest
from shapely.geometry import LineString, shape

from app.dependencies import get_planner
from app.routing.scenarios import SCENARIOS, Scenario
from tests.conftest import EAST, WEST, lon_box, make_planner, zone

URL = "/api/v1/routes/calculate"
ALL = [s.value for s in Scenario]

CENTRALNA = {"latitude": 52.22882, "longitude": 21.00316}
STADION = {"latitude": 52.23977, "longitude": 21.04544}
# A completely different pair (Wola -> Praga-Południe)
WOLA = {"latitude": 52.2365, "longitude": 20.9634}
PRAGA = {"latitude": 52.2398, "longitude": 21.0828}
SEJM_WEST = {"latitude": 52.2255, "longitude": 21.0205}
SEJM_EAST = {"latitude": 52.2250, "longitude": 21.0370}


def body(start=CENTRALNA, dest=STADION, **over):
    return {"start": start, "destination": dest, "flightAltitudeMeters": 80,
            "droneProfileId": "DEMO_DRONE_01", "weatherMode": "SAMPLE", **over}


def route(client, **kw):
    res = client.post(URL, json=body(**kw))
    assert res.status_code == 200, res.text
    return res.json()


def ends(r):
    c = r["geometry"]["coordinates"]
    return c[0], c[-1]


def as_lonlat(p):
    return [p["longitude"], p["latitude"]]


@pytest.mark.parametrize("scenario", ALL)
def test_each_scenario_uses_the_submitted_coordinates(client, scenario):
    r = route(client, scenario=scenario)
    assert r["status"] == "OK"
    assert r["scenario"] == scenario and r["scenarioDisplayName"] == SCENARIOS[Scenario(scenario)].display_name
    assert r["start"] == CENTRALNA and r["destination"] == STADION  # echoed unchanged
    first, last = ends(r)
    assert first == pytest.approx(as_lonlat(CENTRALNA), abs=1e-6)
    assert last == pytest.approx(as_lonlat(STADION), abs=1e-6)


def test_changing_scenario_never_changes_endpoints(client):
    seen = {s: ends(route(client, scenario=s)) for s in ALL}
    starts = {tuple(round(v, 6) for v in e[0]) for e in seen.values()}
    dests = {tuple(round(v, 6) for v in e[1]) for e in seen.values()}
    assert len(starts) == 1 and len(dests) == 1


@pytest.mark.parametrize("scenario", ALL)
def test_changing_point_a_changes_the_route(client, scenario):
    a = route(client, scenario=scenario)
    b = route(client, scenario=scenario, start=WOLA)
    assert b["start"] == WOLA
    assert ends(b)[0] == pytest.approx(as_lonlat(WOLA), abs=1e-6)
    assert a["geometry"]["coordinates"] != b["geometry"]["coordinates"]


@pytest.mark.parametrize("scenario", ALL)
def test_changing_point_b_changes_the_route(client, scenario):
    a = route(client, scenario=scenario)
    b = route(client, scenario=scenario, dest=PRAGA)
    assert b["destination"] == PRAGA
    route_destination = b["routeDestination"]
    assert ends(b)[1] == pytest.approx(as_lonlat(route_destination), abs=1e-6)
    assert route_destination == PRAGA or b["warnings"]
    assert a["geometry"]["coordinates"] != b["geometry"]["coordinates"]


@pytest.mark.parametrize("scenario", ALL)
def test_every_scenario_avoids_prohibited_polygons(client, scenario):
    zones = client.get("/api/v1/zones", params={"altitudeM": 80}).json()["zones"]
    obstacles = [shape(z["geojsonGeometry"]) for z in zones if z["evaluation"]["isObstacle"]]
    straight = LineString([as_lonlat(SEJM_WEST), as_lonlat(SEJM_EAST)])
    assert any(straight.intersects(o) for o in obstacles)  # the direct line would cross -P-SEJM
    r = route(client, scenario=scenario, start=SEJM_WEST, dest=SEJM_EAST)
    assert r["status"] == "OK"
    line = LineString(r["geometry"]["coordinates"])
    assert not any(line.intersects(o) for o in obstacles)
    assert any(c["relation"] == "DIRECT_LINE_BLOCKED" for c in r["zoneConflicts"])


@pytest.mark.parametrize("scenario", ALL)
def test_every_scenario_keeps_hard_restrictions(client, overrides, scenario):
    wall = lon_box(21.0045, 52.2290, 21.0055, 52.2370)  # prohibited wall across the whole test area
    overrides[get_planner] = lambda: make_planner(zones=[zone("P", wall)])
    r = route(client, scenario=scenario, start={"longitude": WEST[0], "latitude": WEST[1]},
              dest={"longitude": EAST[0], "latitude": EAST[1]})
    assert r["status"] == "NO_ROUTE" and r["geometry"] is None
    assert "No route found" in r["message"]


@pytest.mark.parametrize("scenario", ALL)
def test_no_route_is_reported_meaningfully(client, scenario):
    courtyard = {"latitude": 52.25549, "longitude": 21.04532}  # enclosed by buildings >= 10 m
    hospital = {"latitude": 52.2300, "longitude": 20.9930}
    r = route(client, scenario=scenario, start=courtyard, dest=hospital, flightAltitudeMeters=20)
    assert r["status"] == "NO_ROUTE" and r["geometry"] is None
    assert "buildings at or above" in r["message"] and r["start"] == courtyard


@pytest.mark.parametrize("missing", [["start"], ["destination"], ["start", "destination"]])
def test_missing_endpoints_are_validation_errors(client, missing):
    b = body(scenario="BLOOD_DELIVERY")
    for k in missing:
        b.pop(k)
    res = client.post(URL, json=b)
    assert res.status_code == 422
    assert {e["loc"][-1] for e in res.json()["detail"]} >= set(missing)


def test_scenario_resolves_its_optimisation(client):
    expected = {"NORMAL": "CORRIDORS", "BLOOD_DELIVERY": "FASTEST", "AED_DELIVERY": "FASTEST",
                "AVOID_PROHIBITED_ZONE": "SHORTEST", "EMERGENCY": "FASTEST"}
    for s, objective in expected.items():
        r = route(client, scenario=s)
        assert r["routeObjective"] == objective
    assert route(client, scenario="EMERGENCY")["mode"] == "EMERGENCY"


def test_scenarios_with_the_same_goal_give_the_same_route(client):
    # Honest result: BLOOD, AED and EMERGENCY all minimise ETA under the same rules.
    geoms = {s: route(client, scenario=s)["geometry"]["coordinates"]
             for s in ("BLOOD_DELIVERY", "AED_DELIVERY", "EMERGENCY")}
    assert geoms["BLOOD_DELIVERY"] == geoms["AED_DELIVERY"] == geoms["EMERGENCY"]


def test_recommended_profile_is_suggested_not_applied(client):
    r = route(client, scenario="BLOOD_DELIVERY")
    assert r["droneProfileId"] == "DEMO_DRONE_01"  # user's choice kept
    assert any("suggested" in w and "Delivery Drone" in w for w in r["warnings"])


def test_explicit_conflicting_settings_are_rejected(client):
    assert client.post(URL, json=body(scenario="EMERGENCY", mode="NORMAL")).status_code == 422
    assert client.post(URL, json=body(scenario="NORMAL", routeObjective="FASTEST")).status_code == 422
    ok = client.post(URL, json=body(scenario="EMERGENCY", mode="EMERGENCY", routeObjective="FASTEST"))
    assert ok.status_code == 200


def test_unknown_scenario_rejected(client):
    assert client.post(URL, json=body(scenario="SIGHTSEEING")).status_code == 422


def test_requests_without_scenario_still_work(client):
    r = route(client, mode="EMERGENCY", routeObjective="SHORTEST")
    assert r["scenario"] is None and r["scenarioDisplayName"] == "Custom settings"
    assert r["mode"] == "EMERGENCY" and r["routeObjective"] == "SHORTEST"


def test_scenarios_endpoint_contains_no_coordinates(client):
    res = client.get("/api/v1/scenarios").json()
    assert [s["id"] for s in res["scenarios"]] == ALL
    for s in res["scenarios"]:
        assert s["respectRestrictedZones"] is True
        assert not any(k in s for k in ("start", "destination", "latitude", "longitude", "coordinates"))
