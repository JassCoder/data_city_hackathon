/**
 * Smooth motion between frames (pure). A drone that stays on the same route between two
 * frames is moved along the route polyline by interpolated progress, so it follows the
 * route's corners exactly; otherwise its position is interpolated in a straight line.
 */

import { F, Frame, FrameRow, SimRoute, SimState } from './sim-models';

export interface DronePose {
  longitude: number;
  latitude: number;
  altitudeM: number;
  headingDeg: number;
  speedMps: number;
  batteryPct: number;
  progressM: number;
  state: SimState;
  /** Index into the session's routes, -1 = none. */
  route: number;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Interpolates headings along the shorter arc; the result is in [0, 360). */
export function lerpAngle(a: number, b: number, t: number): number {
  const delta = ((((b - a) % 360) + 540) % 360) - 180;
  return (((a + delta * t) % 360) + 360) % 360;
}

/** Index i of the route segment [i, i + 1] that contains distance d. */
export function segmentAt(cumM: number[], d: number): number {
  let lo = 0;
  let hi = cumM.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (cumM[mid] <= d) lo = mid;
    else hi = mid;
  }
  return Math.min(lo, Math.max(cumM.length - 2, 0));
}

/** The [lon, lat] point at distance d along a route (clamped to its ends). */
export function pointAlong(route: SimRoute, d: number): [number, number] {
  const { path, cumM } = route;
  if (path.length === 1) return path[0];
  const total = cumM[cumM.length - 1];
  const dist = Math.min(Math.max(d, 0), total);
  const i = segmentAt(cumM, dist);
  const seg = cumM[i + 1] - cumM[i];
  const t = seg > 0 ? (dist - cumM[i]) / seg : 0;
  return [lerp(path[i][0], path[i + 1][0], t), lerp(path[i][1], path[i + 1][1], t)];
}

/**
 * The part of a route already flown and the part still ahead, split at progress d
 * (both include the split point so the two lines meet).
 */
export function splitRoute(route: SimRoute, d: number): { flown: [number, number][]; ahead: [number, number][] } {
  const total = route.cumM[route.cumM.length - 1];
  const dist = Math.min(Math.max(d, 0), total);
  const i = segmentAt(route.cumM, dist);
  const here = pointAlong(route, dist);
  return { flown: [...route.path.slice(0, i + 1), here], ahead: [here, ...route.path.slice(i + 1)] };
}

export function poseOf(row: FrameRow, states: readonly SimState[]): DronePose {
  return {
    longitude: row[F.longitude],
    latitude: row[F.latitude],
    altitudeM: row[F.altitudeM],
    headingDeg: row[F.headingDeg],
    speedMps: row[F.speedMps],
    batteryPct: row[F.batteryPct],
    progressM: row[F.progressM],
    state: states[row[F.state]],
    route: row[F.route],
  };
}

/**
 * One drone between two frames; t in [0, 1]. Discrete values (state, route) are those of the
 * earlier frame until the later one is reached: a frame describes the drone from its time on.
 */
export function interpolateRow(
  a: FrameRow,
  b: FrameRow,
  t: number,
  routes: readonly SimRoute[],
  states: readonly SimState[],
): DronePose {
  const k = Math.min(Math.max(t, 0), 1);
  if (k >= 1) return poseOf(b, states);
  const pose = poseOf(a, states);
  if (k <= 0) return pose;
  const sameRoute = a[F.route] >= 0 && a[F.route] === b[F.route] && routes[a[F.route]] !== undefined;
  pose.progressM = lerp(a[F.progressM], b[F.progressM], k);
  if (sameRoute && b[F.progressM] >= a[F.progressM]) {
    [pose.longitude, pose.latitude] = pointAlong(routes[a[F.route]], pose.progressM);
  } else {
    pose.longitude = lerp(a[F.longitude], b[F.longitude], k);
    pose.latitude = lerp(a[F.latitude], b[F.latitude], k);
  }
  pose.altitudeM = lerp(a[F.altitudeM], b[F.altitudeM], k);
  pose.headingDeg = lerpAngle(a[F.headingDeg], b[F.headingDeg], k);
  pose.speedMps = lerp(a[F.speedMps], b[F.speedMps], k);
  pose.batteryPct = lerp(a[F.batteryPct], b[F.batteryPct], k);
  return pose;
}

/** Every drone's pose between two frames (alpha in [0, 1]). */
export function interpolateFrame(
  a: Frame,
  b: Frame,
  alpha: number,
  routes: readonly SimRoute[],
  states: readonly SimState[],
): DronePose[] {
  return a.d.map((row, i) => interpolateRow(row, b.d[i] ?? row, alpha, routes, states));
}
