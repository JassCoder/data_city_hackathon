import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';

import { ManualScheduler, ROUTE, cruiseFrame, sessionInfo, simEvent, stepResponse } from '../../testing/sim-fixtures';
import { API_BASE_URL } from '../core/api';
import { FRAME_SCHEDULER, PlaybackFrame, SimSession } from './sim-session';

const BASE = `${API_BASE_URL}/simulations`;
const STEP = `${BASE}/sess1/step`;
const HISTORY = `${BASE}/sess1/history`;

describe('SimSession', () => {
  let session: SimSession;
  let http: HttpTestingController;
  let clock: ManualScheduler;

  beforeEach(() => {
    sessionStorage.clear();
    clock = new ManualScheduler();
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting(), SimSession, { provide: FRAME_SCHEDULER, useValue: clock }],
    });
    session = TestBed.inject(SimSession);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  function started(over = {}): void {
    session.start({ scenarioId: 'basic' });
    const req = http.expectOne(BASE);
    expect(req.request.method).toBe('POST');
    expect(req.request.body).toEqual({ scenarioId: 'basic' });
    req.flush(sessionInfo(over));
  }

  /** As if live playback had reached t (paused there): the timeline now ends at t. */
  function playedTo(t: number): void {
    session.pause();
    session.clockT = t;
    clock.advance(300);
    expect(session.timeline().toS).toBe(t);
  }

  /** Runs animation frames for `ms` of wall time in 16 ms steps. */
  function run(ms: number): void {
    for (let t = 0; t < ms; t += 16) clock.advance(16);
  }

  it('starts paused at time 0 with telemetry for every drone', () => {
    started();
    expect(session.phase()).toBe('ready');
    expect(session.playing()).toBe(false);
    expect(session.mode()).toBe('LIVE');
    expect(session.telemetry().map((d) => [d.id, d.pose.state])).toEqual([
      ['d1', 'CRUISE'],
      ['d2', 'IDLE'],
    ]);
    expect(session.telemetry()[0].target).toBe('Point B');
    expect(session.telemetry()[0].etaS).toBeCloseTo(200); // 2000 m left at 10 m/s
    expect(session.telemetry()[1].progress).toBeNull();
    expect(sessionStorage.getItem('skyroute.sim.session')).toBe('sess1');
    run(100);
    http.expectNone(STEP); // paused: the simulation does not advance
  });

  it('refuses a backend that sends other frame fields', () => {
    session.start({ scenarioId: 'basic' });
    http.expectOne(BASE).flush(sessionInfo({ frameFields: ['latitude', 'longitude'] }));
    expect(session.phase()).toBe('error');
    expect(session.error()).toContain('Reload the page');
  });

  it('shows why a start failed', () => {
    session.start({ scenario: {} }, 7);
    const req = http.expectOne(BASE);
    expect(req.request.body).toEqual({ scenario: {}, seed: 7 });
    req.flush({ detail: "drone 'd1': unknown drone profile 'X'" }, { status: 422, statusText: 'Unprocessable' });
    expect(session.phase()).toBe('error');
    expect(session.error()).toContain('unknown drone profile');
  });

  it('steps ahead of the playhead at the chosen speed, one request at a time', () => {
    started();
    session.setSpeed(60);
    session.play();
    clock.advance(16);
    const req = http.expectOne(STEP);
    expect(req.request.body).toEqual({ ticks: 30, stride: 5 });
    run(200);
    http.expectNone(STEP); // still waiting for the first answer
    expect(session.buffering()).toBe(true);
    req.flush(stepResponse(0, 30, 5));
    expect(session.headT()).toBe(30);
    expect(session.buffer.last?.t).toBe(30);
    // Lead = 1.2 s x 60 = 72 simulated s: the next chunk is requested right away.
    clock.advance(16);
    http.expectOne(STEP).flush(stepResponse(30, 60, 5));
    clock.advance(16);
    http.expectOne(STEP).flush(stepResponse(60, 90, 5));
    clock.advance(16);
    // 90 - playhead (about 2 s) >= 72: enough buffered, no request.
    http.expectNone(STEP);
    expect(session.clockT).toBeGreaterThan(0);
    expect(session.clockT).toBeLessThan(10);
  });

  it('moves the playhead with wall time and speed and feeds interpolated poses to the map', () => {
    started();
    const seen: PlaybackFrame[] = [];
    session.onFrame((f) => seen.push(f));
    session.setSpeed(5);
    session.play();
    clock.advance(16);
    http.expectOne(STEP).flush(stepResponse(0, 30)); // plenty buffered
    seen.length = 0;
    run(1000);
    const last = seen[seen.length - 1];
    expect(last.t).toBeCloseTo(5, 0); // 1 s at 5x
    expect(last.poses[0].progressM).toBeCloseTo(last.t * 10, 5);
    expect(last.poses[0].state).toBe('CRUISE');
    // Panels are refreshed at most every 250 ms, not every frame.
    expect(session.playT()).toBeGreaterThan(last.t - 0.25 * 5 - 0.1);
    expect(session.playT()).toBeLessThanOrEqual(last.t);
  });

  it('never plays past the newest frame (buffering instead)', () => {
    started();
    session.setSpeed(60);
    session.play();
    clock.advance(16);
    http.expectOne(STEP).flush(stepResponse(0, 3));
    run(1000); // 60 simulated s wanted, 3 available
    expect(session.clockT).toBe(3);
    expect(session.buffering()).toBe(true);
    http.expectOne(STEP).flush(stepResponse(3, 33, 5));
  });

  it('replays stored history after scrubbing back and goes live at the end', () => {
    started();
    session.setSpeed(20);
    session.play();
    clock.advance(16);
    http.expectOne(STEP).flush(stepResponse(0, 200, 1, { history: { fromS: 0, toS: 200 } }));
    playedTo(200);
    session.seek(199.6);
    expect(session.mode()).toBe('LIVE'); // within half a tick of the newest time
    session.seek(150);
    expect(session.mode()).toBe('REPLAY');
    expect(session.clockT).toBe(150);
    // The trail kept behind the playhead (110..200) covers t = 150: no reload needed.
    clock.advance(16);
    http.expectNone((r) => r.url === HISTORY);

    session.seek(50);
    clock.advance(16);
    const req = http.expectOne((r) => r.url === HISTORY);
    expect(req.request.params.get('fromS')).toBe('0');
    expect(req.request.params.get('toS')).toBe('200');
    expect(req.request.params.get('stride')).toBe('1');
    req.flush({ stride: 1, frames: [cruiseFrame(0), cruiseFrame(50), cruiseFrame(100), cruiseFrame(200)], available: { fromS: 0, toS: 200 } });
    expect(session.posesAt(50)![0].progressM).toBe(500);

    session.goLive();
    expect(session.mode()).toBe('LIVE');
    expect(session.clockT).toBe(200);
  });

  it('switches from replay to live when playback reaches the newest time', () => {
    started();
    session.setSpeed(60);
    session.play();
    clock.advance(16);
    http.expectOne(STEP).flush(stepResponse(0, 30, 1));
    playedTo(30);
    session.seek(28);
    expect(session.mode()).toBe('REPLAY');
    session.play();
    run(200); // 12 simulated s at 60x
    expect(session.mode()).toBe('LIVE');
    http.expectOne(STEP).flush(stepResponse(30, 60, 5));
  });

  it('does not buffer live frames while replaying, but keeps their events', () => {
    started();
    session.setSpeed(60);
    session.play();
    clock.advance(16);
    const pending = http.expectOne(STEP);
    session.seek(0);
    session.goLive(); // head is 0 here: live again
    session.seek(0);
    const event = simEvent(0, 12, 'BATTERY_WARNING', { levelPct: 40 });
    pending.flush(stepResponse(0, 30, 5, { events: [event] }));
    expect(session.events()).toEqual([event]);
    expect(session.headT()).toBe(30);
  });

  it('backs off and reconnects after network errors, then says disconnected', () => {
    started();
    session.play();
    clock.advance(16);
    http.expectOne(STEP).error(new ProgressEvent('error'), { status: 0 });
    expect(session.connection()).toBe('reconnecting');
    run(500);
    http.expectNone(STEP); // first retry after 1 s
    run(600);
    http.expectOne(STEP).flush({}, { status: 503, statusText: 'Unavailable' });
    for (const wait of [2000, 4000, 8000]) {
      run(wait + 50);
      http.expectOne(STEP).error(new ProgressEvent('error'), { status: 0 });
    }
    expect(session.connection()).toBe('disconnected');
    session.retryNow();
    expect(session.connection()).toBe('reconnecting');
    clock.advance(16);
    http.expectOne(STEP).flush(stepResponse(0, 20));
    expect(session.connection()).toBe('online');
  });

  it('reports an ended session (404) instead of retrying', () => {
    started();
    session.play();
    clock.advance(16);
    http.expectOne(STEP).flush({ detail: 'expired' }, { status: 404, statusText: 'Not Found' });
    expect(session.phase()).toBe('error');
    expect(session.error()).toContain('has ended');
    expect(sessionStorage.getItem('skyroute.sim.session')).toBeNull();
    run(3000);
    http.expectNone(STEP);
  });

  it('stops at the end of a finished simulation', () => {
    started();
    session.setSpeed(60);
    session.play();
    clock.advance(16);
    http.expectOne(STEP).flush(stepResponse(0, 5, 1, { finished: true }));
    run(500);
    expect(session.clockT).toBe(5);
    expect(session.playing()).toBe(false);
    expect(session.buffering()).toBe(false);
    session.play();
    expect(session.playing()).toBe(false); // nothing more to play
  });

  it('steps one tick at a time and queues it behind a request in flight', () => {
    started();
    session.stepOnce();
    const req = http.expectOne(STEP);
    expect(req.request.body).toEqual({ ticks: 1, stride: 1 });
    session.reset(); // queued behind the step
    http.expectNone(`${BASE}/sess1/reset`);
    req.flush(stepResponse(0, 1));
    expect(session.clockT).toBe(1);
    http.expectOne(`${BASE}/sess1/reset`).flush(sessionInfo());
    expect(session.clockT).toBe(0);
    expect(session.headT()).toBe(0);
  });

  it('sends commands only while live and adds drawn zones', async () => {
    started();
    const zone = { id: 'drawn-1', name: 'Drawn zone 1', category: 'R', lowerM: 0, upperM: 120, drawn: true, geometry: { type: 'Polygon' as const, coordinates: [] } };
    const cmd = { type: 'zone' as const, polygon: [[21, 52.23], [21.01, 52.23], [21.01, 52.24]] as [number, number][], lowerM: 0, upperM: 120, durationS: 600 };
    const done = session.inject(cmd);
    const req = http.expectOne(`${BASE}/sess1/events`);
    expect(req.request.body).toEqual(cmd);
    req.flush({ scheduled: [], zone, tick: 0, timeS: 0, simTime: '', finished: false, history: { fromS: 0, toS: 0 } });
    await done;
    expect(session.zones()).toEqual([zone]);

    const fail = session.inject({ type: 'drone_failure', droneId: 'd2' });
    http.expectOne(`${BASE}/sess1/events`).flush({ detail: 'Courier 2 is idle: only a flying drone can be failed' }, { status: 409, statusText: 'Conflict' });
    await expect(fail).rejects.toThrow('only a flying drone');
  });

  it('jumps to an event: selects its drone, seeks to its time and asks the map to centre', () => {
    started();
    session.setSpeed(60);
    session.play();
    clock.advance(16);
    http.expectOne(STEP).flush(stepResponse(0, 120, 1, { history: { fromS: 0, toS: 120 } }));
    playedTo(120);
    session.jumpTo(simEvent(3, 40, 'STATE_CHANGED', { position: [52.23, 21.005, 80] }, 'd1'));
    expect(session.selectedId()).toBe('d1');
    expect(session.mode()).toBe('REPLAY');
    expect(session.clockT).toBe(40);
    expect(session.focus()).toEqual({ droneId: 'd1', place: [21.005, 52.23], nonce: 1 });
    expect(session.playT()).toBe(40);
  });

  it('loads the selected drone details and refreshes them while playing', () => {
    started();
    session.select('d1');
    clock.advance(16);
    http.expectOne(`${BASE}/sess1/drones/d1`).flush({ drone: { id: 'd1' }, mission: null, missionActive: false, energy: null, missions: [] });
    expect(session.detail()?.drone.id).toBe('d1');
    run(3000);
    http.expectNone(`${BASE}/sess1/drones/d1`); // paused and loaded: no polling
    session.select(null);
    expect(session.detail()).toBeNull();
  });

  it('resumes the session of this tab after a reload', () => {
    sessionStorage.setItem('skyroute.sim.session', 'sess1');
    expect(session.resume()).toBe(true);
    http.expectOne(`${BASE}/sess1`).flush(sessionInfo({ timeS: 300, tick: 300, history: { fromS: 0, toS: 300 }, frame: cruiseFrame(300) }));
    expect(session.phase()).toBe('ready');
    expect(session.clockT).toBe(300);
    clock.advance(16);
    const req = http.expectOne((r) => r.url === HISTORY);
    expect(req.request.params.get('fromS')).toBe('210'); // the trail behind the playhead
    expect(req.request.params.get('toS')).toBe('300');
    req.flush({ stride: 1, frames: [cruiseFrame(210), cruiseFrame(300)], available: { fromS: 0, toS: 300 } });
    expect(ROUTE.id).toBe('L1');
  });

  it('forgets a session that no longer exists', () => {
    sessionStorage.setItem('skyroute.sim.session', 'gone');
    session.resume();
    http.expectOne(`${BASE}/gone`).flush({ detail: 'expired' }, { status: 404, statusText: 'Not Found' });
    expect(session.phase()).toBe('idle');
    expect(sessionStorage.getItem('skyroute.sim.session')).toBeNull();
  });
});
