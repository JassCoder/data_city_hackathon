"""Simulation sessions: start a scenario, step it, add events while it runs, read its history.

The client sets the pace (POST /step); simulated time never runs on the server's clock.
Airspace is DEMO/synthetic: a simulated flight is not a flight authorization.
"""

from typing import Annotated

from fastapi import APIRouter, Body, Depends, HTTPException, Query, Response
from fastapi.responses import JSONResponse
from pydantic import Field, model_validator
from starlette.concurrency import run_in_threadpool

from app.dependencies import get_sim_store
from app.schemas.common import CamelModel
from app.sim.scenario import Scenario, ScenarioError
from app.sim.session import Command, CommandRejected, SimSessionStore

router = APIRouter(prefix="/simulations", tags=["simulation"])
Store = Annotated[SimSessionStore, Depends(get_sim_store)]


class CreateSimulationRequest(CamelModel):
    scenario_id: str | None = None  # a file in data/sim_scenarios (GET /simulations/scenarios)
    scenario: Scenario | None = None  # or a whole scenario
    seed: int | None = None  # default: the scenario's seed

    @model_validator(mode="after")
    def _one_source(self):
        if (self.scenario_id is None) == (self.scenario is None):
            raise ValueError("send exactly one of scenarioId or scenario")
        return self


class StepRequest(CamelModel):
    ticks: int = Field(ge=1)  # simulated ticks to advance (at most limits.maxTicksPerStep)
    stride: int = Field(1, ge=1)  # return every n-th tick's frame (the last one always)


def _fail(exc: Exception) -> HTTPException:
    if isinstance(exc, CommandRejected):
        return HTTPException(exc.status, exc.message)
    return HTTPException(422, str(exc))


async def _run(fn):
    """Engine work runs in a worker thread so the event loop stays free."""
    try:
        return JSONResponse(await run_in_threadpool(fn))
    except (CommandRejected, ScenarioError) as exc:
        raise _fail(exc) from exc


@router.get("/scenarios", summary="Scenario files that can be simulated")
def list_scenarios(store: Store) -> list[dict]:
    return store.scenarios()


@router.post("", status_code=201, summary="Start a simulation session (at time 0, paused)")
async def create_simulation(body: CreateSimulationRequest, store: Store):
    def go():
        scenario = body.scenario or store.scenario(body.scenario_id)
        session = store.create(scenario, body.seed, body.scenario_id)
        with store.use(session.id) as s:
            return s.info()

    response = await _run(go)
    response.status_code = 201
    return response


@router.get("/{sid}", summary="Everything a client needs to show the session (also after a reconnect)")
async def get_simulation(sid: str, store: Store):
    def go():
        with store.use(sid) as s:
            return s.info()

    return await _run(go)


@router.post("/{sid}/step", summary="Advance the simulation; returns frames, new events and new routes")
async def step_simulation(sid: str, body: StepRequest, store: Store):
    def go():
        with store.use(sid) as s:
            return s.step(body.ticks, body.stride)

    return await _run(go)


@router.post("/{sid}/events", summary="Add a zone, a wind change or a drone failure now (applied next tick)")
async def inject_event(sid: str, command: Annotated[Command, Body()], store: Store):
    def go():
        with store.use(sid) as s:
            return s.inject(command)

    return await _run(go)


@router.get("/{sid}/events", summary="The event log from a sequence number on")
async def list_events(sid: str, store: Store, from_seq: Annotated[int, Query(alias="fromSeq", ge=0)] = 0):
    def go():
        with store.use(sid) as s:
            return s.events_since(from_seq)

    return await _run(go)


@router.get("/{sid}/history", summary="Stored frames between two simulated times (for the timeline)")
async def get_history(
    sid: str,
    store: Store,
    from_s: Annotated[float, Query(alias="fromS", ge=0)],
    to_s: Annotated[float, Query(alias="toS", ge=0)],
    stride: Annotated[int, Query(ge=1)] = 1,
):
    def go():
        with store.use(sid) as s:
            return s.history_frames(from_s, to_s, stride)

    return await _run(go)


@router.get("/{sid}/drones/{drone_id}", summary="One drone's mission, planned vs actual energy, cost breakdown")
async def get_drone(sid: str, drone_id: str, store: Store):
    def go():
        with store.use(sid) as s:
            return s.drone_detail(drone_id)

    return await _run(go)


@router.get("/{sid}/scenario", summary="The scenario plus every added event: running it repeats this session")
async def get_replay_scenario(sid: str, store: Store):
    def go():
        with store.use(sid) as s:
            return s.replay_scenario()

    return await _run(go)


@router.post("/{sid}/reset", summary="Back to time 0 (added events are dropped)")
async def reset_simulation(sid: str, store: Store):
    def go():
        with store.use(sid) as s:
            return s.reset()

    return await _run(go)


@router.delete("/{sid}", status_code=204, summary="End a session")
def delete_simulation(sid: str, store: Store) -> Response:
    if not store.delete(sid):
        raise HTTPException(404, "this simulation session has ended or expired")
    return Response(status_code=204)
