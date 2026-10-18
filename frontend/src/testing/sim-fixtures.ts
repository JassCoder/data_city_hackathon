import { FrameScheduler } from '../app/sim/sim-session';
import { FRAME_FIELDS, Frame, FrameRow, SessionInfo, SimEvent, SimRoute, SimState, StepResponse } from '../app/sim/sim-models';

export const STATES: SimState[] = [
  'IDLE',
  'LOADING',
  'TAKEOFF',
  'CRUISE',
  'DELIVERING',
  'RETURNING',
  'LANDING',
  'CHARGING',
  'HOLDING',
  'EMERGENCY_LANDING',
  'FAILED',
];
export const code = (s: SimState) => STATES.indexOf(s);

/** An L-shaped route: 1000 m east, then 1000 m north (lengths rounded for easy maths). */
export const ROUTE: SimRoute = {
  index: 0,
  id: 'L1',
  droneId: 'd1',
  kind: 'outbound',
  target: 'Point B',
  path: [
    [21.0, 52.23],
    [21.0147, 52.23],
    [21.0147, 52.239],
  ],
  cumM: [0, 1000, 2000],
};

/** [lon, lat, alt, heading, speed, battery, progress, state, route] */
export function row(over: Partial<Record<(typeof FRAME_FIELDS)[number], number>> = {}): FrameRow {
  const base = { longitude: 21.0, latitude: 52.23, altitudeM: 0, headingDeg: 0, speedMps: 0, batteryPct: 100, progressM: 0, state: 0, route: -1 };
  const r = { ...base, ...over };
  return FRAME_FIELDS.map((f) => r[f]);
}

export function frame(t: number, rows: FrameRow[]): Frame {
  return { t, d: rows };
}

/** d1 cruising along ROUTE at 10 m/s from t0; d2 idle at its pad. */
export function cruiseFrame(t: number, t0 = 0): Frame {
  const progress = Math.max(0, (t - t0) * 10);
  const onFirstLeg = progress <= 1000;
  const lon = onFirstLeg ? 21.0 + 0.0147 * (progress / 1000) : 21.0147;
  const lat = onFirstLeg ? 52.23 : 52.23 + 0.009 * ((progress - 1000) / 1000);
  return frame(t, [
    row({ longitude: lon, latitude: lat, altitudeM: 80, headingDeg: onFirstLeg ? 90 : 0, speedMps: 10, batteryPct: 90 - t / 100, progressM: progress, state: code('CRUISE'), route: 0 }),
    row({ longitude: 21.02, latitude: 52.24 }),
  ]);
}

export function sessionInfo(over: Partial<SessionInfo> = {}): SessionInfo {
  return {
    id: 'sess1',
    scenario: { id: 'basic', name: 'Test scenario', description: 'Two drones' },
    seed: 1,
    tickS: 1,
    startTime: '2026-10-17T14:00:00+02:00',
    note: 'SIMULATION ONLY on DEMO airspace: not a check of real-world flight legality.',
    states: STATES,
    frameFields: [...FRAME_FIELDS],
    drones: [
      { id: 'd1', name: 'Courier 1', color: '#0072b2', profileId: 'P', profileName: 'Standard', batteryWh: 100, minReservePct: 20 },
      { id: 'd2', name: 'Courier 2', color: '#009e73', profileId: 'P', profileName: 'Standard', batteryWh: 100, minReservePct: 20 },
    ],
    stations: [{ id: 'st-east', name: 'East pad', longitude: 21.02, latitude: 52.24, capacity: 2 }],
    positionToleranceM: 50,
    initialWind: { speedKmh: 10, directionDeg: 270 },
    limits: {
      maxSessions: 4,
      idleTimeoutS: 1800,
      maxTicksPerStep: 600,
      historyMaxFrames: 14400,
      historyMaxFramesPerRequest: 2400,
      zoneMaxVertices: 64,
      zoneMaxDurationS: 14400,
      zoneMaxUpperM: 500,
      windMaxKmh: 100,
    },
    routes: [ROUTE],
    zones: [],
    events: [],
    frame: cruiseFrame(0),
    wind: { speedKmh: 10, directionDeg: 270 },
    tick: 0,
    timeS: 0,
    simTime: '2026-10-17T14:00:00+02:00',
    finished: false,
    history: { fromS: 0, toS: 0 },
    ...over,
  };
}

/** A step response covering (from, to], every `stride`-th tick plus the last. */
export function stepResponse(from: number, to: number, stride = 1, over: Partial<StepResponse> = {}): StepResponse {
  const ticks: number[] = [];
  for (let t = from + 1; t <= to; t++) if (t % stride === 0 || t === from + 1 || t === to) ticks.push(t);
  return {
    frames: ticks.map((t) => cruiseFrame(t)),
    events: [],
    routes: [],
    wind: { speedKmh: 10, directionDeg: 270 },
    tick: to,
    timeS: to,
    simTime: '',
    finished: false,
    history: { fromS: 0, toS: to },
    ...over,
  };
}

export function simEvent(seq: number, tS: number, type: string, details: Record<string, unknown> = {}, droneId: string | null = 'd1'): SimEvent {
  return { seq, tS, droneId, type, details };
}

/** Animation frames on demand: advance(ms) runs the pending callback at the new time. */
export class ManualScheduler implements FrameScheduler {
  t = 0;
  private cb: ((now: number) => void) | null = null;

  now(): number {
    return this.t;
  }

  request(cb: (now: number) => void): number {
    this.cb = cb;
    return 1;
  }

  cancel(): void {
    this.cb = null;
  }

  get pending(): boolean {
    return this.cb !== null;
  }

  advance(ms: number): void {
    this.t += ms;
    const cb = this.cb;
    this.cb = null;
    cb?.(this.t);
  }
}
