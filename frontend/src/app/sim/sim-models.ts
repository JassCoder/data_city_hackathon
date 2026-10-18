/**
 * Wire types of the simulation session API (backend/app/sim/session.py, routers/simulations.py).
 * Coordinates are [longitude, latitude] like GeoJSON; frames are compact rows (FRAME_FIELDS).
 */

import type { Polygon } from 'geojson';

export type SimState =
  | 'IDLE'
  | 'LOADING'
  | 'TAKEOFF'
  | 'CRUISE'
  | 'DELIVERING'
  | 'RETURNING'
  | 'LANDING'
  | 'CHARGING'
  | 'HOLDING'
  | 'EMERGENCY_LANDING'
  | 'FAILED';

/** Airborne states (only these can be failed on purpose). Mirrors app/sim/states.py AIRBORNE. */
export const AIRBORNE: ReadonlySet<SimState> = new Set<SimState>([
  'TAKEOFF',
  'CRUISE',
  'DELIVERING',
  'RETURNING',
  'LANDING',
  'HOLDING',
  'EMERGENCY_LANDING',
]);

/** Column order of a frame row; must match FRAME_FIELDS in the backend (checked on session start). */
export const FRAME_FIELDS = [
  'longitude',
  'latitude',
  'altitudeM',
  'headingDeg',
  'speedMps',
  'batteryPct',
  'progressM',
  'state',
  'route',
] as const;
export const F = Object.fromEntries(FRAME_FIELDS.map((f, i) => [f, i])) as Record<(typeof FRAME_FIELDS)[number], number>;

/** One drone in one frame: [lon, lat, alt, heading, speed, battery %, progress m, state code, route index]. */
export type FrameRow = number[];

export interface Frame {
  /** Simulated seconds since the scenario start. */
  t: number;
  /** One row per drone, in SessionInfo.drones order. */
  d: FrameRow[];
}

export interface SimRoute {
  index: number;
  id: string;
  droneId: string;
  kind: 'outbound' | 'return' | 'divert' | 'emergency' | string;
  target: string;
  /** [lon, lat] vertices. */
  path: [number, number][];
  /** Cumulative distance at each vertex (the engine's metric frame), cumM[0] = 0. */
  cumM: number[];
}

export interface SimZone {
  id: string;
  name: string;
  category: string;
  lowerM: number;
  upperM: number;
  /** Drawn in this session (vs. part of the scenario). */
  drawn: boolean;
  geometry: Polygon;
}

export interface SimEvent {
  seq: number;
  tS: number;
  droneId: string | null;
  type: string;
  details: Record<string, unknown>;
}

export interface SimDroneInfo {
  id: string;
  name: string;
  color: string;
  profileId: string;
  profileName: string;
  batteryWh: number;
  minReservePct: number;
}

export interface SimStation {
  id: string;
  name: string;
  longitude: number;
  latitude: number;
  capacity: number;
}

export interface SimWind {
  speedKmh: number;
  directionDeg: number;
}

export interface ApiLimits {
  maxSessions: number;
  idleTimeoutS: number;
  maxTicksPerStep: number;
  historyMaxFrames: number;
  historyMaxFramesPerRequest: number;
  zoneMaxVertices: number;
  zoneMaxDurationS: number;
  zoneMaxUpperM: number;
  windMaxKmh: number;
}

export interface HistoryRange {
  fromS: number;
  toS: number;
}

export interface SimClock {
  tick: number;
  timeS: number;
  simTime: string;
  finished: boolean;
  history: HistoryRange;
}

export interface SessionInfo extends SimClock {
  id: string;
  scenario: { id: string | null; name: string; description: string };
  seed: number;
  tickS: number;
  startTime: string;
  note: string;
  states: SimState[];
  frameFields: string[];
  drones: SimDroneInfo[];
  stations: SimStation[];
  positionToleranceM: number;
  initialWind: SimWind;
  limits: ApiLimits;
  routes: SimRoute[];
  zones: SimZone[];
  events: SimEvent[];
  frame: Frame;
  wind: SimWind & { baseSpeedKmh?: number };
}

export interface StepResponse extends SimClock {
  frames: Frame[];
  events: SimEvent[];
  routes: SimRoute[];
  wind: SimWind;
}

export interface HistoryResponse {
  stride: number;
  frames: Frame[];
  available: HistoryRange;
}

export interface InjectResponse extends SimClock {
  scheduled: Record<string, unknown>[];
  zone: SimZone | null;
}

export interface ScenarioSummary {
  id: string;
  name: string;
  description: string;
  drones: number;
  missions: number;
  events: number;
  seed: number;
}

export interface CostTerm {
  term: string;
  weight: number;
  mean: number;
  cost: number;
}

export interface LegBreakdown {
  totalCost: number;
  lengthM: number;
  terms: CostTerm[];
  energyWh: number;
  verticalEnergyWh: number;
  flightTimeS: number;
  note: string;
}

export interface MissionSnapshot {
  id: string;
  status: string;
  start: { label: string; latitude: number; longitude: number; stationId: string | null };
  destination: { label: string; latitude: number; longitude: number; stationId: string | null };
  mode: string;
  routeObjective: string;
  altitudeM: number;
  payloadKg: number;
  afterDelivery: string;
  returnTarget: { label: string } | null;
  plannedEnergyWh: number | null;
  energyUsedWh: number;
  faultLossWh: number;
  breakdowns: Partial<Record<'outbound' | 'return' | 'divert', LegBreakdown>>;
}

export interface EnergyReport {
  missionId: string;
  current: boolean;
  plannedWh: number | null;
  usedWh: number;
  faultLossWh: number;
  toFinishWh: number | null;
  projectedWh: number | null;
  batteryWh: number;
  reserveWh: number;
}

export interface DroneDetail extends SimClock {
  drone: { id: string; name: string; state: SimState; batteryPct: number; leg: { target: string; kind: string } | null };
  mission: MissionSnapshot | null;
  missionActive: boolean;
  energy: EnergyReport | null;
  missions: { id: string; status: string; plannedEnergyWh: number | null; energyUsedWh: number }[];
}

export type SimCommand =
  | { type: 'zone'; polygon: [number, number][]; lowerM: number; upperM: number; durationS: number; name?: string }
  | { type: 'wind'; speedKmh: number; directionDeg: number }
  | { type: 'drone_failure'; droneId: string };
