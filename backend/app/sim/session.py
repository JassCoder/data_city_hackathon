"""Simulation sessions for the API: an engine plus what a client needs to replay it.

The client sets the pace: it asks for the next ticks (step) and gets compact frames, the new
events and any new route geometry. Every tick's frame is kept in a fixed-size ring buffer
(FrameHistory) for the timeline. Commands from the UI become ordinary scenario events at the
current simulated time (engine.inject), so a session can always be replayed exactly.

All sessions share one SimWorld (a planner separate from the routing API's). An engine
re-syncs its zones before every plan, and the store serialises all work on sessions with one
lock, so engines never interleave.

Wire conventions: coordinates are [longitude, latitude] (as in GeoJSON and scenario files);
a frame is {"t": seconds, "d": one row per drone in `drones` order, fields FRAME_FIELDS}.
"""

from __future__ import annotations

import logging
import math
import re
import threading
import time
import uuid
from collections import OrderedDict
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from pathlib import Path
from typing import Annotated, Any, Literal, Union

import numpy as np
from pydantic import Field, NonNegativeFloat, PositiveFloat, model_validator
from shapely.geometry import Polygon

from app.config import DEMO_WEATHER
from app.schemas.common import CamelModel
from app.schemas.planning import Latitude, Longitude
from app.sim.airspace import scenario_zone
from app.sim.config import ApiLimits
from app.sim.drone import Drone
from app.sim.engine import SIMULATION_NOTE, SimulationEngine
from app.sim.scenario import (
    DroneFailureEvent,
    Identifier,
    Scenario,
    ScenarioError,
    WindChangeEvent,
    ZoneActivateEvent,
    ZoneDeactivateEvent,
    load_scenario,
)
from app.sim.states import AIRBORNE, DroneState
from app.sim.world import SimWorld

logger = logging.getLogger(__name__)

STATES = [s.value for s in DroneState]
_STATE_CODE = {s: i for i, s in enumerate(DroneState)}
FRAME_FIELDS = ["longitude", "latitude", "altitudeM", "headingDeg", "speedMps", "batteryPct", "progressM", "state",
                "route"]
_SCENARIO_ID = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
DRAWN_ZONE_PREFIX = "drawn-"


class CommandRejected(Exception):
    """A command that cannot be applied now; `status` is the HTTP status the API answers with."""

    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status
        self.message = message


# --- commands from the UI ----------------------------------------------------------------------

class ZoneCommand(CamelModel):
    """A temporary restricted zone drawn on the map: from lowerM up to the altitude cap upperM."""

    type: Literal["zone"]
    name: str | None = Field(None, min_length=1, max_length=80)
    polygon: list[tuple[Longitude, Latitude]] = Field(min_length=3)  # [lon, lat]; closed automatically
    lower_m: NonNegativeFloat = 0
    upper_m: PositiveFloat
    duration_s: PositiveFloat

    @model_validator(mode="after")
    def _band(self):
        if self.upper_m <= self.lower_m:
            raise ValueError("upperM must be above lowerM")
        return self


class WindCommand(CamelModel):
    type: Literal["wind"]
    speed_kmh: NonNegativeFloat
    direction_deg: float = Field(ge=0, lt=360)  # where it blows from


class DroneFailureCommand(CamelModel):
    type: Literal["drone_failure"]
    drone_id: Identifier


Command = Annotated[Union[ZoneCommand, WindCommand, DroneFailureCommand], Field(discriminator="type")]


def _zone_info(e: ZoneActivateEvent) -> dict[str, Any]:
    z = scenario_zone(e)
    return {"id": e.zone_id, "name": e.name, "category": e.category.value, "lowerM": e.lower_m,
            "upperM": e.upper_m, "drawn": e.zone_id.startswith(DRAWN_ZONE_PREFIX),
            "geometry": z.geojson_geometry}


# --- frame history -----------------------------------------------------------------------------

class FrameHistory:
    """One frame per tick, the newest `capacity` kept, in fixed-size arrays (a ring buffer).

    Frames are written for consecutive ticks from 0, so tick t lives in slot t % capacity.
    """

    def __init__(self, capacity: int, n_drones: int):
        self.capacity = capacity
        self.pos = np.zeros((capacity, n_drones, 2), dtype=np.float64)  # lon, lat
        self.vals = np.zeros((capacity, n_drones, 5), dtype=np.float32)  # alt, heading, speed, battery %, progress
        self.codes = np.zeros((capacity, n_drones, 2), dtype=np.int32)  # state code, route index (-1 = none)
        self.count = 0  # frames written since the last clear = last tick + 1

    def clear(self) -> None:
        self.count = 0

    @property
    def first_tick(self) -> int:
        return max(0, self.count - self.capacity)

    @property
    def last_tick(self) -> int:
        return self.count - 1

    def append(self, tick: int, drones: list[Drone], route_of: Callable[[Drone], int]) -> None:
        if tick != self.count:
            raise ValueError(f"frames must be written for consecutive ticks (expected {self.count}, got {tick})")
        i = tick % self.capacity
        for j, d in enumerate(drones):
            self.pos[i, j] = (d.longitude, d.latitude)
            self.vals[i, j] = (d.altitude_m, d.heading_deg, d.speed_mps, d.battery_pct,
                               d.leg.progress_m if d.leg else 0.0)
            self.codes[i, j] = (_STATE_CODE[d.state], route_of(d))
        self.count += 1

    def frames(self, ticks: list[int], tick_s: float) -> list[dict[str, Any]]:
        if not ticks:
            return []
        slots = np.asarray(ticks) % self.capacity
        pos = np.round(self.pos[slots], 6).tolist()
        v = self.vals[slots].astype(np.float64)
        for col, digits in enumerate((1, 1, 2, 2, 1)):
            v[..., col] = np.round(v[..., col], digits)
        vals = v.tolist()
        codes = self.codes[slots].tolist()
        return [
            {"t": round(t * tick_s, 3), "d": [[*p, *x, *c] for p, x, c in zip(pos[k], vals[k], codes[k])]}
            for k, t in enumerate(ticks)
        ]


def frame_ticks(first: int, last: int, stride: int) -> list[int]:
    """Ticks in [first, last] on multiples of the stride (stable across requests) plus both ends."""
    if first > last:
        return []
    ticks = set(range(first + (-first) % stride, last + 1, stride))
    ticks.update((first, last))
    return sorted(ticks)


# --- a session ---------------------------------------------------------------------------------

class SimSession:
    def __init__(self, sid: str, engine: SimulationEngine, limits: ApiLimits, scenario_id: str | None):
        self.id = sid
        self.engine = engine
        self.limits = limits
        self.scenario_id = scenario_id
        self.drone_ids = sorted(engine.drones)
        self.history = FrameHistory(limits.history_max_frames, len(self.drone_ids))
        self.last_used = 0.0
        self._start_tracking()

    def _start_tracking(self) -> None:
        self.routes: list[dict[str, Any]] = []
        self._route_index: dict[str, int] = {}
        # Every zone the scenario can activate plus every drawn one; which are active when
        # follows from the zone_activate / zone_deactivate events.
        self.zones: dict[str, dict[str, Any]] = {
            e.zone_id: _zone_info(e) for e in self.engine.scenario.events if isinstance(e, ZoneActivateEvent)
        }
        self._drawn = 0
        self.history.clear()
        self._record()

    def _route_of(self, d: Drone) -> int:
        leg = d.leg
        if leg is None:
            return -1
        idx = self._route_index.get(leg.id)
        if idx is None:
            idx = len(self.routes)
            self._route_index[leg.id] = idx
            self.routes.append({"index": idx, "droneId": d.id, **leg.geometry()})
        return idx

    def _record(self) -> None:
        e = self.engine
        self.history.append(e.tick, [e.drones[i] for i in self.drone_ids], self._route_of)

    def _clock(self) -> dict[str, Any]:
        e = self.engine
        return {"tick": e.tick, "timeS": round(e.time_s, 3), "simTime": e._now_dt(e.time_s).isoformat(),
                "finished": e.finished, "history": self._history_range()}

    def _history_range(self) -> dict[str, float]:
        ts = self.engine.tick_s
        return {"fromS": round(self.history.first_tick * ts, 3), "toS": round(self.history.last_tick * ts, 3)}

    # --- public operations ---

    def info(self) -> dict[str, Any]:
        e = self.engine
        sc = e.scenario
        wind = sc.wind
        return {
            "id": self.id,
            "scenario": {"id": self.scenario_id, "name": sc.name, "description": sc.description},
            "seed": e.seed,
            "tickS": e.tick_s,
            "startTime": sc.start_time.isoformat(),
            "note": SIMULATION_NOTE,
            "states": STATES,
            "frameFields": FRAME_FIELDS,
            "drones": [
                {"id": d.id, "name": d.name, "color": d.color, "profileId": d.profile.id,
                 "profileName": d.profile.name, "batteryWh": d.profile.battery_wh,
                 "minReservePct": d.profile.min_reserve_pct}
                for d in (e.drones[i] for i in self.drone_ids)
            ],
            "stations": [{"id": s.id, "name": s.name, "longitude": s.longitude, "latitude": s.latitude,
                          "capacity": s.capacity} for s in e.world.stations],
            "positionToleranceM": e.config.position_tolerance_m,
            "initialWind": {"speedKmh": wind.speed_kmh if wind else DEMO_WEATHER["windSpeedKmh"],
                            "directionDeg": wind.direction_deg if wind else DEMO_WEATHER["windDirectionDeg"]},
            "limits": self.limits.model_dump(mode="json", by_alias=True),
            "routes": self.routes,
            "zones": list(self.zones.values()),
            "events": e.log.to_dicts(),
            "frame": self.history.frames([e.tick], e.tick_s)[0],
            "wind": e.wind.snapshot(),
            **self._clock(),
        }

    def step(self, ticks: int, stride: int = 1) -> dict[str, Any]:
        if ticks > self.limits.max_ticks_per_step:
            raise CommandRejected(422, f"at most {self.limits.max_ticks_per_step} ticks per step")
        e = self.engine
        n_routes, n_events, first = len(self.routes), len(e.log), e.tick + 1
        for _ in range(ticks):
            e.advance(1)
            self._record()
        return {
            "frames": self.history.frames(frame_ticks(first, e.tick, stride), e.tick_s),
            "events": e.log.to_dicts(n_events),
            "routes": self.routes[n_routes:],
            "wind": e.wind.snapshot(),
            **self._clock(),
        }

    def history_frames(self, from_s: float, to_s: float, stride: int = 1) -> dict[str, Any]:
        e, h = self.engine, self.history
        lo = max(h.first_tick, math.ceil(from_s / e.tick_s - 1e-9))
        hi = min(h.last_tick, math.floor(to_s / e.tick_s + 1e-9))
        if hi >= lo and (hi - lo) // stride + 1 > self.limits.history_max_frames_per_request:
            stride = math.ceil((hi - lo + 1) / self.limits.history_max_frames_per_request)
        ticks = frame_ticks(lo, hi, stride)
        return {"stride": stride, "frames": h.frames(ticks, e.tick_s), "available": self._history_range()}

    def events_since(self, seq: int) -> dict[str, Any]:
        return {"events": self.engine.log.to_dicts(max(seq, 0)), **self._clock()}

    def drone_detail(self, drone_id: str) -> dict[str, Any]:
        e = self.engine
        if drone_id not in e.drones:
            raise CommandRejected(404, f"no drone '{drone_id}' in this simulation")
        d = e.drones[drone_id]
        runs = e.missions_run[drone_id]
        current = d.mission or (runs[-1] if runs else None)
        return {
            "drone": {k: v for k, v in d.snapshot().items() if k != "mission"},
            "mission": current.snapshot() if current else None,
            "missionActive": d.mission is not None,
            "energy": e.energy_report(drone_id),
            "missions": [{"id": m.id, "status": m.status.value, "plannedEnergyWh": m.planned_energy_wh,
                          "energyUsedWh": round(m.energy_used_wh, 2)} for m in runs],
            **self._clock(),
        }

    def inject(self, cmd: ZoneCommand | WindCommand | DroneFailureCommand) -> dict[str, Any]:
        """Turns a UI command into scenario events at the current simulated time (applied next tick)."""
        e = self.engine
        now = e.time_s
        lim = self.limits
        zone = None
        if isinstance(cmd, ZoneCommand):
            ring = [tuple(p) for p in cmd.polygon]
            if ring[0] != ring[-1]:
                ring.append(ring[0])
            if len(ring) - 1 > lim.zone_max_vertices:
                raise CommandRejected(422, f"a drawn zone may have at most {lim.zone_max_vertices} corners")
            if len(set(ring)) < 3 or not Polygon(ring).is_valid or Polygon(ring).area == 0:
                raise CommandRejected(422, "the zone outline crosses itself or has no area; draw it again")
            if cmd.upper_m > lim.zone_max_upper_m:
                raise CommandRejected(422, f"the altitude cap may be at most {lim.zone_max_upper_m:g} m")
            if cmd.duration_s > lim.zone_max_duration_s:
                raise CommandRejected(422, f"the duration may be at most {lim.zone_max_duration_s:g} s")
            city = e.world.planner.coverage.geom
            if city is not None and not city.intersects(Polygon(ring)):
                raise CommandRejected(422, "the zone is outside Warsaw")
            while f"{DRAWN_ZONE_PREFIX}{self._drawn + 1}" in self.zones:
                self._drawn += 1
            self._drawn += 1
            zone_id = f"{DRAWN_ZONE_PREFIX}{self._drawn}"
            act = ZoneActivateEvent.model_validate({
                "type": "zone_activate", "atS": now, "zoneId": zone_id, "name": cmd.name or f"Drawn zone {self._drawn}",
                "polygon": ring, "lowerM": cmd.lower_m, "upperM": cmd.upper_m,
            })
            events = [act, ZoneDeactivateEvent(type="zone_deactivate", at_s=now + cmd.duration_s, zone_id=zone_id)]
            zone = _zone_info(act)
            self.zones[zone_id] = zone
        elif isinstance(cmd, WindCommand):
            if cmd.speed_kmh > lim.wind_max_kmh:
                raise CommandRejected(422, f"wind speed may be at most {lim.wind_max_kmh:g} km/h")
            events = [WindChangeEvent(type="wind_change", at_s=now, speed_kmh=cmd.speed_kmh,
                                      direction_deg=cmd.direction_deg)]
        else:
            d = e.drones.get(cmd.drone_id)
            if d is None:
                raise CommandRejected(404, f"no drone '{cmd.drone_id}' in this simulation")
            if d.state not in AIRBORNE:
                raise CommandRejected(409, f"{d.name} is {d.state.value.lower().replace('_', ' ')}: only a flying "
                                           "drone can be failed")
            events = [DroneFailureEvent(type="drone_failure", at_s=now, drone_id=d.id)]
        e.inject(events)
        return {"scheduled": [x.model_dump(mode="json", by_alias=True) for x in events], "zone": zone,
                **self._clock()}

    def reset(self) -> dict[str, Any]:
        """Back to time 0 with the scenario and seed; commands sent so far are dropped."""
        self.engine.reset()
        self._start_tracking()
        return self.info()

    def replay_scenario(self) -> dict[str, Any]:
        return self.engine.replay_scenario().model_dump(mode="json", by_alias=True, exclude_none=True)


# --- the store ---------------------------------------------------------------------------------

class SimSessionStore:
    """In-memory sessions on one lazily built SimWorld; all work on sessions holds `lock`."""

    def __init__(self, world_factory: Callable[[], SimWorld], scenarios_dir: Path,
                 clock: Callable[[], float] = time.monotonic):
        self._factory = world_factory
        self._world: SimWorld | None = None
        self.scenarios_dir = scenarios_dir
        self.lock = threading.RLock()
        self._sessions: OrderedDict[str, SimSession] = OrderedDict()
        self._clock = clock

    @property
    def world(self) -> SimWorld:
        with self.lock:
            if self._world is None:
                self._world = self._factory()
            return self._world

    @property
    def limits(self) -> ApiLimits:
        return self.world.config.api

    def scenarios(self) -> list[dict[str, Any]]:
        out = []
        for path in sorted(self.scenarios_dir.glob("*.json")):
            if not _SCENARIO_ID.match(path.stem):
                continue
            try:
                sc = load_scenario(path)
            except ScenarioError as exc:
                logger.warning("skipping simulation scenario: %s", exc)
                continue
            out.append({"id": path.stem, "name": sc.name, "description": sc.description, "drones": len(sc.drones),
                        "missions": len(sc.missions), "events": len(sc.events), "seed": sc.seed})
        return out

    def scenario(self, scenario_id: str) -> Scenario:
        path = self.scenarios_dir / f"{scenario_id}.json"
        if not _SCENARIO_ID.match(scenario_id) or not path.is_file():
            raise CommandRejected(404, f"no simulation scenario '{scenario_id}'")
        return load_scenario(path)  # ScenarioError -> 422

    def create(self, scenario: Scenario, seed: int | None = None, scenario_id: str | None = None) -> SimSession:
        with self.lock:
            self._expire()
            engine = SimulationEngine.create(scenario, seed=seed, world=self.world)  # ScenarioError -> 422
            while len(self._sessions) >= self.limits.max_sessions:
                old, _ = self._sessions.popitem(last=False)
                logger.info("dropping simulation session %s (session limit)", old)
            session = SimSession(uuid.uuid4().hex[:12], engine, self.limits, scenario_id)
            session.last_used = self._clock()
            self._sessions[session.id] = session
            return session

    @contextmanager
    def use(self, sid: str) -> Iterator[SimSession]:
        """The session, locked for the duration of the block (404 if unknown or expired)."""
        with self.lock:
            self._expire()
            session = self._sessions.get(sid)
            if session is None:
                raise CommandRejected(404, "this simulation session has ended or expired; start a new one")
            self._sessions.move_to_end(sid)
            session.last_used = self._clock()
            yield session

    def delete(self, sid: str) -> bool:
        with self.lock:
            return self._sessions.pop(sid, None) is not None

    def __len__(self) -> int:
        return len(self._sessions)

    def _expire(self) -> None:
        if self._world is None:
            return
        cutoff = self._clock() - self.limits.idle_timeout_s
        for sid in [s for s, x in self._sessions.items() if x.last_used < cutoff]:
            del self._sessions[sid]
            logger.info("dropping idle simulation session %s", sid)
