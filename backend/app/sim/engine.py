"""Headless, deterministic drone simulation engine.

- Simulated time advances in fixed ticks (tick_s); wall-clock speed is the caller's business.
- Same scenario + same seed = identical event log: drones are updated in sorted id order,
  events in (time, file order), and every random draw comes from one seeded RNG.
- Routes come from the shared RoutePlanner; movement and energy from app/sim/kinematics.py
  and the planner's energy model, so planned and simulated energy agree.
- Safety: every airborne tick checks that the drone can still finish above its battery
  reserve; if not, it makes an emergency landing at the nearest reachable landing station,
  else open green space, else in place (FAILED). Temporary scenario zones make drones
  re-plan, or hold and retry, then divert.
- Airspace data is DEMO/synthetic: a simulated flight is not a flight authorization.
"""

from __future__ import annotations

import bisect
import math
import random
from collections import deque
from dataclasses import dataclass
from datetime import timedelta
from typing import Any

from shapely.geometry import LineString, Point

from app.airspace.models import AirspaceZone
from app.config import DEMO_WEATHER
from app.routing.costs import RouteObjective
from app.routing.grid import lonlat_to_xy
from app.routing.planner import PlanResult, RoutePlanner
from app.routing.risk.energy import DroneEnergy, landing_energy_wh, takeoff_energy_wh
from app.schemas.planning import DroneProfile, RouteStatus
from app.services.route_service import cost_breakdown
from app.sim.airspace import ScenarioZoneProvider, scenario_zone
from app.sim.config import AfterDelivery
from app.sim.drone import DEFAULT_COLORS, Drone
from app.sim.events import EventLog, EventType
from app.sim.kinematics import Leg, cruise_step, leg_energy_wh
from app.sim.mission import MissionRun, MissionStatus, Target
from app.sim.scenario import (
    BatteryFaultEvent,
    DroneFailureEvent,
    LatLon,
    Place,
    Scenario,
    ScenarioError,
    ScenarioEvent,
    ScenarioMission,
    StationRef,
    WindChangeEvent,
    ZoneActivateEvent,
    ZoneDeactivateEvent,
)
from app.sim.sites import open_space_sites
from app.sim.states import AIRBORNE, DroneState
from app.sim.wind import SimWind
from app.sim.world import SimWorld

S = DroneState
SIMULATION_NOTE = "SIMULATION ONLY on DEMO airspace: not a check of real-world flight legality."
#: Emergency and divert routes minimise distance (get down safely), whatever the mission optimised.
SAFETY_OBJECTIVE = RouteObjective.SHORTEST


def _distance_m(a: tuple[float, float], b: tuple[float, float]) -> float:
    (ax, ay), (bx, by) = lonlat_to_xy(*a), lonlat_to_xy(*b)
    return math.hypot(bx - ax, by - ay)


@dataclass
class Hold:
    resume: DroneState  # CRUISE or RETURNING
    target: Target  # where the blocked leg was going
    kind: str  # the blocked leg's kind
    since_s: float
    next_retry_s: float
    need_wh: float  # energy to finish, estimated when the hold started


@dataclass
class EmergencyRun:
    site: Target
    site_type: str  # "station" | "open_space" | "takeoff_point" | "in_place_unsafe"


class SimulationEngine:
    """create(scenario, seed) -> step(n) / run_until(t) -> get_state() / get_event_log(); reset().

    An engine owns its world's airspace provider while it runs: it installs a wrapper that adds
    its active scenario zones and re-syncs it before every plan. inject() adds events while it
    runs; they are recorded, and replay_scenario() returns a scenario that repeats the run.
    """

    def __init__(self, scenario: Scenario, world: SimWorld, seed: int | None = None):
        self.scenario = scenario
        self.world = world
        self.config = world.config
        self.seed = scenario.seed if seed is None else seed
        self.tick_s = scenario.tick_s or self.config.tick_s
        self._validate()
        self.reset()

    @classmethod
    def create(cls, scenario: Scenario, seed: int | None = None, world: SimWorld | None = None) -> SimulationEngine:
        if world is None:
            from app.sim.world import load_world

            world = load_world()
        return cls(scenario, world, seed)

    # --- public API -------------------------------------------------------------------------

    def reset(self) -> None:
        """Back to time 0 with the same scenario and seed (the run repeats exactly)."""
        self.rng = random.Random(self.seed)
        self.tick = 0
        self.log = EventLog()
        w = self.scenario.wind
        self.wind = SimWind(
            w.speed_kmh if w else DEMO_WEATHER["windSpeedKmh"],
            w.direction_deg if w else DEMO_WEATHER["windDirectionDeg"],
            self.config.randomness.gust_std_kmh,
            self.rng,
        )
        repo = self.world.planner.airspace
        base = repo.provider.base if isinstance(repo.provider, ScenarioZoneProvider) else repo.provider
        self._zones = ScenarioZoneProvider(base)
        repo.provider = self._zones
        self.active_zones: dict[str, AirspaceZone] = {}
        self.holds: dict[str, Hold] = {}
        self.emergencies: dict[str, EmergencyRun] = {}
        self.station_users: dict[str, set[str]] = {s.id: set() for s in self.world.stations}
        self.parked_at: dict[str, str | None] = {}
        self.drones: dict[str, Drone] = {}
        self.pending: dict[str, deque[ScenarioMission]] = {}
        for i, sd in enumerate(self.scenario.drones):
            missions = sorted(
                (m for m in self.scenario.missions if m.drone_id == sd.id), key=lambda m: m.depart_at_s
            )  # stable: same depart time keeps file order
            place = sd.position or missions[0].start
            target = self._target(place, "start position")
            profile = self._profile(sd.profile_id)
            pct = 100.0 if sd.battery_pct is None else sd.battery_pct
            self.drones[sd.id] = Drone(
                sd.id, sd.name or sd.id, sd.color or DEFAULT_COLORS[i % len(DEFAULT_COLORS)], profile,
                target.latitude, target.longitude, battery_wh=profile.battery_wh * pct / 100,
            )
            self.pending[sd.id] = deque(missions)
            self._park(sd.id, target.station_id)
        self.events = sorted(enumerate(self.scenario.events), key=lambda ie: (ie[1].at_s, ie[0]))
        self._next_event = 0
        self.injected: list[ScenarioEvent] = []
        self._leg_seq = 0
        self.missions_run: dict[str, list[MissionRun]] = {i: [] for i in self.drones}

    @property
    def time_s(self) -> float:
        return self.tick * self.tick_s

    @property
    def finished(self) -> bool:
        """Nothing left to happen: no pending missions or events, every drone idle or failed."""
        return (
            self._next_event >= len(self.events)
            and all(not q for q in self.pending.values())
            and all(d.state in (S.IDLE, S.FAILED) for d in self.drones.values())
        )

    def step(self, n_ticks: int = 1) -> dict[str, Any]:
        self.advance(n_ticks)
        return self.get_state()

    def advance(self, n_ticks: int = 1) -> None:
        """Like step() without building the state snapshot (for callers that read the drones)."""
        for _ in range(n_ticks):
            self._tick()

    def inject(self, events: list[ScenarioEvent]) -> None:
        """Adds events while running. An event at the current time takes effect in the next tick,
        exactly as if it had been in the scenario file (see replay_scenario)."""
        known = {d.id for d in self.scenario.drones}
        for e in events:
            if e.at_s < self.time_s - 1e-9:
                raise ScenarioError(f"cannot add a {e.type} event in the past ({e.at_s:g} s < {self.time_s:g} s)")
            if getattr(e, "drone_id", None) is not None and e.drone_id not in known:
                raise ScenarioError(f"{e.type}: unknown drone '{e.drone_id}'")
        for e in events:
            item = (len(self.scenario.events) + len(self.injected), e)
            self.injected.append(e)
            # Everything before _next_event is applied and earlier, so the order stays (time, index).
            bisect.insort(self.events, item, lo=self._next_event, key=lambda ie: (ie[1].at_s, ie[0]))

    def replay_scenario(self) -> Scenario:
        """The scenario plus every injected event, with this run's seed: running it repeats this run."""
        return self.scenario.model_copy(update={"seed": self.seed, "events": [*self.scenario.events, *self.injected]})

    def energy_report(self, drone_id: str) -> dict[str, Any] | None:
        """Planned vs actual energy of the drone's current (or last) mission, in Wh."""
        d = self.drones[drone_id]
        runs = self.missions_run[drone_id]
        m = d.mission or (runs[-1] if runs else None)
        if m is None:
            return None
        to_finish = None
        if d.mission is not None and d.state in (S.TAKEOFF, S.CRUISE, S.DELIVERING, S.RETURNING, S.HOLDING):
            to_finish = self._need_to_finish(d)
        return {
            "missionId": m.id,
            "current": d.mission is not None,
            "plannedWh": None if m.planned_energy_wh is None else round(m.planned_energy_wh, 2),
            "usedWh": round(m.energy_used_wh, 2),
            "faultLossWh": round(m.fault_loss_wh, 2),
            "toFinishWh": None if to_finish is None else round(to_finish, 2),
            "projectedWh": None if to_finish is None else round(m.energy_used_wh + to_finish, 2),
            "batteryWh": round(d.battery_wh, 2),
            "reserveWh": round(d.reserve_wh, 2),
        }

    def run_until(self, time_s: float, stop_when_finished: bool = False) -> dict[str, Any]:
        while self.time_s < time_s - 1e-9:
            if stop_when_finished and self.finished:
                break
            self._tick()
        return self.get_state()

    def get_state(self) -> dict[str, Any]:
        return {
            "scenario": self.scenario.name,
            "seed": self.seed,
            "tick": self.tick,
            "tickS": self.tick_s,
            "timeS": round(self.time_s, 3),
            "simTime": (self.scenario.start_time + timedelta(seconds=self.time_s)).isoformat(),
            "wind": self.wind.snapshot(),
            "drones": [self.drones[i].snapshot() for i in sorted(self.drones)],
            "stations": [{"id": s.id, "name": s.name, "capacity": s.capacity,
                          "drones": sorted(self.station_users[s.id])} for s in self.world.stations],
            "activeZones": sorted(self.active_zones),
            "finished": self.finished,
            "note": SIMULATION_NOTE,
        }

    def get_event_log(self) -> list[dict[str, Any]]:
        return self.log.to_dicts()

    # --- validation against the world ------------------------------------------------------

    def _validate(self) -> None:
        problems: list[str] = []

        def check_place(place: Place | None, where: str) -> None:
            if place is None:
                return
            if isinstance(place, StationRef):
                if not self.world.station(place.station_id):
                    problems.append(f"{where}: unknown landing station '{place.station_id}'")
            elif not self.world.contains(place.longitude, place.latitude):
                problems.append(f"{where}: ({place.latitude}, {place.longitude}) is outside the Warsaw boundary")

        initial: dict[str, int] = {}
        for d in self.scenario.drones:
            pid = d.profile_id or self.config.default_profile_id
            if not self.world.profiles.get(pid):
                problems.append(f"drone '{d.id}': unknown drone profile '{pid}'")
            check_place(d.position, f"drone '{d.id}' position")
            if isinstance(d.position, StationRef):
                initial[d.position.station_id] = initial.get(d.position.station_id, 0) + 1
        for sid, n in initial.items():
            st = self.world.station(sid)
            if st and n > st.capacity:
                problems.append(f"station '{sid}' holds {st.capacity} drones but {n} start there")
        for m in self.scenario.missions:
            check_place(m.start, f"mission '{m.id}' start")
            check_place(m.destination, f"mission '{m.id}' destination")
            drone = next(d for d in self.scenario.drones if d.id == m.drone_id)
            profile = self.world.profiles.get(drone.profile_id or self.config.default_profile_id)
            if profile and m.payload_kg is not None and m.payload_kg > profile.max_payload_kg:
                problems.append(f"mission '{m.id}': payload {m.payload_kg} kg exceeds the {profile.name} "
                                f"maximum of {profile.max_payload_kg} kg")
        if problems:
            raise ScenarioError(f"Scenario '{self.scenario.name}' does not fit the loaded world:\n  - "
                                + "\n  - ".join(problems))

    # --- helpers ---------------------------------------------------------------------------

    def _profile(self, profile_id: str | None) -> DroneProfile:
        return self.world.profiles.get(profile_id or self.config.default_profile_id)  # validated

    def _target(self, place: Place, label: str) -> Target:
        if isinstance(place, StationRef):
            st = self.world.station(place.station_id)
            return Target(st.name, st.longitude, st.latitude, st.id)
        assert isinstance(place, LatLon)
        return Target(label, place.longitude, place.latitude, None)

    @staticmethod
    def _energy(d: Drone) -> DroneEnergy:
        return RoutePlanner.drone_energy(d.profile)

    @property
    def planner(self) -> RoutePlanner:
        return self.world.planner

    def _now_dt(self, t_s: float):
        return self.scenario.start_time + timedelta(seconds=t_s)

    def _sync_airspace(self) -> None:
        repo = self.planner.airspace
        if repo.provider is not self._zones:
            repo.provider = self._zones  # another engine used this world in between
        self._zones.set_zones(self.active_zones)

    def _plan(self, d: Drone, a: tuple[float, float], b: tuple[float, float], payload: float, t_s: float,
              objective: RouteObjective | None = None) -> PlanResult:
        self._sync_airspace()
        m = d.mission
        return self.planner.plan(a, b, m.spec.mode, m.altitude_m, d.profile, self.wind.weather(m.altitude_m),
                                 self._now_dt(t_s), objective or m.spec.route_objective, payload)

    def _park(self, drone_id: str, station_id: str | None) -> None:
        old = self.parked_at.get(drone_id)
        if old:
            self.station_users[old].discard(drone_id)
        self.parked_at[drone_id] = station_id
        if station_id:
            self.station_users[station_id].add(drone_id)

    def _has_room(self, station_id: str, drone_id: str) -> bool:
        st = self.world.station(station_id)
        users = self.station_users[station_id] - {drone_id}
        return bool(st and st.available and len(users) < st.capacity)

    def _release_return_station(self, d: Drone) -> None:
        m = d.mission
        if m and m.return_target and m.return_target.station_id:
            self.station_users[m.return_target.station_id].discard(d.id)

    def _drain(self, d: Drone, wh: float, now: float, fault: bool = False) -> bool:
        """Uses energy (or loses it to a fault); returns False (drone FAILED) if the battery ran empty.
        Never goes below 0."""
        if d.mission:
            taken = min(wh, max(d.battery_wh, 0.0))
            if fault:
                d.mission.fault_loss_wh += taken
            else:
                d.mission.energy_used_wh += taken
        d.battery_wh -= wh
        if d.battery_wh <= 0:
            d.battery_wh = 0.0
            self.log.append(now, d.id, EventType.FAILURE, reason="battery empty")
            if d.mission and d.mission.status not in (MissionStatus.DELIVERED, MissionStatus.COMPLETED):
                d.mission.status = MissionStatus.ABORTED
            d.speed_mps = 0.0
            d.transition(S.FAILED, now, self.log, "battery empty")
            return False
        for level in self.config.battery_warning_pct:
            if d.battery_pct < level and level not in d.warnings_sent and d.state in AIRBORNE:
                d.warnings_sent.add(level)
                self.log.append(now, d.id, EventType.BATTERY_WARNING, levelPct=level, batteryPct=d.battery_pct)
        return True

    def _set_position(self, d: Drone, leg: Leg) -> None:
        d.longitude, d.latitude = leg.lonlat_at(leg.progress_m)
        d.heading_deg = leg.heading_at(leg.progress_m)[2]

    def _new_leg(self, kind: str, target: str, path: list[tuple[float, float]], energy_wh: float | None = None) -> Leg:
        self._leg_seq += 1
        return Leg.from_lonlat(kind, target, path, energy_wh, leg_id=f"L{self._leg_seq}")

    def _record_plan(self, m: MissionRun, kind: str, plan: PlanResult) -> None:
        """Keeps the planner's cost breakdown of the leg the drone now flies (latest plan per kind)."""
        b = cost_breakdown(plan, self.planner.risk.data_available)
        if b is not None:
            m.breakdowns[kind] = b.model_dump(mode="json", by_alias=True)

    def _fail(self, d: Drone, now: float, reason: str) -> None:
        """An airborne drone fails where it is (a test event): mission aborted, route dropped."""
        m = d.mission
        self._release_return_station(d)
        self.holds.pop(d.id, None)
        site = self.emergencies.pop(d.id, None)
        if site and site.site.station_id:
            self.station_users[site.site.station_id].discard(d.id)
        self.log.append(now, d.id, EventType.FAILURE, reason=reason)
        if m and m.status not in (MissionStatus.DELIVERED, MissionStatus.COMPLETED, MissionStatus.ABORTED):
            m.status = MissionStatus.ABORTED
            self.log.append(now, d.id, EventType.MISSION_ABORTED, missionId=m.id, reason=reason)
        d.speed_mps = 0.0
        d.leg = None
        d.transition(S.FAILED, now, self.log, reason)

    @staticmethod
    def _leg_path(path: list[tuple[float, float]], here: tuple[float, float]) -> list[tuple[float, float]]:
        """Starts the leg exactly where the drone is (the planner may have snapped the first point)."""
        if _distance_m(path[0], here) > 0.5:
            return [here, *path]
        return [here, *path[1:]]

    # --- the tick --------------------------------------------------------------------------

    def _tick(self) -> None:
        t0 = self.time_s
        now = t0 + self.tick_s
        self._apply_events(now)
        self.wind.draw()
        for drone_id in sorted(self.drones):
            self._update(self.drones[drone_id], now)
        self.tick += 1

    def _apply_events(self, now: float) -> None:
        while self._next_event < len(self.events) and self.events[self._next_event][1].at_s < now:
            _, e = self.events[self._next_event]
            self._next_event += 1
            self._apply(e)

    def _apply(self, e) -> None:
        if isinstance(e, DroneFailureEvent):
            d = self.drones[e.drone_id]
            airborne = d.state in AIRBORNE
            self.log.append(e.at_s, d.id, EventType.SCENARIO_EVENT, kind="drone_failure", reason=e.reason,
                            applied=airborne)
            if airborne:
                self._fail(d, e.at_s, e.reason)
            return
        if isinstance(e, WindChangeEvent):
            self.wind.set(e.speed_kmh, e.direction_deg)
            self.log.append(e.at_s, None, EventType.SCENARIO_EVENT, kind="wind_change", speedKmh=e.speed_kmh,
                            directionDeg=e.direction_deg)
        elif isinstance(e, BatteryFaultEvent):
            d = self.drones[e.drone_id]
            self.log.append(e.at_s, d.id, EventType.SCENARIO_EVENT, kind="battery_fault", lossPct=e.loss_pct)
            if d.state != S.FAILED:
                self._drain(d, d.profile.battery_wh * e.loss_pct / 100, e.at_s, fault=True)
        elif isinstance(e, ZoneActivateEvent):
            self.active_zones[e.zone_id] = scenario_zone(e)
            self.log.append(e.at_s, None, EventType.SCENARIO_EVENT, kind="zone_activate", zoneId=e.zone_id,
                            name=e.name, category=e.category, lowerM=e.lower_m, upperM=e.upper_m)
            for drone_id in sorted(self.drones):
                d = self.drones[drone_id]
                if d.state in (S.CRUISE, S.RETURNING):
                    self._check_leg(d, e.at_s, f"zone '{e.name}' activated", e.zone_id)
        elif isinstance(e, ZoneDeactivateEvent):
            self.active_zones.pop(e.zone_id, None)
            self.log.append(e.at_s, None, EventType.SCENARIO_EVENT, kind="zone_deactivate", zoneId=e.zone_id)
            for h in self.holds.values():
                h.next_retry_s = min(h.next_retry_s, e.at_s)  # waiting drones try again right away

    def _update(self, d: Drone, now: float) -> None:
        dt = self.tick_s
        state = d.state
        if state == S.IDLE:
            self._maybe_start_mission(d, now)
        elif state == S.LOADING:
            if now - d.state_entered_at_s >= d.mission.loading_s - 1e-9:
                self._preflight(d, now)
        elif state == S.TAKEOFF:
            self._climb(d, now, dt)
        elif state in (S.CRUISE, S.RETURNING):
            self._fly(d, now, dt)
        elif state == S.DELIVERING:
            self._deliver(d, now, dt)
        elif state == S.HOLDING:
            self._hold(d, now, dt)
        elif state == S.LANDING:
            self._descend(d, now, dt)
        elif state == S.EMERGENCY_LANDING:
            self._emergency_step(d, now, dt)
        elif state == S.CHARGING:
            self._charge(d, now, dt)

    # --- mission lifecycle ------------------------------------------------------------------

    def _maybe_start_mission(self, d: Drone, now: float) -> None:
        queue = self.pending[d.id]
        if not queue or queue[0].depart_at_s > now - self.tick_s + 1e-9:
            return
        spec = queue.popleft()
        here = (d.longitude, d.latitude)
        start = self._target(spec.start, "Point A") if spec.start else Target("Point A", *here)
        gap = _distance_m(here, start.lonlat)
        if gap > self.config.position_tolerance_m:
            self.log.append(now, d.id, EventType.MISSION_REJECTED, missionId=spec.id,
                            reason=f"drone is {gap:.0f} m from the pickup point (tolerance "
                                   f"{self.config.position_tolerance_m:.0f} m)")
            return
        cm = self.world.cost_model
        jitter = self.config.randomness.loading_jitter_s
        loading = self.config.durations.loading_s + (self.rng.uniform(-jitter, jitter) if jitter else 0.0)
        payload = cm.energy.default_payload_kg if spec.payload_kg is None else spec.payload_kg
        d.mission = MissionRun(
            spec=spec,
            start=start,
            destination=self._target(spec.destination, "Point B"),
            altitude_m=spec.flight_altitude_meters or int(cm.altitude.default_cruise_m),
            payload_kg=min(payload, d.profile.max_payload_kg),
            after_delivery=spec.after_delivery or self.config.after_delivery,
            loading_s=max(0.0, loading),
        )
        self.missions_run[d.id].append(d.mission)
        d.payload_kg = d.mission.payload_kg
        d.warnings_sent.clear()
        self.log.append(now, d.id, EventType.MISSION_ASSIGNED, missionId=spec.id, mode=spec.mode,
                        routeObjective=spec.route_objective, altitudeM=d.mission.altitude_m,
                        payloadKg=d.payload_kg, afterDelivery=d.mission.after_delivery)
        d.transition(S.LOADING, now, self.log, f"mission {spec.id} loading", missionId=spec.id)

    def _reject(self, d: Drone, now: float, reason: str) -> None:
        m = d.mission
        m.status = MissionStatus.REJECTED
        self.log.append(now, d.id, EventType.MISSION_REJECTED, missionId=m.id, reason=reason)
        d.payload_kg = 0.0
        d.transition(S.IDLE, now, self.log, "mission rejected by the pre-flight check", missionId=m.id)
        d.mission = None

    def _nearest_station(self, d: Drone, here: tuple[float, float], payload: float, now: float,
                         objective: RouteObjective | None = None,
                         max_energy_wh: float | None = None) -> tuple[Target | None, PlanResult | None, str]:
        """Station with room and the shortest planned route from here (optionally within an energy budget)."""
        energy = self._energy(d)
        best: tuple[float, str, Target, PlanResult] | None = None
        reasons = []
        for st in self.world.stations:
            if not self._has_room(st.id, d.id):
                continue
            plan = self._plan(d, here, (st.longitude, st.latitude), payload, now, objective)
            if plan.status != RouteStatus.OK:
                reasons.append(f"{st.name}: {plan.status.value}")
                continue
            if max_energy_wh is not None:
                need = plan.breakdown.energy_wh + landing_energy_wh(energy, payload, d.mission.altitude_m)
                if need > max_energy_wh:
                    reasons.append(f"{st.name}: needs {need:.1f} Wh")
                    continue
            key = (plan.distance_m, st.id)
            if best is None or key < best[:2]:
                best = (plan.distance_m, st.id, Target(st.name, st.longitude, st.latitude, st.id), plan)
        if best is None:
            return None, None, "no landing station with room is reachable" + (f" ({'; '.join(reasons)})" if reasons else "")
        return best[2], best[3], ""

    def _return_plan(self, d: Drone, here: tuple[float, float], now: float) -> tuple[Target | None, PlanResult | None, str]:
        """Where the drone goes after delivering, and the route there (payload delivered)."""
        m = d.mission
        if m.after_delivery == AfterDelivery.STAY_AT_DESTINATION:
            return None, None, ""
        if m.after_delivery == AfterDelivery.RETURN_TO_START:
            plan = self._plan(d, here, m.start.lonlat, 0.0, now)
            return (m.start, plan, "") if plan.status == RouteStatus.OK else (None, None, f"return to Point A: {plan.message}")
        return self._nearest_station(d, here, 0.0, now)

    def _preflight(self, d: Drone, now: float) -> None:
        """Plans both legs and checks the whole mission fits the battery above the reserve."""
        m = d.mission
        energy = self._energy(d)
        out = self._plan(d, m.start.lonlat, m.destination.lonlat, m.payload_kg, now)
        if out.status != RouteStatus.OK:
            self._reject(d, now, f"outbound route: {out.status.value}: {out.message}")
            return
        ret_target, ret_plan, why = self._return_plan(d, m.destination.lonlat, now)
        if why:
            self._reject(d, now, why)
            return
        m.return_energy_wh = ret_plan.breakdown.energy_wh if ret_plan else 0.0
        need = (takeoff_energy_wh(energy, m.payload_kg, m.altitude_m) + out.breakdown.energy_wh
                + energy.hover_power(m.payload_kg) * self.config.durations.delivering_s / 3600
                + m.return_energy_wh + landing_energy_wh(energy, 0.0, m.altitude_m))
        usable = d.battery_wh - d.reserve_wh
        if need > usable:
            self._reject(d, now, f"pre-flight energy check: the mission needs about {need:.1f} Wh but only "
                                 f"{max(usable, 0):.1f} Wh is usable above the {d.profile.min_reserve_pct:g} % reserve")
            return
        m.planned_energy_wh = need
        m.return_target = ret_target
        m.status = MissionStatus.OUTBOUND
        self.log.append(now, d.id, EventType.ROUTE_PLANNED, missionId=m.id, leg="outbound",
                        distanceM=out.distance_m, etaS=out.eta_s, energyWh=out.breakdown.energy_wh,
                        airspaceVersion=out.airspace.version if out.airspace else None, note=SIMULATION_NOTE)
        if ret_plan:
            self.log.append(now, d.id, EventType.ROUTE_PLANNED, missionId=m.id, leg="return",
                            target=ret_target.label, distanceM=ret_plan.distance_m, etaS=ret_plan.eta_s,
                            energyWh=ret_plan.breakdown.energy_wh)
        if ret_target and ret_target.station_id:
            self.station_users[ret_target.station_id].add(d.id)  # reserve the landing spot
        d.leg = self._new_leg("outbound", m.destination.label, self._leg_path(out.path_lonlat, m.start.lonlat),
                              out.breakdown.energy_wh)
        self._record_plan(m, "outbound", out)
        if ret_plan:
            self._record_plan(m, "return", ret_plan)
        # Leaving the parking spot, unless the drone comes back to the same station (its reservation stays).
        old = self.parked_at.get(d.id)
        self.parked_at[d.id] = None
        if old and not (ret_target and ret_target.station_id == old):
            self.station_users[old].discard(d.id)
        d.transition(S.TAKEOFF, now, self.log, "pre-flight check passed", missionId=m.id,
                     plannedEnergyWh=need)

    def _climb(self, d: Drone, now: float, dt: float) -> None:
        m = d.mission
        rate = d.profile.climb_rate_mps
        rise = min(rate * dt, m.altitude_m - d.altitude_m)
        d.altitude_m += rise
        if not self._drain(d, self._energy(d).climb_power_w(d.payload_kg) * (rise / rate) / 3600, now):
            return
        if self._monitor(d, now):
            return
        if d.altitude_m >= m.altitude_m - 1e-9:
            d.altitude_m = float(m.altitude_m)
            d.transition(S.CRUISE, now, self.log, "cruise altitude reached", missionId=m.id)
            self._check_leg(d, now, "zone check at cruise altitude")  # zones activated during the climb

    def _move(self, d: Drone, now: float, dt: float) -> bool:
        """One tick along the current leg; returns False if the battery ran empty."""
        leg = d.leg
        _, used, g = cruise_step(self._energy(d), d.payload_kg, leg, self.wind.at, dt)
        d.speed_mps = g
        self._set_position(d, leg)
        return self._drain(d, used, now)

    def _fly(self, d: Drone, now: float, dt: float) -> None:
        if not self._move(d, now, dt) or self._monitor(d, now):
            return
        leg = d.leg
        if leg.done:
            d.speed_mps = 0.0
            if d.state == S.CRUISE:
                d.transition(S.DELIVERING, now, self.log, f"arrived over {leg.target}", missionId=d.mission.id)
            else:
                d.transition(S.LANDING, now, self.log, f"arrived over {leg.target}", missionId=d.mission.id)

    def _deliver(self, d: Drone, now: float, dt: float) -> None:
        m = d.mission
        if not self._drain(d, self._energy(d).hover_power(d.payload_kg) * dt / 3600, now) or self._monitor(d, now):
            return
        if now - d.state_entered_at_s < self.config.durations.delivering_s - 1e-9:
            return
        self.log.append(now, d.id, EventType.DELIVERED, missionId=m.id, payloadKg=d.payload_kg,
                        at=[d.latitude, d.longitude])
        d.payload_kg = 0.0
        m.status = MissionStatus.DELIVERED
        if m.after_delivery == AfterDelivery.STAY_AT_DESTINATION:
            d.transition(S.LANDING, now, self.log, "delivered; landing at Point B", missionId=m.id)
            return
        # Re-plan now: wind or zones may have changed since the pre-flight check.
        here = (d.longitude, d.latitude)
        self._release_return_station(d)
        target, plan, why = self._return_plan(d, here, now)
        if plan is None:
            self._emergency(d, now, f"no return route after delivery: {why}")
            return
        if target.station_id:
            self.station_users[target.station_id].add(d.id)
        if target != m.return_target:
            self.log.append(now, d.id, EventType.REPLANNED, missionId=m.id, leg="return", target=target.label,
                            reason="return target changed after delivery")
        m.return_target = target
        m.return_energy_wh = plan.breakdown.energy_wh
        m.status = MissionStatus.RETURNING
        d.leg = self._new_leg("return", target.label, self._leg_path(plan.path_lonlat, here), plan.breakdown.energy_wh)
        self._record_plan(m, "return", plan)
        self.log.append(now, d.id, EventType.ROUTE_PLANNED, missionId=m.id, leg="return", target=target.label,
                        distanceM=plan.distance_m, etaS=plan.eta_s, energyWh=plan.breakdown.energy_wh)
        d.transition(S.RETURNING, now, self.log, f"returning to {target.label}", missionId=m.id)

    def _descend(self, d: Drone, now: float, dt: float) -> None:
        rate = d.profile.descent_rate_mps
        drop = min(rate * dt, d.altitude_m)
        d.altitude_m -= drop
        d.speed_mps = 0.0
        if not self._drain(d, self._energy(d).descent_power(d.payload_kg) * (drop / rate) / 3600, now):
            return
        if d.altitude_m <= 1e-9:
            d.altitude_m = 0.0
            self._landed(d, now)

    def _landed(self, d: Drone, now: float) -> None:
        m = d.mission
        station = self.world.station_at(d.longitude, d.latitude, self.config.position_tolerance_m)
        if m and m.status != MissionStatus.ABORTED:
            m.status = MissionStatus.COMPLETED
            self.log.append(now, d.id, EventType.MISSION_COMPLETED, missionId=m.id,
                            landedAt=station.name if station else "Point B", batteryPct=d.battery_pct,
                            plannedEnergyWh=m.planned_energy_wh, energyUsedWh=m.energy_used_wh)
        d.mission = None
        d.leg = None
        if station and (d.id in self.station_users[station.id] or self._has_room(station.id, d.id)):
            self._park(d.id, station.id)
            d.transition(S.CHARGING, now, self.log, f"landed at {station.name}")
        else:
            self._park(d.id, None)
            d.transition(S.IDLE, now, self.log, "landed (no landing station here, not charging)")

    def _charge(self, d: Drone, now: float, dt: float) -> None:
        rate_wh_per_s = d.profile.battery_wh / self.config.durations.charging_s
        d.battery_wh = min(d.profile.battery_wh, d.battery_wh + rate_wh_per_s * dt)
        if d.battery_wh >= d.profile.battery_wh - 1e-9:
            d.warnings_sent.clear()
            self.log.append(now, d.id, EventType.CHARGED, batteryPct=d.battery_pct)
            d.transition(S.IDLE, now, self.log, "battery full")

    # --- battery monitoring ------------------------------------------------------------------

    def _need_to_finish(self, d: Drone) -> float:
        """Energy the drone still needs to complete its plan and land, from its current state."""
        e, m = self._energy(d), d.mission
        land = landing_energy_wh(e, 0.0, m.altitude_m)
        after_delivery = e.hover_power(m.payload_kg) * self.config.durations.delivering_s / 3600 + m.return_energy_wh + land
        if d.state == S.TAKEOFF:
            remaining_climb = (m.altitude_m - d.altitude_m) / d.profile.climb_rate_mps
            return (e.climb_power_w(d.payload_kg) * remaining_climb / 3600
                    + leg_energy_wh(e, d.payload_kg, d.leg, self.wind.at) + after_delivery)
        if d.state == S.CRUISE:
            return leg_energy_wh(e, d.payload_kg, d.leg, self.wind.at) + after_delivery
        if d.state == S.DELIVERING:
            left_s = max(0.0, self.config.durations.delivering_s - (self.time_s + self.tick_s - d.state_entered_at_s))
            return e.hover_power(d.payload_kg) * left_s / 3600 + m.return_energy_wh + land
        if d.state == S.RETURNING:
            return leg_energy_wh(e, d.payload_kg, d.leg, self.wind.at) + landing_energy_wh(e, d.payload_kg, m.altitude_m)
        if d.state == S.HOLDING:
            return self.holds[d.id].need_wh
        return 0.0

    def _monitor(self, d: Drone, now: float) -> bool:
        """Switches to an emergency landing if finishing would break the battery reserve. True if it did."""
        if d.state not in (S.TAKEOFF, S.CRUISE, S.DELIVERING, S.RETURNING, S.HOLDING):
            return False
        need = self._need_to_finish(d)
        if d.battery_wh - need >= d.reserve_wh - 1e-9:
            return False
        self._emergency(d, now, f"battery {d.battery_pct:.1f} %: finishing needs about {need:.1f} Wh and would "
                                f"leave less than the {d.profile.min_reserve_pct:g} % reserve",
                        need_wh=need)
        return True

    # --- emergency landing -------------------------------------------------------------------

    def _emergency(self, d: Drone, now: float, reason: str, **details: Any) -> None:
        m = d.mission
        self._release_return_station(d)
        self.holds.pop(d.id, None)
        here = (d.longitude, d.latitude)
        site, leg = self._emergency_site(d, here, now)
        self.emergencies[d.id] = site
        d.leg = leg
        if site.site.station_id:
            self.station_users[site.site.station_id].add(d.id)
        self.log.append(now, d.id, EventType.EMERGENCY, reason=reason, site=site.site.label, siteType=site.site_type,
                        batteryWh=d.battery_wh, batteryPct=d.battery_pct, distanceM=leg.length_m if leg else 0.0,
                        **details)
        if m and m.status not in (MissionStatus.DELIVERED, MissionStatus.RETURNING):
            m.status = MissionStatus.ABORTED  # (a delivered mission stays delivered; only its return is abandoned)
            self.log.append(now, d.id, EventType.MISSION_ABORTED, missionId=m.id, reason=reason)
        d.transition(S.EMERGENCY_LANDING, now, self.log, reason, site=site.site.label, siteType=site.site_type)

    def _emergency_site(self, d: Drone, here: tuple[float, float], now: float) -> tuple[EmergencyRun, Leg | None]:
        """Nearest reachable landing station, else open green space, else land where it is."""
        if d.state == S.TAKEOFF:  # still above the take-off point, which was a valid site
            return EmergencyRun(Target("take-off point", *here), "takeoff_point"), None
        budget = d.battery_wh  # the reserve exists for exactly this
        target, plan, _ = self._nearest_station(d, here, d.payload_kg, now, SAFETY_OBJECTIVE, budget)
        if plan:
            return EmergencyRun(target, "station"), self._new_leg("emergency", target.label, self._leg_path(plan.path_lonlat, here))
        e = self._energy(d)
        sites = open_space_sites(self.planner, *here, self.config.emergency.open_space_search_radius_m,
                                 self.config.emergency.open_space_candidates)
        for lon, lat, dist in sites:
            label = f"open space {lat:.5f}, {lon:.5f}"
            if dist <= self.planner.grid.cell:  # already over open space
                return EmergencyRun(Target(label, *here), "open_space"), None
            plan = self._plan(d, here, (lon, lat), d.payload_kg, now, SAFETY_OBJECTIVE)
            if plan.status == RouteStatus.OK and plan.breakdown.energy_wh + landing_energy_wh(e, d.payload_kg, d.mission.altitude_m) <= budget:
                return EmergencyRun(Target(label, lon, lat), "open_space"), self._new_leg("emergency", label, self._leg_path(plan.path_lonlat, here))
        return EmergencyRun(Target("current position (no safe site reachable)", *here), "in_place_unsafe"), None

    def _emergency_step(self, d: Drone, now: float, dt: float) -> None:
        if d.leg and not d.leg.done:
            if self._move(d, now, dt) and d.leg.done:
                d.speed_mps = 0.0
            return
        rate = d.profile.descent_rate_mps
        drop = min(rate * dt, d.altitude_m)
        d.altitude_m -= drop
        d.speed_mps = 0.0
        if not self._drain(d, self._energy(d).descent_power(d.payload_kg) * (drop / rate) / 3600, now):
            return
        if d.altitude_m > 1e-9:
            return
        d.altitude_m = 0.0
        site = self.emergencies.pop(d.id)
        d.mission = None
        d.leg = None
        if site.site_type == "in_place_unsafe":
            self._park(d.id, None)
            self.log.append(now, d.id, EventType.FAILURE, reason="no safe landing site was reachable; landed in place")
            d.transition(S.FAILED, now, self.log, "emergency landing without a safe site")
            return
        self._park(d.id, site.site.station_id)
        d.transition(S.IDLE, now, self.log, f"emergency landing completed at {site.site.label} (grounded)",
                     siteType=site.site_type)

    # --- temporary zones: re-plan, hold, divert ------------------------------------------

    def _leg_blocked(self, d: Drone) -> tuple[list[str], list[str]]:
        """(active scenario zones the rest of the leg crosses, incl. margin; zones the drone is inside)."""
        if not d.leg or not self.active_zones:
            return [], []
        self._sync_airspace()
        state = self.planner.airspace.refresh()
        margin = self.planner.airspace.margin_m
        rest = LineString([lonlat_to_xy(*p) for p in d.leg.remaining_path()] or [lonlat_to_xy(d.longitude, d.latitude)] * 2)
        here = Point(lonlat_to_xy(d.longitude, d.latitude))
        blocked: list[str] = []
        inside: list[str] = []
        for i, z in enumerate(state.zones):
            if z.id not in self.active_zones:
                continue
            geom = state.geoms_m[i]
            if geom.contains(here):
                inside.append(z.id)
            elif rest.intersects(geom.buffer(margin)):
                blocked.append(z.id)
        return blocked, inside

    def _check_leg(self, d: Drone, now: float, reason: str, zone_id: str | None = None) -> None:
        """Re-plans around newly active zones; holds if no route exists. Reactions name the zones."""
        blocked, inside = self._leg_blocked(d)
        if zone_id is not None:  # react only to the zone that was just activated
            blocked = [z for z in blocked if z == zone_id]
            if not blocked and zone_id not in inside:
                return
        if inside:  # leaving the zone it is in comes first
            self.log.append(now, d.id, EventType.REPLANNED, missionId=d.mission.id, applied=False, zoneIds=inside,
                            reason=f"{reason}: the drone is already inside the zone and continues on its route to leave it")
            return
        if not blocked:
            return
        leg = d.leg
        here = (d.longitude, d.latitude)
        target = (leg.lonlat[-1] if leg.lonlat else leg.lonlat_at(leg.length_m))
        plan = self._plan(d, here, target, d.payload_kg, now)
        if plan.status == RouteStatus.OK:
            d.leg = self._new_leg(leg.kind, leg.target, self._leg_path(plan.path_lonlat, here), plan.breakdown.energy_wh)
            self._record_plan(d.mission, leg.kind, plan)
            self.log.append(now, d.id, EventType.REPLANNED, missionId=d.mission.id, leg=leg.kind, reason=reason,
                            distanceM=plan.distance_m, energyWh=plan.breakdown.energy_wh, zoneIds=blocked)
            return
        need = self._need_to_finish(d)
        self.holds[d.id] = Hold(d.state, Target(leg.target, *target), leg.kind, now,
                                now + self.config.holding.retry_s, need)
        d.speed_mps = 0.0
        d.transition(S.HOLDING, now, self.log, f"{reason}: no route ({plan.status.value})", missionId=d.mission.id,
                     zoneIds=blocked)

    def _hold(self, d: Drone, now: float, dt: float) -> None:
        if not self._drain(d, self._energy(d).hover_power(d.payload_kg) * dt / 3600, now) or self._monitor(d, now):
            return
        h = self.holds[d.id]
        if now + 1e-9 < h.next_retry_s:
            return
        here = (d.longitude, d.latitude)
        plan = self._plan(d, here, h.target.lonlat, d.payload_kg, now)
        if plan.status == RouteStatus.OK:
            del self.holds[d.id]
            d.leg = self._new_leg(h.kind, h.target.label, self._leg_path(plan.path_lonlat, here), plan.breakdown.energy_wh)
            self._record_plan(d.mission, h.kind, plan)
            self.log.append(now, d.id, EventType.REPLANNED, missionId=d.mission.id, leg=h.kind,
                            reason="path clear again", distanceM=plan.distance_m, energyWh=plan.breakdown.energy_wh)
            d.transition(h.resume, now, self.log, "path clear again; resuming", missionId=d.mission.id)
            return
        if now - h.since_s >= self.config.holding.max_s - 1e-9:
            self._divert(d, now, f"held {now - h.since_s:.0f} s without a route to {h.target.label}")
            return
        h.next_retry_s = now + self.config.holding.retry_s

    def _divert(self, d: Drone, now: float, reason: str) -> None:
        """Gives up on the blocked leg: nearest reachable station within the usable battery, else emergency."""
        m = d.mission
        here = (d.longitude, d.latitude)
        self._release_return_station(d)
        target, plan, why = self._nearest_station(d, here, d.payload_kg, now, SAFETY_OBJECTIVE, d.battery_wh - d.reserve_wh)
        if plan is None:
            self._emergency(d, now, f"{reason}; {why}")
            return
        del self.holds[d.id]
        if m.status not in (MissionStatus.DELIVERED, MissionStatus.RETURNING):
            m.status = MissionStatus.ABORTED
            self.log.append(now, d.id, EventType.MISSION_ABORTED, missionId=m.id, reason=reason)
        m.return_target = target
        m.return_energy_wh = plan.breakdown.energy_wh
        self.station_users[target.station_id].add(d.id)
        d.leg = self._new_leg("divert", target.label, self._leg_path(plan.path_lonlat, here), plan.breakdown.energy_wh)
        self._record_plan(m, "divert", plan)
        self.log.append(now, d.id, EventType.REPLANNED, missionId=m.id, leg="divert", target=target.label, reason=reason,
                        distanceM=plan.distance_m)
        d.transition(S.RETURNING, now, self.log, f"diverting to {target.label}", missionId=m.id)
