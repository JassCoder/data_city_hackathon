import { Injectable, InjectionToken, OnDestroy, computed, inject, signal } from '@angular/core';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Observable } from 'rxjs';

import { API_BASE_URL, describeHttpError } from '../core/api';
import { SETTINGS } from '../core/settings';
import { stepPlan } from './commands';
import { eventPlace } from './event-feed';
import { DronePose, interpolateFrame } from './interpolation';
import {
  DroneDetail,
  FRAME_FIELDS,
  HistoryRange,
  HistoryResponse,
  InjectResponse,
  SessionInfo,
  SimClock,
  SimCommand,
  SimEvent,
  SimRoute,
  SimZone,
  StepResponse,
} from './sim-models';
import { FrameBuffer } from './snapshot-buffer';
import { PlaybackMode, activeZoneIdsAt, clampTime, historyWindow, modeAt, strideFor, windAt } from './timeline';

const CFG = SETTINGS.sim;
const SESSION_KEY = 'skyroute.sim.session';

/** Animation-frame clock, injectable so tests can drive playback by hand. */
export interface FrameScheduler {
  now(): number;
  request(cb: (now: number) => void): number;
  cancel(id: number): void;
}

export const FRAME_SCHEDULER = new InjectionToken<FrameScheduler>('FRAME_SCHEDULER', {
  providedIn: 'root',
  factory: () => ({
    now: () => performance.now(),
    request: (cb) => requestAnimationFrame(cb),
    cancel: (id) => cancelAnimationFrame(id),
  }),
});

export type SimPhase = 'idle' | 'starting' | 'ready' | 'error';
export type Connection = 'online' | 'reconnecting' | 'disconnected';

export interface DroneTelemetry {
  id: string;
  name: string;
  color: string;
  pose: DronePose;
  target: string | null;
  /** 0..1 along the current route, null without one. */
  progress: number | null;
  /** Seconds to the end of the current route at the current speed, null when not flying along one. */
  etaS: number | null;
}

/** What the map renderer gets every animation frame. */
export interface PlaybackFrame {
  t: number;
  poses: DronePose[];
}

/** One-shot request to centre the map (jump to an event). */
export interface FocusRequest {
  droneId: string | null;
  place: [number, number] | null;
  nonce: number;
}

const MOVING = new Set(['CRUISE', 'RETURNING', 'EMERGENCY_LANDING']);

/**
 * One simulation session in the browser: talks to /simulations, buffers frames and runs the
 * playback loop. Panels read signals refreshed every `uiRefreshMs`; the map renderer gets
 * interpolated poses every animation frame through onFrame(), outside change detection.
 * Provided by the simulation page, so leaving the page stops the loop.
 */
@Injectable()
export class SimSession implements OnDestroy {
  private readonly http = inject(HttpClient);
  private readonly clock = inject(FRAME_SCHEDULER);
  private readonly base = `${API_BASE_URL}/simulations`;

  readonly phase = signal<SimPhase>('idle');
  readonly error = signal<string | null>(null);
  readonly connection = signal<Connection>('online');
  readonly info = signal<SessionInfo | null>(null);
  readonly playing = signal(false);
  readonly speed = signal<number>(CFG.defaultSpeed);
  readonly mode = signal<PlaybackMode>('LIVE');
  /** Newest simulated time on the server (the client buffers ahead of the playhead). */
  readonly headT = signal(0);
  /** Newest time the playhead has shown: the end of the timeline (frames buffered beyond it stay hidden). */
  readonly seenT = signal(0);
  /** What the scrubber spans: stored history up to the newest time shown. */
  readonly timeline = computed<HistoryRange>(() => {
    const h = this.history();
    return { fromS: h.fromS, toS: Math.max(h.fromS, Math.min(this.seenT(), h.toS)) };
  });
  readonly history = signal<HistoryRange>({ fromS: 0, toS: 0 });
  readonly finished = signal(false);
  /** The playhead, refreshed for panels (the exact value is `clockT`). */
  readonly playT = signal(0);
  /** Waiting for frames (the playhead caught up with what has been received). */
  readonly buffering = signal(false);
  readonly events = signal<SimEvent[]>([]);
  readonly zones = signal<SimZone[]>([]);
  readonly routeCount = signal(0);
  readonly telemetry = signal<DroneTelemetry[]>([]);
  readonly selectedId = signal<string | null>(null);
  readonly follow = signal(false);
  readonly detail = signal<DroneDetail | null>(null);
  readonly focus = signal<FocusRequest | null>(null);

  readonly activeZoneIds = computed(() => activeZoneIdsAt(this.events(), this.playT()));
  readonly wind = computed(() => {
    const info = this.info();
    return info ? windAt(this.events(), this.playT(), info.initialWind) : null;
  });
  readonly selected = computed(() => this.telemetry().find((d) => d.id === this.selectedId()) ?? null);

  /** Frames for interpolation and trails. */
  readonly buffer = new FrameBuffer();
  /** Every route geometry received; frames refer to them by index. */
  readonly routes: SimRoute[] = [];
  /** The exact playhead (simulated seconds). */
  clockT = 0;

  private rafId: number | null = null;
  private lastNow: number | null = null;
  private lastUi = -Infinity;
  private lastDetail = -Infinity;
  private inFlight = false;
  private failures = 0;
  private retryAt = 0;
  /** Bumped on seek/go-live: frames requested for an older playhead are not buffered. */
  private epoch = 0;
  /** Bumped whenever a session is adopted (start, resume, reset): older responses are ignored. */
  private generation = 0;
  /** Work that must not overlap a request in flight (reset, single step), run when it finishes. */
  private afterFlight: (() => void) | null = null;
  /** Load the trail behind the playhead (after a resume, where only the newest frame is known). */
  private trailWanted = false;
  private dirty = true;
  private focusNonce = 0;
  private readonly listeners = new Set<(f: PlaybackFrame) => void>();

  // --- session lifecycle -------------------------------------------------------------------

  /** Starts a new session from a scenario file or an inline scenario (paused at time 0). */
  start(source: { scenarioId: string } | { scenario: unknown }, seed?: number): void {
    this.phase.set('starting');
    this.error.set(null);
    this.playing.set(false);
    const body = { ...source, ...(seed !== undefined ? { seed } : {}) };
    this.http.post<SessionInfo>(this.base, body).subscribe({
      next: (info) => this.adopt(info),
      error: (err) => this.fail(describeHttpError(err, 'Could not start the simulation')),
    });
  }

  /** Reconnects to the session of this browser tab after a reload, if it still exists. */
  resume(): boolean {
    let id: string | null = null;
    try {
      id = sessionStorage.getItem(SESSION_KEY);
    } catch {
      /* storage unavailable */
    }
    if (!id) return false;
    this.phase.set('starting');
    this.http.get<SessionInfo>(`${this.base}/${id}`).subscribe({
      next: (info) => this.adopt(info),
      error: () => {
        this.forget();
        this.phase.set('idle');
      },
    });
    return true;
  }

  /** Back to time 0 with the same scenario and seed (added events are dropped). */
  reset(): void {
    const info = this.info();
    if (!info) return;
    this.playing.set(false);
    if (this.inFlight) {
      this.afterFlight = () => this.reset();
      return;
    }
    this.request(this.http.post<SessionInfo>(`${this.base}/${info.id}/reset`, {}), (fresh) => this.adopt(fresh));
  }

  /** Ends the session on the server and returns to the scenario picker. */
  close(): void {
    const info = this.info();
    this.stopLoop();
    if (info) this.http.delete(`${this.base}/${info.id}`).subscribe({ error: () => undefined });
    this.forget();
    this.info.set(null);
    this.phase.set('idle');
    this.playing.set(false);
    this.selectedId.set(null);
    this.detail.set(null);
  }

  private adopt(info: SessionInfo): void {
    if (info.frameFields.join() !== FRAME_FIELDS.join()) {
      this.fail('The simulation API sends frames this page does not understand. Reload the page.');
      return;
    }
    this.epoch++;
    this.generation++;
    this.info.set(info);
    this.routes.length = 0;
    this.routes.push(...info.routes);
    this.routeCount.set(this.routes.length);
    this.zones.set(info.zones);
    this.events.set(info.events);
    this.applyClock(info);
    this.buffer.clear();
    this.buffer.push([info.frame]);
    this.clockT = info.timeS;
    this.seenT.set(info.timeS);
    this.trailWanted = info.timeS > info.history.fromS;
    this.mode.set('LIVE');
    this.failures = 0;
    this.connection.set('online');
    this.phase.set('ready');
    this.detail.set(null);
    if (this.selectedId() && !info.drones.some((d) => d.id === this.selectedId())) this.selectedId.set(null);
    try {
      sessionStorage.setItem(SESSION_KEY, info.id);
    } catch {
      /* storage unavailable */
    }
    this.refreshUi(true);
    this.dirty = true;
    this.startLoop();
  }

  private forget(): void {
    try {
      sessionStorage.removeItem(SESSION_KEY);
    } catch {
      /* storage unavailable */
    }
  }

  private fail(message: string): void {
    this.error.set(message);
    this.phase.set('error');
    this.playing.set(false);
  }

  // --- playback controls --------------------------------------------------------------------

  play(): void {
    if (this.phase() !== 'ready') return;
    if (this.finished() && this.mode() === 'LIVE' && this.clockT >= this.headT() - 1e-6) return;
    this.lastNow = null;
    this.playing.set(true);
  }

  pause(): void {
    this.playing.set(false);
  }

  togglePlay(): void {
    this.playing() ? this.pause() : this.play();
  }

  setSpeed(speed: number): void {
    this.speed.set(speed);
  }

  /** One tick forward (pauses first). */
  stepOnce(): void {
    const info = this.info();
    if (!info || this.phase() !== 'ready') return;
    this.pause();
    const next = this.clockT + info.tickS;
    if (next <= this.headT() + 1e-9) {
      if (this.mode() === 'LIVE') {
        this.clockT = next; // already buffered
        this.dirty = true;
        this.refreshUi(true);
      } else this.seek(next);
      return;
    }
    if (this.inFlight) {
      this.afterFlight = () => this.stepOnce();
      return;
    }
    const gen = this.generation;
    this.request(this.http.post<StepResponse>(`${this.base}/${info.id}/step`, { ticks: 1, stride: 1 }), (res) => {
      if (gen !== this.generation) return;
      this.takeStep(res, this.epoch);
      this.clockT = res.timeS;
      this.dirty = true;
      this.refreshUi(true);
    });
  }

  /** Moves the playhead (scrubber, event jump). Times before the stored history are clamped. */
  seek(t: number): void {
    const info = this.info();
    if (!info) return;
    const target = clampTime(t, this.timeline());
    const mode = modeAt(target, this.seenT(), info.tickS);
    if (mode === 'LIVE') {
      this.goLive();
      return;
    }
    this.mode.set('REPLAY');
    this.clockT = target;
    if (!this.buffer.covers(target)) {
      this.epoch++;
      this.buffer.clear(); // fill() loads the window around the new playhead
    }
    this.dirty = true;
    this.refreshUi(true);
  }

  /** Back to the newest simulated time. */
  goLive(): void {
    const info = this.info();
    if (!info) return;
    this.mode.set('LIVE');
    this.clockT = Math.max(this.clockT, this.seenT());
    if (!this.buffer.covers(this.clockT)) {
      this.epoch++;
      this.buffer.clear(); // fill() loads the last stretch before stepping on
    }
    this.dirty = true;
    this.refreshUi(true);
  }

  select(id: string | null): void {
    if (id === this.selectedId()) return;
    this.selectedId.set(id);
    this.detail.set(null);
    this.lastDetail = -Infinity;
    if (!id) this.follow.set(false);
  }

  /** Jumps to an event's time and centres the map on where it happened. */
  jumpTo(e: SimEvent): void {
    if (e.droneId) this.select(e.droneId);
    this.seek(e.tS);
    this.focus.set({ droneId: e.droneId, place: eventPlace(e), nonce: ++this.focusNonce });
  }

  /** Sends a command; resolves with the scheduled events or rejects with a plain message. */
  inject(cmd: SimCommand): Promise<InjectResponse> {
    const info = this.info();
    if (!info) return Promise.reject(new Error('No simulation is running.'));
    if (this.mode() !== 'LIVE') return Promise.reject(new Error('Go live to change the simulation.'));
    return new Promise((resolve, reject) => {
      this.http.post<InjectResponse>(`${this.base}/${info.id}/events`, cmd).subscribe({
        next: (res) => {
          if (res.zone) this.zones.update((zs) => [...zs.filter((z) => z.id !== res.zone!.id), res.zone!]);
          resolve(res);
        },
        error: (err) => reject(new Error(describeHttpError(err, 'The change was not accepted'))),
      });
    });
  }

  /** Registers the map renderer; returns the unsubscribe function. */
  onFrame(listener: (f: PlaybackFrame) => void): () => void {
    this.listeners.add(listener);
    this.dirty = true;
    return () => this.listeners.delete(listener);
  }

  /** Interpolated poses of every drone at time t (from the buffered frames). */
  posesAt(t: number): DronePose[] | null {
    const info = this.info();
    const br = this.buffer.bracket(t);
    if (!info || !br) return null;
    return interpolateFrame(br.a, br.b, br.alpha, this.routes, info.states);
  }

  ngOnDestroy(): void {
    this.stopLoop();
  }

  // --- the loop ----------------------------------------------------------------------------

  private startLoop(): void {
    if (this.rafId === null) this.rafId = this.clock.request((now) => this.frame(now));
  }

  private stopLoop(): void {
    if (this.rafId !== null) this.clock.cancel(this.rafId);
    this.rafId = null;
    this.lastNow = null;
  }

  /** One animation frame: advance the playhead, keep the buffer filled, notify the renderer. */
  frame(now: number): void {
    this.rafId = null;
    const info = this.info();
    if (!info || this.phase() !== 'ready') return;
    const dt = this.lastNow === null ? 0 : Math.min((now - this.lastNow) / 1000, 0.25);
    this.lastNow = now;

    if (this.playing()) {
      const limit = this.mode() === 'LIVE' ? Math.min(this.headT(), this.bufferedUntil()) : this.bufferedUntil();
      const target = this.clockT + dt * this.speed();
      this.buffering.set(target > limit + 1e-9 && !(this.mode() === 'LIVE' && this.finished()));
      const next = Math.max(this.clockT, Math.min(target, limit));
      if (next !== this.clockT) {
        this.clockT = next;
        this.dirty = true;
      }
      if (this.mode() === 'REPLAY' && this.clockT >= this.seenT() - info.tickS / 2) this.mode.set('LIVE');
      if (this.mode() === 'LIVE' && this.finished() && this.clockT >= this.headT() - 1e-9) this.playing.set(false);
    } else {
      this.buffering.set(false);
    }

    this.fill(now);
    this.buffer.trimBefore(this.clockT - CFG.trailS);

    if (this.dirty && this.listeners.size) {
      const poses = this.posesAt(this.clockT);
      if (poses) for (const l of this.listeners) l({ t: this.clockT, poses });
      this.dirty = false;
    }
    if (now - this.lastUi >= CFG.uiRefreshMs) {
      this.lastUi = now;
      this.refreshUi(false);
    }
    if (this.selectedId() && now - this.lastDetail >= CFG.detailRefreshMs && (this.playing() || !this.detail())) {
      this.lastDetail = now;
      this.loadDetail();
    }
    this.startLoop();
  }

  /** Requests what the playhead will need next: live steps or stored history. */
  private fill(now: number): void {
    const info = this.info()!;
    if (this.inFlight || now < this.retryAt) return;
    const speed = this.speed();
    const lead = CFG.leadWallS * speed;
    if (!this.buffer.size || !this.buffer.covers(this.clockT) || this.trailWanted) {
      this.trailWanted = false;
      // After a seek, a resume or going live: the trail behind the playhead and some playback ahead.
      const ahead = this.mode() === 'LIVE' ? 0 : CFG.replayAheadWallS;
      const w = historyWindow(this.clockT, speed, this.history(), ahead, CFG.trailS);
      this.loadHistory(w.fromS, this.mode() === 'LIVE' ? this.clockT : w.toS, this.historyStride());
      return;
    }
    if (this.mode() === 'LIVE') {
      if (!this.playing() || this.finished() || this.headT() - this.clockT >= lead) return;
      const plan = stepPlan(speed, info.tickS, {
        chunkWallS: CFG.chunkWallS,
        framesPerWallSecond: CFG.framesPerWallSecond,
        maxTicks: info.limits.maxTicksPerStep,
      });
      const epoch = this.epoch;
      const gen = this.generation;
      this.request(this.http.post<StepResponse>(`${this.base}/${info.id}/step`, plan), (res) => {
        if (gen === this.generation) this.takeStep(res, epoch);
      });
    } else {
      const until = this.bufferedUntil();
      const end = this.timeline().toS;
      if (until >= end - 1e-9 || until - this.clockT >= lead) return;
      this.loadHistory(until, Math.min(until + CFG.replayAheadWallS * speed, end), this.historyStride());
    }
  }

  private bufferedUntil(): number {
    return this.buffer.last?.t ?? this.clockT;
  }

  private historyStride(): number {
    const info = this.info();
    return info ? strideFor(this.speed(), info.tickS, CFG.framesPerWallSecond) : 1;
  }

  private loadHistory(fromS: number, toS: number, stride: number): void {
    const info = this.info();
    if (!info || toS < fromS) return;
    const epoch = this.epoch;
    const gen = this.generation;
    const params = { fromS, toS, stride };
    this.request(this.http.get<HistoryResponse>(`${this.base}/${info.id}/history`, { params }), (res) => {
      if (epoch !== this.epoch || gen !== this.generation) return;
      this.buffer.push(res.frames);
      this.history.set(res.available);
      this.dirty = true;
    });
  }

  /** Applies a step: events, routes and the clock always; frames only for the live playhead. */
  private takeStep(res: StepResponse, epoch: number): void {
    if (res.routes.length) {
      for (const r of res.routes) this.routes[r.index] = r;
      this.routeCount.set(this.routes.length);
    }
    if (res.events.length) {
      const known = this.events();
      const fresh = res.events.filter((e) => e.seq >= known.length);
      if (fresh.length && fresh[0].seq === known.length) this.events.set([...known, ...fresh]);
      else if (fresh.length) this.resyncEvents(known.length);
    }
    this.applyClock(res);
    if (epoch === this.epoch && this.mode() === 'LIVE') this.buffer.push(res.frames);
    this.dirty = true;
  }

  /** Fetches events missed after a gap (never expected with one request in flight; kept as a safety net). */
  private resyncEvents(fromSeq: number): void {
    const info = this.info();
    if (!info) return;
    const gen = this.generation;
    this.http.get<{ events: SimEvent[] }>(`${this.base}/${info.id}/events`, { params: { fromSeq } }).subscribe({
      next: (res) => {
        if (gen !== this.generation) return;
        const known = this.events();
        const fresh = res.events.filter((e) => e.seq >= known.length);
        if (fresh.length && fresh[0].seq === known.length) this.events.set([...known, ...fresh]);
      },
      error: () => undefined,
    });
  }

  private applyClock(c: SimClock): void {
    this.headT.set(c.timeS);
    this.history.set(c.history);
    this.finished.set(c.finished);
  }

  /** One request at a time; network and server errors back off and retry. */
  private request<T>(obs: Observable<T>, done: (res: T) => void): void {
    this.inFlight = true;
    obs.subscribe({
      next: (res) => {
        this.inFlight = false;
        this.failures = 0;
        this.connection.set('online');
        done(res);
        this.runQueued();
      },
      error: (err) => {
        this.inFlight = false;
        this.requestFailed(err);
        this.runQueued();
      },
    });
  }

  private runQueued(): void {
    const next = this.afterFlight;
    this.afterFlight = null;
    next?.();
  }

  private requestFailed(err: unknown): void {
    if (err instanceof HttpErrorResponse && err.status === 404) {
      this.forget();
      this.fail('This simulation session has ended (it expired or the backend restarted). Start it again.');
      return;
    }
    if (err instanceof HttpErrorResponse && (err.status === 0 || err.status >= 500)) {
      const delays = CFG.retryDelaysMs;
      this.failures++;
      this.connection.set(this.failures > delays.length ? 'disconnected' : 'reconnecting');
      this.retryAt = this.clock.now() + delays[Math.min(this.failures - 1, delays.length - 1)];
      return;
    }
    this.error.set(describeHttpError(err, 'The simulation request failed'));
  }

  /** Retry now (from the "disconnected" banner). */
  retryNow(): void {
    this.retryAt = 0;
    if (this.failures > 0) this.connection.set('reconnecting');
  }

  private loadDetail(): void {
    const info = this.info();
    const id = this.selectedId();
    if (!info || !id) return;
    this.http.get<DroneDetail>(`${this.base}/${info.id}/drones/${id}`).subscribe({
      next: (d) => {
        if (this.selectedId() === id) this.detail.set(d);
      },
      error: () => undefined, // the next refresh tries again; connection state comes from stepping
    });
  }

  /** Panels: playhead and telemetry (every uiRefreshMs, or at once after a jump). */
  private refreshUi(force: boolean): void {
    const info = this.info();
    if (!info) return;
    if (!force && this.playT() === this.clockT && !this.dirty && this.telemetry().length) return;
    this.playT.set(this.clockT);
    if (this.mode() === 'LIVE' && this.clockT > this.seenT()) this.seenT.set(this.clockT);
    const poses = this.posesAt(this.clockT);
    if (!poses) return;
    this.telemetry.set(
      info.drones.map((d, i) => {
        const pose = poses[i];
        const route = pose.route >= 0 ? this.routes[pose.route] : undefined;
        const total = route ? route.cumM[route.cumM.length - 1] : 0;
        const remaining = route ? Math.max(0, total - pose.progressM) : null;
        return {
          id: d.id,
          name: d.name,
          color: d.color,
          pose,
          target: route?.target ?? null,
          progress: route && total > 0 ? Math.min(pose.progressM / total, 1) : null,
          etaS: remaining !== null && MOVING.has(pose.state) && pose.speedMps > 0.5 ? remaining / pose.speedMps : null,
        };
      }),
    );
  }
}
