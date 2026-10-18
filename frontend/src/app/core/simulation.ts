import { DestroyRef, Injectable, InjectionToken, computed, effect, inject, signal, untracked } from '@angular/core';
import { Subscription } from 'rxjs';
import { describeHttpError } from './api';
import { MapDataService } from './map-data';
import { RouteRequest, RouteResponse } from './models';
import { PlannerApi } from './planner-api';
import { PlannerStore } from './planner.store';

/**
 * Virtual round-trip flight along calculated routes. Animation only: it never
 * connects to or controls a real drone, and it never invents geometry. The
 * outbound leg is the displayed route; the return leg is a separate route from
 * the backend (B → A, same settings), because wind and constraints can differ.
 */

/** 1× playback plays this many simulated seconds per real second. */
export const SIM_TIME_SCALE = 20;
export const SIM_SPEEDS = [1, 2, 5, 10] as const;
export type SimSpeed = (typeof SIM_SPEEDS)[number];
/** Real seconds the drone waits at Point B before returning. */
export const DWELL_REAL_S = 1.5;
/** Largest real time step taken at once (a hidden tab must not make the drone jump). */
const MAX_STEP_S = 0.25;

export type SimPhase = 'IDLE' | 'OUTBOUND' | 'AT_DESTINATION' | 'RETURNING' | 'COMPLETED' | 'STOPPED';

/** One leg: the route geometry with cumulative lengths (metres) and its simulated duration. */
export interface Leg {
  coords: [number, number][]; // [lat, lng]
  cum: number[];
  lengthM: number;
  /** Backend distance and ETA: used for the displayed distance, speed and times. */
  distanceM: number;
  etaS: number;
}

export interface SimFrame {
  lat: number;
  lng: number;
  heading: number; // degrees clockwise from north
  /** Flown parts of each leg (outbound, return), as [lat, lng] lists. */
  trails: [number, number][][];
  returnPath: [number, number][] | null;
  follow: boolean;
}

const R = 6_371_000;
const rad = (d: number) => (d * Math.PI) / 180;

export function segmentLengthM(a: [number, number], b: [number, number]): number {
  const dLat = rad(b[0] - a[0]);
  const dLng = rad(b[1] - a[1]) * Math.cos(rad((a[0] + b[0]) / 2));
  return Math.hypot(dLat, dLng) * R;
}

export function bearingDeg(a: [number, number], b: [number, number]): number {
  const [p1, p2, dl] = [rad(a[0]), rad(b[0]), rad(b[1] - a[1])];
  const y = Math.sin(dl) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

/** A leg from a route response (GeoJSON lon/lat order). Null if the route has no geometry. */
export function buildLeg(response: RouteResponse): Leg | null {
  const g = response.geometry?.coordinates;
  if (response.status !== 'OK' || !g || g.length < 2) return null;
  const coords = g.map(([lon, lat]) => [lat, lon] as [number, number]);
  const cum = [0];
  for (let i = 1; i < coords.length; i++) cum.push(cum[i - 1] + segmentLengthM(coords[i - 1], coords[i]));
  const lengthM = cum[cum.length - 1];
  const distanceM = response.distanceM ?? lengthM;
  // Without an ETA, fall back to the drone's cruise speed so the animation still moves.
  const etaS = response.etaS && response.etaS > 0 ? response.etaS : distanceM / 15;
  return { coords, cum, lengthM, distanceM, etaS };
}

/** Position on the leg after `d` metres along its exact geometry (never a shortcut). */
export function pointAt(leg: Leg, d: number): { lat: number; lng: number; heading: number; index: number } {
  const dist = Math.max(0, Math.min(leg.lengthM, d));
  let i = 1;
  while (i < leg.cum.length - 1 && leg.cum[i] < dist) i++;
  const [a, b] = [leg.coords[i - 1], leg.coords[i]];
  const seg = leg.cum[i] - leg.cum[i - 1];
  const t = seg > 0 ? (dist - leg.cum[i - 1]) / seg : 1;
  return { lat: a[0] + (b[0] - a[0]) * t, lng: a[1] + (b[1] - a[1]) * t, heading: bearingDeg(a, b), index: i };
}

/** The flown part of a leg: every vertex passed so far plus the current point. */
export function trailOf(leg: Leg, d: number): [number, number][] {
  const p = pointAt(leg, d);
  return [...leg.coords.slice(0, p.index), [p.lat, p.lng]];
}

/** Frame scheduler; tests provide a manual one. */
export interface SimScheduler {
  request(cb: (timeMs: number) => void): number;
  cancel(handle: number): void;
}
export const SIM_SCHEDULER = new InjectionToken<SimScheduler>('SIM_SCHEDULER', {
  providedIn: 'root',
  factory: () => ({
    request: (cb) => requestAnimationFrame(cb),
    cancel: (h) => cancelAnimationFrame(h),
  }),
});

type ReturnState = { state: 'none' } | { state: 'pending' } | { state: 'ok'; leg: Leg; response: RouteResponse }
  | { state: 'failed'; message: string };

@Injectable({ providedIn: 'root' })
export class SimulationService {
  private readonly store = inject(PlannerStore);
  private readonly api = inject(PlannerApi);
  private readonly mapData = inject(MapDataService);
  private readonly scheduler = inject(SIM_SCHEDULER);

  readonly phase = signal<SimPhase>('IDLE');
  readonly playing = signal(false);
  readonly speed = signal<SimSpeed>(1);
  readonly follow = signal(true);
  /** Short status such as "Destination Reached" or why the simulation stopped. */
  readonly message = signal<string | null>(null);
  readonly startError = signal<string | null>(null);

  private readonly outbound = signal<{ leg: Leg; response: RouteResponse; request: RouteRequest } | null>(null);
  private readonly ret = signal<ReturnState>({ state: 'none' });
  private readonly legIndex = signal<0 | 1>(0);
  private readonly distanceOnLeg = signal(0);
  private dwellLeft = 0;
  private handle: number | null = null;
  private lastMs: number | null = null;
  private returnSub?: Subscription;

  /** Running or paused (not idle, completed or stopped). */
  readonly active = computed(() => ['OUTBOUND', 'AT_DESTINATION', 'RETURNING'].includes(this.phase()));

  /** A ready route that matches the current inputs (points, altitude, weather, airspace version). */
  readonly canStart = computed(() => this.validRoute() !== null && !this.active());

  readonly returnState = computed(() => this.ret().state);

  readonly frame = computed<SimFrame | null>(() => {
    const out = this.outbound();
    if (!out || this.phase() === 'IDLE') return null;
    const r = this.ret();
    const back = r.state === 'ok' ? r.leg : null;
    const onReturn = this.legIndex() === 1 && back;
    const leg = onReturn ? back : out.leg;
    const d = this.distanceOnLeg();
    const p = pointAt(leg, d);
    const trails = onReturn ? [out.leg.coords, trailOf(back, d)] : [trailOf(out.leg, d)];
    return { lat: p.lat, lng: p.lng, heading: p.heading, trails, returnPath: back?.coords ?? null, follow: this.follow() };
  });

  readonly stats = computed(() => {
    const out = this.outbound();
    if (!out) return null;
    const r = this.ret();
    const back = r.state === 'ok' ? r.leg : null;
    const legs = back ? [out.leg, back] : [out.leg];
    const i = this.legIndex();
    const leg = legs[i] ?? out.leg;
    const frac = leg.lengthM > 0 ? this.distanceOnLeg() / leg.lengthM : 1;
    const doneLegs = legs.slice(0, i);
    const travelledM = doneLegs.reduce((s, l) => s + l.distanceM, 0) + frac * leg.distanceM;
    const elapsedS = doneLegs.reduce((s, l) => s + l.etaS, 0) + frac * leg.etaS;
    const totalM = legs.reduce((s, l) => s + l.distanceM, 0);
    const totalS = legs.reduce((s, l) => s + l.etaS, 0);
    const f = this.frame();
    return {
      phaseLabel: this.phaseLabel(),
      latitude: f?.lat ?? null,
      longitude: f?.lng ?? null,
      district: f ? this.mapData.districtOf({ latitude: f.lat, longitude: f.lng }) : null,
      speedKmh: this.phase() === 'OUTBOUND' || this.phase() === 'RETURNING' ? (leg.distanceM / leg.etaS) * 3.6 : 0,
      travelledM,
      remainingM: Math.max(0, totalM - travelledM),
      elapsedS,
      remainingS: Math.max(0, totalS - elapsedS),
      progressPct: totalM > 0 ? Math.min(100, (100 * travelledM) / totalM) : 0,
      returnKnown: !!back,
    };
  });

  constructor() {
    // Any change to the route or its inputs (points, altitude, mode, weather, dataset)
    // invalidates it in the store; a running simulation then stops.
    effect(() => {
      const route = this.store.route();
      untracked(() => {
        const out = this.outbound();
        if (!out || this.phase() === 'IDLE') return;
        const same = route.phase === 'ready' && route.response === out.response;
        if (!same) {
          if (this.active()) this.halt('STOPPED', 'Route settings changed. Find the route again before simulating.');
          else this.clear();
        }
      });
    });
    inject(DestroyRef).onDestroy(() => this.cancelLoop());
  }

  private validRoute(): { response: RouteResponse; request: RouteRequest; leg: Leg } | null {
    const r = this.store.route();
    const current = this.store.request();
    if (r.phase !== 'ready' || !current || JSON.stringify(r.request) !== JSON.stringify(current)) return null;
    const leg = buildLeg(r.response);
    return leg ? { response: r.response, request: r.request, leg } : null;
  }

  private phaseLabel(): string {
    switch (this.phase()) {
      case 'OUTBOUND': return 'Outbound';
      case 'AT_DESTINATION': return 'At destination';
      case 'RETURNING': return 'Returning';
      case 'COMPLETED': return 'Completed';
      case 'STOPPED': return 'Stopped';
      default: return 'Idle';
    }
  }

  start(): boolean {
    const v = this.validRoute();
    if (!v) {
      this.startError.set('Find a route for the current points and settings first.');
      return false;
    }
    this.startError.set(null);
    this.cancelLoop();
    this.returnSub?.unsubscribe();
    this.outbound.set(v);
    this.legIndex.set(0);
    this.distanceOnLeg.set(0);
    this.dwellLeft = 0;
    this.message.set(null);
    this.phase.set('OUTBOUND');
    this.requestReturn(v.request);
    this.resume();
    return true;
  }

  /** Same settings, Point B → Point A: a route of its own from the routing engine. */
  private requestReturn(outbound: RouteRequest): void {
    this.ret.set({ state: 'pending' });
    const request: RouteRequest = { ...outbound, start: outbound.destination, destination: outbound.start };
    this.returnSub = this.api.calculateRoute(request).subscribe({
      next: (res) => {
        const leg = buildLeg(res);
        this.ret.set(leg ? { state: 'ok', leg, response: res }
          : { state: 'failed', message: `No valid return route (${res.status}): ${res.message}` });
        if (this.phase() === 'AT_DESTINATION' && this.dwellLeft <= 0) this.afterDwell();
      },
      error: (err) => {
        this.ret.set({ state: 'failed', message: describeHttpError(err, 'Return route calculation failed') });
        if (this.phase() === 'AT_DESTINATION' && this.dwellLeft <= 0) this.afterDwell();
      },
    });
  }

  pause(): void {
    this.playing.set(false);
    this.cancelLoop();
  }

  resume(): void {
    if (!this.active() || this.playing()) return;
    this.playing.set(true);
    this.lastMs = null;
    this.loop();
  }

  /** Stops and removes the drone; the calculated route stays on the map. */
  stop(): void {
    this.clear();
  }

  restart(): void {
    this.clear();
    this.start();
  }

  setSpeed(s: SimSpeed): void {
    this.speed.set(s);
  }

  private loop(): void {
    this.handle = this.scheduler.request((ms) => {
      this.handle = null;
      const dt = this.lastMs === null ? 0 : (ms - this.lastMs) / 1000;
      this.lastMs = ms;
      this.advance(dt);
      if (this.playing() && this.active()) this.loop();
    });
  }

  /** Moves the simulation by `realSeconds` of playback (public for tests). */
  advance(realSeconds: number): void {
    let left = Math.max(0, realSeconds);
    while (left > 0 && this.playing() && this.active()) {
      const dt = Math.min(left, MAX_STEP_S);
      left -= dt;
      this.step(dt);
    }
  }

  private step(dt: number): void {
    if (this.phase() === 'AT_DESTINATION') {
      if (this.dwellLeft > 0) {
        this.dwellLeft -= dt;
        if (this.dwellLeft <= 0) this.afterDwell();
      }
      return;
    }
    const leg = this.currentLeg();
    if (!leg) return;
    const metresPerSimS = leg.lengthM / leg.etaS; // geometry length over the backend ETA
    const d = this.distanceOnLeg() + metresPerSimS * dt * SIM_TIME_SCALE * this.speed();
    if (d < leg.lengthM) {
      this.distanceOnLeg.set(d);
      return;
    }
    this.distanceOnLeg.set(leg.lengthM);
    if (this.phase() === 'OUTBOUND') {
      this.phase.set('AT_DESTINATION');
      this.message.set('Destination Reached');
      this.dwellLeft = DWELL_REAL_S;
    } else {
      this.halt('COMPLETED', 'Round Trip Completed');
    }
  }

  private afterDwell(): void {
    const r = this.ret();
    if (r.state === 'pending') {
      this.message.set('Destination Reached. Calculating the return route…');
      return; // continues when the return route arrives
    }
    if (r.state !== 'ok') {
      const why = r.state === 'failed' ? r.message : 'No return route.';
      this.halt('STOPPED', `Stopped at the destination. ${why}`);
      return;
    }
    this.legIndex.set(1);
    this.distanceOnLeg.set(0);
    this.message.set(null);
    this.phase.set('RETURNING');
  }

  private currentLeg(): Leg | null {
    const r = this.ret();
    if (this.legIndex() === 1) return r.state === 'ok' ? r.leg : null;
    return this.outbound()?.leg ?? null;
  }

  private halt(phase: 'COMPLETED' | 'STOPPED', message: string): void {
    this.phase.set(phase);
    this.message.set(message);
    this.playing.set(false);
    this.cancelLoop();
  }

  private clear(): void {
    this.cancelLoop();
    this.returnSub?.unsubscribe();
    this.returnSub = undefined;
    this.playing.set(false);
    this.phase.set('IDLE');
    this.outbound.set(null);
    this.ret.set({ state: 'none' });
    this.legIndex.set(0);
    this.distanceOnLeg.set(0);
    this.message.set(null);
  }

  private cancelLoop(): void {
    if (this.handle !== null) this.scheduler.cancel(this.handle);
    this.handle = null;
    this.lastMs = null;
  }
}
