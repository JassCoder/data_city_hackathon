"""Simulation session API: sessions, stepping, frames and history, injected events, replay."""

import json

import pytest

from app.dependencies import get_sim_store
from app.sim.engine import SimulationEngine
from app.sim.scenario import Scenario
from app.sim.session import FRAME_FIELDS, STATES, FrameHistory, SimSessionStore, frame_ticks
from app.sim.world import sim_world_beside
from tests.conftest import EAST, WEST, make_planner, make_sim_world
from tests.test_sim_safety import WALL

API = "/api/v1/simulations"
B = {"latitude": EAST[1], "longitude": EAST[0]}
FIELD = {name: i for i, name in enumerate(FRAME_FIELDS)}
OUTSIDE_WARSAW = [[20.70, 52.10], [20.71, 52.10], [20.71, 52.11]]


def raw_scenario(**over) -> dict:
    return {
        "name": "api test", "seed": 1, "startTime": "2026-10-17T14:00:00+02:00",
        "wind": {"speedKmh": 0, "directionDeg": 270},
        "drones": [{"id": "d1", "name": "Courier 1", "position": {"stationId": "st-west"}},
                   {"id": "d2", "position": {"stationId": "st-east"}}],
        "missions": [{"id": "m1", "droneId": "d1", "destination": B, "routeObjective": "SHORTEST",
                      "flightAltitudeMeters": 60, "payloadKg": 0.5}],
        **over,
    }


def api_world(**limits):
    world = make_sim_world()
    world.config = world.config.model_copy(update={"api": world.config.api.model_copy(update=limits)})
    return world


class FakeClock:
    def __init__(self):
        self.now = 1000.0

    def __call__(self):
        return self.now


@pytest.fixture
def scenarios_dir(tmp_path):
    (tmp_path / "basic.json").write_text(json.dumps(raw_scenario()), encoding="utf-8")
    (tmp_path / "broken.json").write_text("{not json", encoding="utf-8")
    return tmp_path


@pytest.fixture
def store(client, overrides, scenarios_dir):
    s = SimSessionStore(api_world, scenarios_dir, clock=FakeClock())
    overrides[get_sim_store] = lambda: s
    return s


def start(client, **body) -> dict:
    r = client.post(API, json=body or {"scenarioId": "basic"})
    assert r.status_code == 201, r.text
    return r.json()


def step(client, sid, ticks, stride=1) -> dict:
    r = client.post(f"{API}/{sid}/step", json={"ticks": ticks, "stride": stride})
    assert r.status_code == 200, r.text
    return r.json()


def row(frame: dict, info: dict, drone_id: str) -> list:
    return frame["d"][[d["id"] for d in info["drones"]].index(drone_id)]


def state_of(frame, info, drone_id) -> str:
    return STATES[row(frame, info, drone_id)[FIELD["state"]]]


# --- pure helpers ---------------------------------------------------------------------------

def test_frame_ticks_are_stride_aligned_and_include_both_ends():
    assert frame_ticks(1, 10, 4) == [1, 4, 8, 10]
    assert frame_ticks(8, 8, 4) == [8]
    assert frame_ticks(5, 4, 1) == []
    assert frame_ticks(1, 3, 1) == [1, 2, 3]


def test_frame_history_is_a_ring_buffer():
    world = make_sim_world()
    e = SimulationEngine.create(Scenario.model_validate(raw_scenario()), world=world)
    drones = [e.drones[i] for i in sorted(e.drones)]
    h = FrameHistory(capacity=5, n_drones=2)
    for t in range(8):
        h.append(t, drones, lambda d: -1)
    assert (h.first_tick, h.last_tick) == (3, 7)
    (f,) = h.frames([7], 1.0)
    assert f["t"] == 7 and len(f["d"]) == 2 and len(f["d"][0]) == len(FRAME_FIELDS)
    assert f["d"][0][:2] == [round(WEST[0], 6), round(WEST[1], 6)]
    with pytest.raises(ValueError):
        h.append(9, drones, lambda d: -1)  # a gap


# --- sessions ---------------------------------------------------------------------------------

def test_lists_valid_scenario_files_only(client, store):
    r = client.get(f"{API}/scenarios")
    assert r.status_code == 200
    assert [s["id"] for s in r.json()] == ["basic"]
    assert r.json()[0] | {"drones": 2, "missions": 1, "name": "api test"} == r.json()[0]


def test_create_returns_everything_the_client_needs(client, store):
    info = start(client)
    assert info["timeS"] == 0 and info["tick"] == 0 and info["finished"] is False
    assert info["states"] == STATES and info["frameFields"] == FRAME_FIELDS
    assert [d["id"] for d in info["drones"]] == ["d1", "d2"] and info["drones"][0]["name"] == "Courier 1"
    assert {s["id"] for s in info["stations"]} == {"st-west", "st-east"}
    assert info["frame"]["t"] == 0 and state_of(info["frame"], info, "d1") == "IDLE"
    assert info["history"] == {"fromS": 0, "toS": 0}
    assert info["initialWind"] == {"speedKmh": 0, "directionDeg": 270}
    assert info["limits"]["maxTicksPerStep"] > 0 and "SIMULATION ONLY" in info["note"]
    assert client.get(f"{API}/{info['id']}").json()["id"] == info["id"]


def test_create_validation(client, store):
    assert client.post(API, json={}).status_code == 422
    assert client.post(API, json={"scenarioId": "basic", "scenario": raw_scenario()}).status_code == 422
    assert client.post(API, json={"scenarioId": "nope"}).status_code == 404
    assert client.post(API, json={"scenarioId": "../basic"}).status_code == 404
    assert client.post(API, json={"scenarioId": "broken"}).status_code == 422
    bad = raw_scenario(drones=[{"id": "d1", "position": {"stationId": "no-such-pad"}}], missions=[])
    r = client.post(API, json={"scenario": bad})
    assert r.status_code == 422 and "no-such-pad" in r.json()["detail"]
    info = start(client, scenario=raw_scenario(), seed=99)
    assert info["seed"] == 99 and info["scenario"]["id"] is None


def test_step_returns_strided_frames_new_events_and_new_routes(client, store):
    info = start(client)
    sid = info["id"]
    first = step(client, sid, 10, stride=4)
    assert [f["t"] for f in first["frames"]] == [1, 4, 8, 10] and first["timeS"] == 10
    assert [e["type"] for e in first["events"]][:2] == ["MISSION_ASSIGNED", "STATE_CHANGED"]
    assert first["routes"] == [] and first["history"] == {"fromS": 0, "toS": 10}

    second = step(client, sid, 90)  # loading ends at 60 s: take-off with the outbound route
    assert second["events"][0]["seq"] == len(first["events"])  # only new events
    (route,) = second["routes"]
    assert route["droneId"] == "d1" and route["kind"] == "outbound" and route["index"] == 0
    assert route["path"][0] == pytest.approx([WEST[0], WEST[1]], abs=1e-5)  # [lon, lat]
    assert len(route["cumM"]) == len(route["path"]) and route["cumM"][0] == 0
    last = second["frames"][-1]
    d1 = row(last, info, "d1")
    assert state_of(last, info, "d1") == "CRUISE" and d1[FIELD["route"]] == 0
    assert 0 < d1[FIELD["progressM"]] < route["cumM"][-1] and d1[FIELD["altitudeM"]] == 60
    assert row(last, info, "d2")[FIELD["route"]] == -1

    later = step(client, sid, 10)
    assert later["routes"] == []  # already sent


def test_step_limits_and_unknown_sessions(client, store):
    sid = start(client)["id"]
    assert client.post(f"{API}/{sid}/step", json={"ticks": 0}).status_code == 422
    too_many = store.limits.max_ticks_per_step + 1
    r = client.post(f"{API}/{sid}/step", json={"ticks": too_many})
    assert r.status_code == 422 and "at most" in r.json()["detail"]
    assert client.post(f"{API}/nope/step", json={"ticks": 1}).status_code == 404
    assert client.get(f"{API}/nope").status_code == 404


# --- injected events ---------------------------------------------------------------------------

def test_a_drawn_zone_makes_the_drone_replan_and_expires_after_its_duration(client, store):
    info = start(client)
    sid = info["id"]
    step(client, sid, 100)
    r = client.post(f"{API}/{sid}/events", json={"type": "zone", "polygon": WALL[:-1], "upperM": 120, "durationS": 40})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["zone"]["id"] == "drawn-1" and body["zone"]["name"] == "Drawn zone 1" and body["zone"]["drawn"]
    assert body["zone"]["geometry"]["type"] == "Polygon"
    act, deact = body["scheduled"]
    assert (act["type"], act["atS"], act["upperM"]) == ("zone_activate", 100, 120)
    assert act["polygon"][0] == act["polygon"][-1]  # closed automatically
    assert (deact["type"], deact["atS"], deact["zoneId"]) == ("zone_deactivate", 140, "drawn-1")

    out = step(client, sid, 50)
    kinds = [(e["type"], e["details"].get("kind")) for e in out["events"]]
    assert ("SCENARIO_EVENT", "zone_activate") in kinds and ("SCENARIO_EVENT", "zone_deactivate") in kinds
    (re,) = [e for e in out["events"] if e["type"] == "REPLANNED"]
    assert re["droneId"] == "d1" and re["details"]["zoneIds"] == ["drawn-1"] and re["tS"] == 100
    assert len(out["routes"]) == 1 and out["routes"][0]["kind"] == "outbound"  # the new route
    assert any(z["id"] == "drawn-1" for z in client.get(f"{API}/{sid}").json()["zones"])


@pytest.mark.parametrize("change, message", [
    ({"polygon": [[21.004, 52.230], [21.006, 52.235], [21.006, 52.230], [21.004, 52.235]]}, "crosses itself"),
    ({"polygon": OUTSIDE_WARSAW}, "outside Warsaw"),
    ({"upperM": 10_000}, "altitude cap"),
    ({"durationS": 10**7}, "duration"),
    ({"upperM": 10, "lowerM": 20}, None),
    ({"polygon": [[21.004, 52.230], [21.006, 52.235]]}, None),
])
def test_invalid_zones_are_rejected(client, store, change, message):
    sid = start(client)["id"]
    cmd = {"type": "zone", "polygon": WALL[:-1], "upperM": 120, "durationS": 60, **change}
    r = client.post(f"{API}/{sid}/events", json=cmd)
    assert r.status_code == 422
    if message:
        assert message in r.json()["detail"]


def test_too_many_corners_are_rejected(client, overrides, scenarios_dir):
    s = SimSessionStore(lambda: api_world(zone_max_vertices=4), scenarios_dir)
    overrides[get_sim_store] = lambda: s
    sid = start(client)["id"]
    five = [[21.004, 52.230], [21.006, 52.230], [21.007, 52.233], [21.006, 52.235], [21.004, 52.235]]
    r = client.post(f"{API}/{sid}/events", json={"type": "zone", "polygon": five, "upperM": 120, "durationS": 60})
    assert r.status_code == 422 and "at most 4 corners" in r.json()["detail"]


def test_failing_a_drone_only_works_while_it_flies(client, store):
    info = start(client)
    sid = info["id"]
    r = client.post(f"{API}/{sid}/events", json={"type": "drone_failure", "droneId": "d1"})
    assert r.status_code == 409 and "only a flying drone" in r.json()["detail"]
    assert client.post(f"{API}/{sid}/events", json={"type": "drone_failure", "droneId": "zz"}).status_code == 404
    step(client, sid, 100)
    r = client.post(f"{API}/{sid}/events", json={"type": "drone_failure", "droneId": "d1"})
    assert r.status_code == 200 and r.json()["scheduled"][0]["type"] == "drone_failure"
    out = step(client, sid, 2)
    types = [e["type"] for e in out["events"] if e["droneId"] == "d1"]
    assert types == ["SCENARIO_EVENT", "FAILURE", "MISSION_ABORTED", "STATE_CHANGED"]
    assert state_of(out["frames"][-1], info, "d1") == "FAILED"
    assert row(out["frames"][-1], info, "d1")[FIELD["route"]] == -1


def test_wind_change(client, store):
    sid = start(client)["id"]
    r = client.post(f"{API}/{sid}/events", json={"type": "wind", "speedKmh": 25, "directionDeg": 90})
    assert r.status_code == 200
    out = step(client, sid, 1)
    (w,) = [e for e in out["events"] if e["details"].get("kind") == "wind_change"]
    assert w["details"]["speedKmh"] == 25 and out["wind"]["directionDeg"] == 90
    too_strong = store.limits.wind_max_kmh + 1
    assert client.post(f"{API}/{sid}/events", json={"type": "wind", "speedKmh": too_strong,
                                                    "directionDeg": 0}).status_code == 422
    assert client.post(f"{API}/{sid}/events", json={"type": "wind", "speedKmh": 5,
                                                    "directionDeg": 360}).status_code == 422
    assert client.post(f"{API}/{sid}/events", json={"type": "teleport"}).status_code == 422


def test_a_session_with_injected_events_replays_exactly(client, store):
    sid = start(client)["id"]
    step(client, sid, 100)
    client.post(f"{API}/{sid}/events", json={"type": "zone", "polygon": WALL[:-1], "upperM": 120, "durationS": 300})
    step(client, sid, 20)
    client.post(f"{API}/{sid}/events", json={"type": "wind", "speedKmh": 12, "directionDeg": 200})
    step(client, sid, 280)
    log = client.get(f"{API}/{sid}/events").json()["events"]
    assert [e["seq"] for e in log] == list(range(len(log)))

    replay = client.get(f"{API}/{sid}/scenario").json()
    assert [e["type"] for e in replay["events"]] == ["zone_activate", "zone_deactivate", "wind_change"]
    again = SimulationEngine.create(Scenario.model_validate(replay), world=make_sim_world())
    again.run_until(400)
    assert again.get_event_log() == log
    assert client.get(f"{API}/{sid}/events", params={"fromSeq": 3}).json()["events"] == log[3:]


# --- history, details, reset, lifecycle ---------------------------------------------------------

def test_history_returns_stored_frames_and_coarsens_large_requests(client, overrides, scenarios_dir):
    s = SimSessionStore(lambda: api_world(history_max_frames=100, history_max_frames_per_request=10), scenarios_dir)
    overrides[get_sim_store] = lambda: s
    info = start(client)
    sid = info["id"]
    step(client, sid, 150)
    h = client.get(f"{API}/{sid}/history", params={"fromS": 60, "toS": 80, "stride": 5}).json()
    assert [f["t"] for f in h["frames"]] == [60, 65, 70, 75, 80] and h["stride"] == 5
    assert h["available"] == {"fromS": 51, "toS": 150}  # only the newest 100 frames are kept
    assert h["frames"][0] == client.get(f"{API}/{sid}/history", params={"fromS": 60, "toS": 60}).json()["frames"][0]
    old = client.get(f"{API}/{sid}/history", params={"fromS": 0, "toS": 40}).json()
    assert old["frames"] == []
    coarse = client.get(f"{API}/{sid}/history", params={"fromS": 51, "toS": 150}).json()
    assert coarse["stride"] == 10 and len(coarse["frames"]) <= 12


def test_drone_details_compare_planned_and_actual_energy(client, store):
    info = start(client)
    sid = info["id"]
    step(client, sid, 100)
    r = client.get(f"{API}/{sid}/drones/d1")
    assert r.status_code == 200
    body = r.json()
    assert body["drone"]["state"] == "CRUISE" and body["missionActive"] is True
    m = body["mission"]
    assert m["id"] == "m1" and set(m["breakdowns"]) == {"outbound", "return"}
    assert m["breakdowns"]["outbound"]["energyWh"] > 0 and m["breakdowns"]["outbound"]["terms"]
    en = body["energy"]
    assert en["plannedWh"] > en["usedWh"] > 0 and en["toFinishWh"] > 0
    assert en["projectedWh"] == pytest.approx(en["usedWh"] + en["toFinishWh"], abs=0.02)
    assert en["projectedWh"] == pytest.approx(en["plannedWh"], rel=0.05)  # calm wind: flies as planned

    step(client, sid, 600)  # delivered, landed: the last mission is still reported
    done = client.get(f"{API}/{sid}/drones/d1").json()
    assert done["missionActive"] is False and done["mission"]["status"] == "COMPLETED"
    assert done["energy"]["toFinishWh"] is None and done["missions"][0]["energyUsedWh"] > 0
    assert client.get(f"{API}/{sid}/drones/zz").status_code == 404
    assert client.get(f"{API}/{sid}/drones/d2").json()["mission"] is None


def test_reset_goes_back_to_zero_and_drops_injected_events(client, store):
    info = start(client)
    sid = info["id"]
    step(client, sid, 100)
    client.post(f"{API}/{sid}/events", json={"type": "wind", "speedKmh": 12, "directionDeg": 200})
    r = client.post(f"{API}/{sid}/reset")
    assert r.status_code == 200
    again = r.json()
    assert again["timeS"] == 0 and again["events"] == [] and again["routes"] == []
    assert again["history"] == {"fromS": 0, "toS": 0} and again["frame"] == info["frame"]
    assert client.get(f"{API}/{sid}/scenario").json().get("events", []) == []


def test_delete_ends_a_session(client, store):
    sid = start(client)["id"]
    assert client.delete(f"{API}/{sid}").status_code == 204
    assert client.get(f"{API}/{sid}").status_code == 404
    assert client.delete(f"{API}/{sid}").status_code == 404


def test_the_least_recently_used_session_is_dropped_beyond_the_limit(client, overrides, scenarios_dir):
    s = SimSessionStore(lambda: api_world(max_sessions=2), scenarios_dir)
    overrides[get_sim_store] = lambda: s
    a, b = start(client)["id"], start(client)["id"]
    client.get(f"{API}/{a}")  # a is now more recent than b
    c = start(client)["id"]
    assert len(s) == 2
    assert client.get(f"{API}/{b}").status_code == 404
    assert client.get(f"{API}/{a}").status_code == 200 and client.get(f"{API}/{c}").status_code == 200


def test_idle_sessions_expire(client, store):
    sid = start(client)["id"]
    store._clock.now += store.limits.idle_timeout_s + 1
    r = client.get(f"{API}/{sid}")
    assert r.status_code == 404 and "expired" in r.json()["detail"]


def test_simulated_zones_never_reach_the_routing_planner():
    api_planner = make_planner()
    provider = api_planner.airspace.provider
    world = sim_world_beside(api_planner, make_sim_world().config)
    assert world.planner.airspace is not api_planner.airspace
    assert world.planner.grid is api_planner.grid and world.planner.risk is api_planner.risk  # shared, not reloaded
    world.stations = make_sim_world().stations
    world.profiles = make_sim_world().profiles
    e = SimulationEngine.create(Scenario.model_validate(raw_scenario(events=[
        {"atS": 1, "type": "zone_activate", "zoneId": "z1", "name": "Incident", "polygon": WALL, "upperM": 120}])),
        world=world)
    e.run_until(5)
    assert "z1" in e.active_zones
    assert api_planner.airspace.provider is provider
    assert all(z.id != "z1" for z in api_planner.airspace.refresh().zones)
