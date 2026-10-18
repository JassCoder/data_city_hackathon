"""Headless, deterministic drone simulation engine.

- Simulated time advances in fixed ticks (tick_s); wall-clock speed is the caller's business.
- Same scenario + same seed = identical event log: drones are updated in sorted id order,
  events in (time, file order), and every random draw comes from one seeded RNG.
- Routes come from the shared RoutePlanner; movement and energy from app/sim/kinematics.py
  and the planner's energy model, so planned and simulated energy agree.
- Airspace data is DEMO/synthetic: a simulated flight is not a flight authorization.
"""

from __future__ import annotations

import math
import random
from collections import deque
from datetime import timedelta
from typing import Any

from app.config import DEMO_WEATHER
from app.routing.grid import lonlat_to_xy
from app.routing.planner import PlanResult, RoutePlanner
from app.routing.risk.energy import DroneEnergy, landing_energy_wh, takeoff_energy_wh
from app.schemas.planning import DroneProfile, RouteStatus
from app.sim.config import AfterDelivery
from app.sim.drone import DEFAULT_COLORS, Drone
from app.sim.events import EventLog, EventType
from app.sim.kinematics import Leg, cruise_step
from app.sim.mission import MissionRun, MissionStatus, Target
from app.sim.scenario import (
    BatteryFaultEvent,
    LatLon,
    Place,
    Scenario,
    ScenarioError,
    ScenarioMission,
    StationRef,
    WindChangeEvent,
)
from app.sim.states import AIRBORNE, DroneState
from app.sim.wind import SimWind
from app.sim.world import SimWorld

S = DroneState
SIMULATION_NOTE = "SIMULATION ONLY on DEMO airspace: not a check of real-world flight legality."


def _distance_m(a: tuple[float, float], b: tuple[float, float]) -> float:
    (ax, ay), (bx, by) = lonlat_to_xy(*a), lonlat_to_xy(*b)
    return math.hypot(bx - ax, by - ay)


class SimulationEngine:
    """create(scenario, seed) -> step(n) / run_until(t) -> get_state() / get_event_log(); reset()."""

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
        for _ in range(n_ticks):
            self._tick()
        return self.get_state()

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

    def _energy(self, d: Drone) -> DroneEnergy:
        return RoutePlanner.drone_energy(d.profile)

    @property
    def planner(self) -> RoutePlanner:
        return self.world.planner

    def _now_dt(self, t_s: float):
        return self.scenario.start_time + timedelta(seconds=t_s)

    def _plan(self, d: Drone, a: tuple[float, float], b: tuple[float, float], payload: float, t_s: float) -> PlanResult:
        m = d.mission
        return self.planner.plan(a, b, m.spec.mode, m.altitude_m, d.profile, self.wind.weather(m.altitude_m),
                                 self._now_dt(t_s), m.spec.route_objective, payload)

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

    def _drain(self, d: Drone, wh: float, now: float) -> bool:
        """Uses energy; returns False (drone FAILED) if the battery ran empty."""
        d.battery_wh -= wh
        if d.battery_wh <= 0:
            d.battery_wh = 0.0
            self.log.append(now, d.id, EventType.FAILURE, reason="battery empty")
            if d.mission:
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
        self._apply_events(t0, now)
        self.wind.draw()
        for drone_id in sorted(self.drones):
            self._update(self.drones[drone_id], now)
        self.tick += 1

    def _apply_events(self, t0: float, now: float) -> None:
        while self._next_event < len(self.events) and self.events[self._next_event][1].at_s < now:
            _, e = self.events[self._next_event]
            self._next_event += 1
            self._apply(e)

    def _apply(self, e) -> None:
        if isinstance(e, WindChangeEvent):
            self.wind.set(e.speed_kmh, e.direction_deg)
            self.log.append(e.at_s, None, EventType.SCENARIO_EVENT, kind="wind_change", speedKmh=e.speed_kmh,
                            directionDeg=e.direction_deg)
        elif isinstance(e, BatteryFaultEvent):
            d = self.drones[e.drone_id]
            loss = d.profile.battery_wh * e.loss_pct / 100
            self.log.append(e.at_s, d.id, EventType.SCENARIO_EVENT, kind="battery_fault", lossPct=e.loss_pct)
            if d.state != S.FAILED:
                self._drain(d, loss, e.at_s)
        else:  # zone events: step 5
            self.log.append(e.at_s, None, EventType.SCENARIO_EVENT, kind=e.type, applied=False,
                            reason="not supported yet")

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
        elif state == S.LANDING:
            self._descend(d, now, dt)
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

    def _return_plan(self, d: Drone, here: tuple[float, float], now: float) -> tuple[Target | None, PlanResult | None, str]:
        """Where the drone goes after delivering, and the route there (payload delivered)."""
        m = d.mission
        if m.after_delivery == AfterDelivery.STAY_AT_DESTINATION:
            return None, None, ""
        if m.after_delivery == AfterDelivery.RETURN_TO_START:
            plan = self._plan(d, here, m.start.lonlat, 0.0, now)
            return (m.start, plan, "") if plan.status == RouteStatus.OK else (None, None, f"return to Point A: {plan.message}")
        best: tuple[float, str, Target, PlanResult] | None = None
        reasons = []
        for st in self.world.stations:
            if not self._has_room(st.id, d.id):
                continue
            plan = self._plan(d, here, (st.longitude, st.latitude), 0.0, now)
            if plan.status != RouteStatus.OK:
                reasons.append(f"{st.name}: {plan.status.value}")
                continue
            key = (plan.distance_m, st.id)
            if best is None or key < best[:2]:
                best = (plan.distance_m, st.id, Target(st.name, st.longitude, st.latitude, st.id), plan)
        if best is None:
            return None, None, "no landing station with room is reachable" + (f" ({'; '.join(reasons)})" if reasons else "")
        return best[2], best[3], ""

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
        need = (takeoff_energy_wh(energy, m.payload_kg, m.altitude_m) + out.breakdown.energy_wh
                + energy.hover_power(m.payload_kg) * self.config.durations.delivering_s / 3600
                + (ret_plan.breakdown.energy_wh if ret_plan else 0.0) + landing_energy_wh(energy, 0.0, m.altitude_m))
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
        d.leg = Leg.from_lonlat("outbound", m.destination.label, self._leg_path(out.path_lonlat, m.start.lonlat),
                                out.breakdown.energy_wh)
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
        if d.altitude_m >= m.altitude_m - 1e-9:
            d.altitude_m = float(m.altitude_m)
            d.transition(S.CRUISE, now, self.log, "cruise altitude reached", missionId=m.id)

    def _fly(self, d: Drone, now: float, dt: float) -> None:
        leg = d.leg
        _, used, g = cruise_step(self._energy(d), d.payload_kg, leg, self.wind.at, dt)
        d.speed_mps = g
        self._set_position(d, leg)
        if not self._drain(d, used, now):
            return
        if leg.done:
            d.speed_mps = 0.0
            if d.state == S.CRUISE:
                d.transition(S.DELIVERING, now, self.log, f"arrived over {leg.target}", missionId=d.mission.id)
            else:
                d.transition(S.LANDING, now, self.log, f"arrived over {leg.target}", missionId=d.mission.id)

    def _deliver(self, d: Drone, now: float, dt: float) -> None:
        m = d.mission
        if not self._drain(d, self._energy(d).hover_power(d.payload_kg) * dt / 3600, now):
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
        # Re-plan now: wind may have changed since the pre-flight check.
        here = (d.longitude, d.latitude)
        if m.return_target and m.return_target.station_id:
            self.station_users[m.return_target.station_id].discard(d.id)
        target, plan, why = self._return_plan(d, here, now)
        if plan is None:  # fall back to the pre-flight target with a direct re-plan failure logged
            self.log.append(now, d.id, EventType.FAILURE, missionId=m.id, reason=f"no return route: {why}")
            d.transition(S.FAILED, now, self.log, "no return route")
            m.status = MissionStatus.ABORTED
            return
        if target.station_id:
            self.station_users[target.station_id].add(d.id)
        if target != m.return_target:
            self.log.append(now, d.id, EventType.REPLANNED, missionId=m.id, leg="return", target=target.label,
                            reason="return target changed after delivery")
        m.return_target = target
        m.status = MissionStatus.RETURNING
        d.leg = Leg.from_lonlat("return", target.label, self._leg_path(plan.path_lonlat, here), plan.breakdown.energy_wh)
        self.log.append(now, d.id, EventType.ROUTE_PLANNED, missionId=m.id, leg="return", target=target.label,
                        distanceM=plan.distance_m, etaS=plan.eta_s, energyWh=plan.breakdown.energy_wh)
        d.transition(S.RETURNING, now, self.log, f"returning to {target.label}", missionId=m.id)

    def _descend(self, d: Drone, now: float, dt: float) -> None:
        rate = d.profile.descent_rate_mps
        drop = min(rate * dt, d.altitude_m)
        d.altitude_m -= drop
        if not self._drain(d, self._energy(d).descent_power(d.payload_kg) * (drop / rate) / 3600, now):
            return
        if d.altitude_m <= 1e-9:
            d.altitude_m = 0.0
            self._landed(d, now)

    def _landed(self, d: Drone, now: float) -> None:
        m = d.mission
        station = self.world.station_at(d.longitude, d.latitude, self.config.position_tolerance_m)
        if m:
            m.status = MissionStatus.COMPLETED
            self.log.append(now, d.id, EventType.MISSION_COMPLETED, missionId=m.id, landedAt=station.name if station else "Point B",
                            batteryPct=d.battery_pct, plannedEnergyWh=m.planned_energy_wh)
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
