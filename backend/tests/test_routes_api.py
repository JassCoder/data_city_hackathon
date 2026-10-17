import httpx
import pytest
from shapely.geometry import LineString, shape

from app.dependencies import get_planner, get_weather
from app.services.weather import WeatherService
from tests.conftest import EAST, WEST, lon_box, make_planner, zone

URL = "/api/v1/routes/calculate"
CENTRALNA = {"latitude": 52.22882, "longitude": 21.00316}
KOPERNIK = {"latitude": 52.24178, "longitude": 21.02860}
STADION = {"latitude": 52.23977, "longitude": 21.04544}


def body(**over):
    b = {
        "start": CENTRALNA,
        "destination": KOPERNIK,
        "mode": "NORMAL",
        "flightAltitudeMeters": 80,
        "droneProfileId": "DEMO_DRONE_01",
        "weatherMode": "DEMO",
    }
    b.update(over)
    return b


def test_calculate_returns_camel_case_route(client):
    res = client.post(URL, json=body())
    assert res.status_code == 200
    r = res.json()
    assert r["status"] == "OK"
    assert r["geometry"]["type"] == "LineString"
    assert len(r["geometry"]["coordinates"]) >= 2
    assert r["distanceM"] > 0 and r["etaS"] > 0
    assert r["flightAltitudeMeters"] == 80 and r["droneProfileId"] == "DEMO_DRONE_01"
    assert r["weather"]["source"] == "DEMO"
    first = r["geometry"]["coordinates"][0]
    assert first == pytest.approx([CENTRALNA["longitude"], CENTRALNA["latitude"]], abs=1e-5)  # lon, lat order
    assert any("DEMO" in s and "Airspace zones" in s for s in r["dataSources"])
    assert r["airspace"]["sourceType"] == "DEMO" and r["airspace"]["datasetVersion"]
    assert r["planningVerificationStatus"].startswith("SIMULATION_ONLY")
    assert isinstance(r["zoneConflicts"], list)


def test_route_never_crosses_obstacle_zones(client):
    for mode in ("NORMAL", "EMERGENCY"):
        for alt in (40, 80):
            zones = client.get("/api/v1/zones", params={"altitudeM": alt}).json()["zones"]
            r = client.post(URL, json=body(mode=mode, destination=STADION, flightAltitudeMeters=alt)).json()
            assert r["status"] == "OK"
            line = LineString(r["geometry"]["coordinates"])
            for z in zones:
                if z["evaluation"]["isObstacle"]:
                    assert not line.intersects(shape(z["geojsonGeometry"])), (mode, alt, z["id"])


def test_changing_destination_changes_route(client):
    a = client.post(URL, json=body()).json()
    b = client.post(URL, json=body(destination=STADION)).json()
    assert a["status"] == b["status"] == "OK"
    assert a["geometry"]["coordinates"] != b["geometry"]["coordinates"]
    assert a["distanceM"] != b["distanceM"]


def test_changing_start_changes_route(client):
    a = client.post(URL, json=body()).json()
    b = client.post(URL, json=body(start={"latitude": 52.2352, "longitude": 21.0385})).json()
    assert a["geometry"]["coordinates"][0] != b["geometry"]["coordinates"][0]


@pytest.mark.parametrize("bad", [
    {"start": {"latitude": "52.2", "longitude": 21.0}},  # string, not number
    {"start": {"latitude": 95.0, "longitude": 21.0}},
    {"destination": {"latitude": 52.2, "longitude": -200.0}},
    {"start": {"latitude": 52.2}},
    {"mode": "TURBO"},
    {"weatherMode": "SOMETIMES"},
    {"routeObjective": "SCENIC"},
    {"flightAltitudeMeters": 10},
    {"flightAltitudeMeters": 125},
    {"flightAltitudeMeters": 82},  # not a 5 m step
    {"flightAltitudeMeters": "80"},
    {"altitudeM": 80},  # unknown/legacy field
    {"destination": CENTRALNA},  # identical points
])
def test_invalid_requests_are_rejected(client, bad):
    assert client.post(URL, json=body(**bad)).status_code == 422


def test_unknown_drone_profile(client):
    res = client.post(URL, json=body(droneProfileId="DEMO_DRONE_99"))
    assert res.status_code == 422
    assert "DEMO_DRONE_99" in res.json()["detail"] and "DEMO_DRONE_01" in res.json()["detail"]


def test_outside_coverage(client):
    r = client.post(URL, json=body(destination={"latitude": 52.0812, "longitude": 21.0240})).json()  # Piaseczno
    assert r["status"] == "OUTSIDE_COVERAGE"
    assert r["geometry"] is None
    assert "outside the supported area" in r["message"] and "Warsaw" in r["message"]
    assert r["coverage"]["valid"] is False


def test_destination_inside_zone(client):
    sejm = {"latitude": 52.2252, "longitude": 21.0283}
    r = client.post(URL, json=body(destination=sejm)).json()
    assert r["status"] == "DESTINATION_BLOCKED" and r["geometry"] is None
    assert "Sejm" in r["message"] and "DRA-P" in r["message"]
    assert r["zoneConflicts"][0]["relation"] == "DESTINATION_INSIDE"
    assert r["zoneConflicts"][0]["zoneId"] == "DEMO-P-SEJM"


def test_unreachable_destination_via_api(client, overrides):
    wall = lon_box(21.0045, 52.2290, 21.0055, 52.2370)
    overrides[get_planner] = lambda: make_planner(zones=[zone("P", wall)])
    req = body(
        start={"longitude": WEST[0], "latitude": WEST[1]},
        destination={"longitude": EAST[0], "latitude": EAST[1]},
    )
    r = client.post(URL, json=req).json()
    assert r["status"] == "NO_ROUTE" and r["geometry"] is None


def test_live_weather_failure_is_explicit(client, overrides):
    def boom(request):
        raise httpx.ConnectError("offline")

    failing = WeatherService(httpx.AsyncClient(transport=httpx.MockTransport(boom)))
    overrides[get_weather] = lambda: failing
    r = client.post(URL, json=body(weatherMode="LIVE")).json()
    assert r["status"] == "OK"
    assert r["weather"]["source"] == "DEMO_FALLBACK" and r["weather"]["liveAvailable"] is False
    assert "Live weather is not available" in r["warnings"][0]

    w = client.get("/api/v1/weather", params={"mode": "LIVE"}).json()
    assert w["source"] == "DEMO_FALLBACK"


def test_live_weather_parsed_from_open_meteo(client, overrides):
    payload = {"hourly": {"time": ["2026-10-17T12:00"], "wind_speed_10m": [40.0], "wind_speed_80m": [50.0],
                          "wind_speed_120m": [56.0], "wind_direction_10m": [90], "wind_direction_80m": [90],
                          "wind_direction_120m": [90], "wind_gusts_10m": [70]}}
    live = WeatherService(httpx.AsyncClient(transport=httpx.MockTransport(lambda r: httpx.Response(200, json=payload))))
    overrides[get_weather] = lambda: live
    r = client.post(URL, json=body(weatherMode="LIVE")).json()
    assert r["weather"]["source"] == "OPEN_METEO" and r["weather"]["windSpeedKmh"] == 50
    assert r["status"] == "BLOCKED_WEATHER"  # 50 km/h > 36 km/h limit of DEMO_DRONE_01


def test_drone_profiles_endpoint(client):
    res = client.get("/api/v1/drone-profiles").json()
    ids = [p["id"] for p in res["profiles"]]
    assert ids == ["DEMO_DRONE_01", "DEMO_DRONE_02"]
    p = res["profiles"][0]
    assert {"cruiseSpeedMps", "maxWindKmh", "verticalClearanceM", "maxRangeKm", "source"} <= p.keys()
    assert p["source"] == "DEMO"


def test_demo_weather_endpoint(client):
    w = client.get("/api/v1/weather").json()
    assert w["mode"] == "DEMO" and w["source"] == "DEMO"


# --- deterministic verification scenario (DEMO zones) ----------------------------

SEJM_WEST = {"latitude": 52.2255, "longitude": 21.0205}
SEJM_EAST = {"latitude": 52.2250, "longitude": 21.0370}


def test_demo_avoidance_scenario_routes_around_prohibited_zone(client):
    sejm = client.get("/api/v1/zones/DEMO-P-SEJM").json()["zone"]
    poly = shape(sejm["geojsonGeometry"])
    straight = LineString([(SEJM_WEST["longitude"], SEJM_WEST["latitude"]), (SEJM_EAST["longitude"], SEJM_EAST["latitude"])])
    assert straight.intersects(poly)  # a straight line would cross the DRA-P zone
    for mode in ("NORMAL", "EMERGENCY"):
        r = client.post(URL, json=body(start=SEJM_WEST, destination=SEJM_EAST, mode=mode)).json()
        assert r["status"] == "OK"
        route = LineString(r["geometry"]["coordinates"])
        assert not route.intersects(poly)
        assert len(r["geometry"]["coordinates"]) > 2
        assert any(c["relation"] == "DIRECT_LINE_BLOCKED" and c["zoneId"] == "DEMO-P-SEJM" for c in r["zoneConflicts"])


def test_demo_no_route_scenario_enclosed_courtyard(client):
    courtyard = {"latitude": 52.25549, "longitude": 21.04532}  # Praga-Północ, enclosed by >=10 m buildings
    hospital = {"latitude": 52.2300, "longitude": 20.9930}
    low = client.post(URL, json=body(start=courtyard, destination=hospital, flightAltitudeMeters=20)).json()
    assert low["status"] == "NO_ROUTE" and low["geometry"] is None
    high = client.post(URL, json=body(start=courtyard, destination=hospital, flightAltitudeMeters=80)).json()
    assert high["status"] == "OK"


# --- zones API --------------------------------------------------------------------

def test_zones_endpoint_lists_evaluated_zones_with_source(client):
    res = client.get("/api/v1/zones").json()
    assert res["source"]["sourceType"] == "DEMO" and "SYNTHETIC" in res["source"]["disclaimer"]
    assert res["source"]["datasetVersion"] and res["flightContext"]["flightAltitudeMeters"] == 80
    z = {z["id"]: z for z in res["zones"]}
    assert z["DEMO-P-SEJM"]["evaluation"]["displayClass"] == "RED"
    assert z["DEMO-RM-PKIN"]["evaluation"]["displayClass"] == "ORANGE"
    assert z["DEMO-I-VISTULA"]["evaluation"]["isObstacle"] is False
    assert z["DEMO-RL-EVENT"]["evaluation"]["status"] == "NOT_ACTIVE_TIME"
    castle = z["DEMO-P-CASTLE"]
    assert castle["circle"]["radiusM"] == 140 and castle["geojsonGeometry"]["type"] == "Polygon"
    for f in ("draCategory", "restrictionType", "source", "sourceTimestamp", "validityStart", "validityEnd",
              "lowerAltitude", "upperAltitude", "altitudeReference", "authorizationRequired",
              "operationalConditions", "verificationStatus"):
        assert f in castle


def test_zones_evaluation_follows_altitude(client):
    at80 = {z["id"]: z for z in client.get("/api/v1/zones", params={"altitudeM": 80}).json()["zones"]}
    at40 = {z["id"]: z for z in client.get("/api/v1/zones", params={"altitudeM": 40}).json()["zones"]}
    assert at80["DEMO-RH-SCHOOL-POWISLE"]["evaluation"]["status"] == "NOT_APPLICABLE_ALTITUDE"
    assert at40["DEMO-RH-SCHOOL-POWISLE"]["evaluation"]["isObstacle"] is True


def test_zones_evaluation_follows_time(client):
    during = client.get("/api/v1/zones/DEMO-RL-EVENT", params={"at": "2026-09-15T12:00:00Z"}).json()
    assert during["zone"]["evaluation"]["isObstacle"] is True


def test_zone_not_found_and_invalid_altitude(client):
    assert client.get("/api/v1/zones/NOPE").status_code == 404
    assert client.get("/api/v1/zones", params={"altitudeM": 83}).status_code == 422


@pytest.mark.parametrize("objective", ["CORRIDORS", "SHORTEST", "FASTEST"])
def test_route_objective_is_echoed_and_respects_zones(client, objective):
    r = client.post(URL, json=body(destination=STADION, routeObjective=objective)).json()
    assert r["status"] == "OK" and r["routeObjective"] == objective
    zones = client.get("/api/v1/zones").json()["zones"]
    line = LineString(r["geometry"]["coordinates"])
    assert not any(line.intersects(shape(z["geojsonGeometry"])) for z in zones if z["evaluation"]["isObstacle"])


def test_shortest_is_never_longer_than_corridors(client):
    corridors = client.post(URL, json=body(destination=STADION)).json()
    shortest = client.post(URL, json=body(destination=STADION, routeObjective="SHORTEST")).json()
    assert shortest["distanceM"] <= corridors["distanceM"] + 1


def test_default_objective_is_corridors(client):
    assert client.post(URL, json=body()).json()["routeObjective"] == "CORRIDORS"
