/**
 * Requests the simulation view sends (pure): how many ticks to step at a speed, and the
 * zone / wind / failure commands, validated against the session's limits so the user gets
 * a plain message before anything is sent. The backend validates again.
 */

import { Coordinate } from '../core/models';
import { AIRBORNE, ApiLimits, SimCommand, SimState } from './sim-models';
import { strideFor } from './timeline';

export interface StepPlan {
  ticks: number;
  stride: number;
}

export type Built<T> = { ok: true; command: T } | { ok: false; error: string };

/** One step request: enough ticks for `chunkWallS` of playback at this speed. */
export function stepPlan(
  speed: number,
  tickS: number,
  opts: { chunkWallS: number; framesPerWallSecond: number; maxTicks: number },
): StepPlan {
  const ticks = Math.min(Math.max(Math.ceil((speed * opts.chunkWallS) / tickS - 1e-9), 1), opts.maxTicks);
  return { ticks, stride: Math.min(strideFor(speed, tickS, opts.framesPerWallSecond), ticks) };
}

function cross(o: Coordinate, a: Coordinate, b: Coordinate): number {
  return (a.longitude - o.longitude) * (b.latitude - o.latitude) - (a.latitude - o.latitude) * (b.longitude - o.longitude);
}

/** Proper intersection of segments p1p2 and p3p4 (touching at an end does not count). */
export function segmentsCross(p1: Coordinate, p2: Coordinate, p3: Coordinate, p4: Coordinate): boolean {
  const d1 = cross(p3, p4, p1);
  const d2 = cross(p3, p4, p2);
  const d3 = cross(p1, p2, p3);
  const d4 = cross(p1, p2, p4);
  return d1 * d2 < 0 && d3 * d4 < 0;
}

/** True if the closed outline through these corners crosses itself. */
export function outlineCrossesItself(points: readonly Coordinate[]): boolean {
  const n = points.length;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (j === i + 1 || (i === 0 && j === n - 1)) continue; // neighbours share a corner
      if (segmentsCross(points[i], points[(i + 1) % n], points[j], points[(j + 1) % n])) return true;
    }
  }
  return false;
}

function distinct(points: readonly Coordinate[]): Coordinate[] {
  const out: Coordinate[] = [];
  for (const p of points) {
    const prev = out[out.length - 1];
    if (!prev || prev.latitude !== p.latitude || prev.longitude !== p.longitude) out.push(p);
  }
  if (out.length > 1 && out[0].latitude === out[out.length - 1].latitude && out[0].longitude === out[out.length - 1].longitude) {
    out.pop(); // the outline is closed by the backend
  }
  return out;
}

const round6 = (v: number) => Math.round(v * 1e6) / 1e6;

/** A drawn restricted zone from the ground up to the altitude cap, active for `durationMin`. */
export function zoneCommand(
  corners: readonly Coordinate[],
  opts: { upperM: number; durationMin: number; name?: string },
  limits: ApiLimits,
): Built<Extract<SimCommand, { type: 'zone' }>> {
  const pts = distinct(corners);
  if (pts.length < 3) return { ok: false, error: 'Add at least three corners.' };
  if (pts.length > limits.zoneMaxVertices) return { ok: false, error: `Use at most ${limits.zoneMaxVertices} corners.` };
  if (outlineCrossesItself(pts)) return { ok: false, error: 'The outline crosses itself. Draw it again.' };
  if (!Number.isFinite(opts.upperM) || opts.upperM <= 0 || opts.upperM > limits.zoneMaxUpperM) {
    return { ok: false, error: `Set an altitude cap between 1 and ${limits.zoneMaxUpperM} m.` };
  }
  const durationS = Math.round(opts.durationMin * 60);
  if (!Number.isFinite(durationS) || durationS <= 0 || durationS > limits.zoneMaxDurationS) {
    return { ok: false, error: `Set a duration between 1 and ${Math.floor(limits.zoneMaxDurationS / 60)} minutes.` };
  }
  const name = opts.name?.trim();
  return {
    ok: true,
    command: {
      type: 'zone',
      polygon: pts.map((p) => [round6(p.longitude), round6(p.latitude)] as [number, number]),
      lowerM: 0,
      upperM: Math.round(opts.upperM),
      durationS,
      ...(name ? { name } : {}),
    },
  };
}

/** A wind change; the direction is where the wind blows from, normalised to [0, 360). */
export function windCommand(speedKmh: number, directionDeg: number, limits: ApiLimits): Built<Extract<SimCommand, { type: 'wind' }>> {
  if (!Number.isFinite(speedKmh) || speedKmh < 0 || speedKmh > limits.windMaxKmh) {
    return { ok: false, error: `Set a wind speed between 0 and ${limits.windMaxKmh} km/h.` };
  }
  if (!Number.isFinite(directionDeg)) return { ok: false, error: 'Set a wind direction.' };
  const dir = Math.round((((directionDeg % 360) + 360) % 360) * 10) / 10;
  return { ok: true, command: { type: 'wind', speedKmh: Math.round(speedKmh * 10) / 10, directionDeg: dir === 360 ? 0 : dir } };
}

export function canFail(state: SimState | undefined): boolean {
  return state !== undefined && AIRBORNE.has(state);
}

/** Fails a flying drone (a test event). */
export function failCommand(droneId: string, state: SimState | undefined): Built<Extract<SimCommand, { type: 'drone_failure' }>> {
  if (!canFail(state)) return { ok: false, error: 'Only a flying drone can be failed.' };
  return { ok: true, command: { type: 'drone_failure', droneId } };
}
