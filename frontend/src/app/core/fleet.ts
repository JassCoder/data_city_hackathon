/**
 * Pure fleet logic (no Angular, no HTTP): drone records, route invalidation,
 * the mapping to the backend request, validation, crossing detection and the
 * playback points kept ready for a future animation. FleetStore wires it up.
 */

import { ALTITUDE, Coordinate, FlightMode, PointRole, RouteRequest, RouteResponse, SelectedLocation, WeatherMode, isValidAltitude, isValidCoordinate } from './models';
import { OptimisationId, optimisation } from './routing-options';

/** Colour-blind-safe drone colours (Okabe-Ito / Tol based); no red, amber or yellow, which mean airspace. */
export const DRONE_COLORS = ['#0072b2', '#009e73', '#b05fa0', '#332288', '#2a9dcc', '#5c7f1e', '#7a4fb5', '#1f6f8b'] as const;

export type DroneRoute =
  | { phase: 'draft' }
  | { phase: 'calculating'; previous?: RouteResponse }
  | { phase: 'ready'; response: RouteResponse; request: RouteRequest }
  | { phase: 'stale'; response: RouteResponse; request: RouteRequest }
  | { phase: 'error'; message: string };

export interface Drone {
  id: string;
  name: string;
  color: string;
  start: SelectedLocation | null;
  destination: SelectedLocation | null;
  mode: FlightMode;
  optimisation: OptimisationId;
  altitude: number;
  /** Always the default (Standard) profile; not shown in the UI. */
  profileId: string;
  /** Show the route and markers on the map. */
  visible: boolean;
  route: DroneRoute;
  /** Per-point validation messages (e.g. outside Warsaw). */
  notices: Partial<Record<PointRole, string>>;
}

export interface DroneDefaults {
  altitude: number;
  profileId: string;
}

/** Changing any of these makes a calculated route outdated. */
const ROUTE_FIELDS = ['start', 'destination', 'mode', 'optimisation', 'altitude', 'profileId'] as const;
export type DronePatch = Partial<Omit<Drone, 'id' | 'route'>>;

export function nextName(drones: Drone[]): string {
  const used = new Set(drones.map((d) => d.name));
  let n = drones.length + 1;
  while (used.has(`Drone ${n}`)) n++;
  return `Drone ${n}`;
}

/** First palette colour not in use (cycles once all are taken). */
export function nextColor(drones: Drone[]): string {
  const used = new Set(drones.map((d) => d.color));
  return DRONE_COLORS.find((c) => !used.has(c)) ?? DRONE_COLORS[drones.length % DRONE_COLORS.length];
}

export function createDrone(drones: Drone[], id: string, defaults: DroneDefaults): Drone {
  return {
    id,
    name: nextName(drones),
    color: nextColor(drones),
    start: null,
    destination: null,
    mode: 'NORMAL',
    optimisation: 'BALANCED',
    altitude: defaults.altitude,
    profileId: defaults.profileId,
    visible: true,
    route: { phase: 'draft' },
    notices: {},
  };
}

/** A copy with its own name, colour and id; the route has to be calculated again. */
export function duplicateDrone(drones: Drone[], source: Drone, id: string): Drone {
  const base = `${source.name} copy`;
  let name = base;
  for (let i = 2; drones.some((d) => d.name === name); i++) name = `${base} ${i}`;
  return { ...source, id, name, color: nextColor(drones), visible: true, route: { phase: 'draft' }, notices: {} };
}

/** What happens to a route when its inputs change: results stay visible as outdated. */
export function invalidateRoute(route: DroneRoute): DroneRoute {
  switch (route.phase) {
    case 'ready':
      return { phase: 'stale', response: route.response, request: route.request };
    case 'calculating': // the store cancels the request
    case 'error':
      return { phase: 'draft' };
    default:
      return route;
  }
}

export function changesRoute(drone: Drone, patch: DronePatch): boolean {
  return ROUTE_FIELDS.some((k) => k in patch && patch[k] !== drone[k]);
}

/** Applies a patch; route-relevant changes invalidate the drone's route. */
export function updateDrone(drones: Drone[], id: string, patch: DronePatch): Drone[] {
  return drones.map((d) => {
    if (d.id !== id) return d;
    const next = { ...d, ...patch };
    return changesRoute(d, patch) ? { ...next, route: invalidateRoute(d.route) } : next;
  });
}

export function setRoute(drones: Drone[], id: string, route: DroneRoute): Drone[] {
  return drones.map((d) => (d.id === id ? { ...d, route } : d));
}

export function swapPatch(d: Drone): DronePatch {
  return { start: d.destination, destination: d.start, notices: {} };
}

// --- validation and request mapping -----------------------------------------------------

/** Plain-language reasons why a drone cannot be calculated yet (empty = ready). */
export function droneIssues(d: Drone): string[] {
  const issues: string[] = [];
  if (!d.start) issues.push('Set Point A.');
  else if (!isValidCoordinate(d.start.coordinate)) issues.push('Point A has invalid coordinates.');
  if (!d.destination) issues.push('Set Point B.');
  else if (!isValidCoordinate(d.destination.coordinate)) issues.push('Point B has invalid coordinates.');
  if (d.start && d.destination && sameCoordinate(d.start.coordinate, d.destination.coordinate)) {
    issues.push('Point A and Point B must be different.');
  }
  if (!isValidAltitude(d.altitude)) {
    issues.push(`Altitude must be ${ALTITUDE.min}–${ALTITUDE.max} m in ${ALTITUDE.step} m steps.`);
  }
  if (d.notices.start) issues.push(d.notices.start);
  if (d.notices.destination) issues.push(d.notices.destination);
  return issues;
}

export function sameCoordinate(a: Coordinate, b: Coordinate): boolean {
  return a.latitude === b.latitude && a.longitude === b.longitude;
}

/** The backend request for a drone (mode + the optimisation's objective), or null while it is invalid. */
export function toRouteRequest(d: Drone, weatherMode: WeatherMode): RouteRequest | null {
  if (droneIssues(d).length) return null;
  return {
    start: { latitude: d.start!.coordinate.latitude, longitude: d.start!.coordinate.longitude },
    destination: { latitude: d.destination!.coordinate.latitude, longitude: d.destination!.coordinate.longitude },
    mode: d.mode,
    flightAltitudeMeters: d.altitude,
    droneProfileId: d.profileId,
    weatherMode,
    routeObjective: optimisation(d.optimisation).objective,
  };
}

// --- status ---------------------------------------------------------------------------------

export type DroneStatus = 'draft' | 'calculating' | 'ready' | 'no-route' | 'outdated' | 'error';

export function droneStatus(d: Drone): DroneStatus {
  switch (d.route.phase) {
    case 'calculating':
      return 'calculating';
    case 'error':
      return 'error';
    case 'stale':
      return 'outdated';
    case 'ready':
      return d.route.response.status === 'OK' ? 'ready' : 'no-route';
    default:
      return 'draft';
  }
}

export const STATUS_TEXT: Record<DroneStatus, string> = {
  draft: 'Draft',
  calculating: 'Calculating…',
  ready: 'Route ready',
  'no-route': 'No feasible route',
  outdated: 'Outdated',
  error: 'Error',
};

/** The response to draw/explain: a fresh result or an outdated one. */
export function shownResponse(d: Drone): RouteResponse | undefined {
  const r = d.route;
  if (r.phase === 'ready' || r.phase === 'stale') return r.response;
  if (r.phase === 'calculating') return r.previous;
  return undefined;
}

/** Short place name for list entries ("Warszawa Centralna" from a long Nominatim label). */
export function shortLabel(loc: SelectedLocation | null): string {
  if (!loc) return '—';
  return loc.label.split(',')[0].trim();
}

// --- crossings -------------------------------------------------------------------------------

type LonLat = [number, number];

/** Intersection point of segments p1-p2 and p3-p4 (planar lon/lat; fine at city scale). */
export function segmentIntersection(p1: LonLat, p2: LonLat, p3: LonLat, p4: LonLat): LonLat | null {
  const d = (p2[0] - p1[0]) * (p4[1] - p3[1]) - (p2[1] - p1[1]) * (p4[0] - p3[0]);
  if (d === 0) return null; // parallel or collinear
  const t = ((p3[0] - p1[0]) * (p4[1] - p3[1]) - (p3[1] - p1[1]) * (p4[0] - p3[0])) / d;
  const u = ((p3[0] - p1[0]) * (p2[1] - p1[1]) - (p3[1] - p1[1]) * (p2[0] - p1[0])) / d;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return [p1[0] + t * (p2[0] - p1[0]), p1[1] + t * (p2[1] - p1[1])];
}

export function firstCrossing(a: LonLat[], b: LonLat[]): LonLat | null {
  for (let i = 0; i < a.length - 1; i++) {
    for (let j = 0; j < b.length - 1; j++) {
      const p = segmentIntersection(a[i], a[i + 1], b[j], b[j + 1]);
      if (p) return p;
    }
  }
  return null;
}

export interface Crossing {
  otherId: string;
  otherName: string;
  point: Coordinate;
}

/**
 * Visible drones with ready routes whose lines cross while flying within `bandM`
 * of each other's altitude. A simple warning only, not collision avoidance.
 */
export function findCrossings(drones: Drone[], bandM: number): Map<string, Crossing[]> {
  const out = new Map<string, Crossing[]>();
  const ready = drones.filter(
    (d) => d.visible && d.route.phase === 'ready' && d.route.response.status === 'OK' && d.route.response.geometry,
  );
  for (let i = 0; i < ready.length; i++) {
    for (let j = i + 1; j < ready.length; j++) {
      const [a, b] = [ready[i], ready[j]];
      const ra = (a.route as { response: RouteResponse }).response;
      const rb = (b.route as { response: RouteResponse }).response;
      if (Math.abs(ra.flightAltitudeMeters - rb.flightAltitudeMeters) > bandM) continue;
      const p = firstCrossing(ra.geometry!.coordinates, rb.geometry!.coordinates);
      if (!p) continue;
      const point = { longitude: p[0], latitude: p[1] };
      out.set(a.id, [...(out.get(a.id) ?? []), { otherId: b.id, otherName: b.name, point }]);
      out.set(b.id, [...(out.get(b.id) ?? []), { otherId: a.id, otherName: a.name, point }]);
    }
  }
  return out;
}

// --- playback (ready for a future animation) ------------------------------------------------

export interface PlaybackPoint {
  latitude: number;
  longitude: number;
  /** Seconds after take-off. */
  tS: number;
}

function metres(a: LonLat, b: LonLat): number {
  const R = 6371008.8;
  const toRad = Math.PI / 180;
  const dLat = (b[1] - a[1]) * toRad;
  const dLon = (b[0] - a[0]) * toRad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * toRad) * Math.cos(b[1] * toRad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/**
 * Timestamped route points. The backend returns only the total ETA, so time is
 * spread over the route in proportion to distance (an approximation: wind makes
 * real segment speeds differ).
 */
export function playbackPoints(response: RouteResponse): PlaybackPoint[] {
  const coords = response.geometry?.coordinates;
  if (!coords?.length || response.etaS === null) return [];
  const cum = [0];
  for (let i = 1; i < coords.length; i++) cum.push(cum[i - 1] + metres(coords[i - 1], coords[i]));
  const total = cum[cum.length - 1] || 1;
  return coords.map(([lon, lat], i) => ({ latitude: lat, longitude: lon, tS: (response.etaS! * cum[i]) / total }));
}
