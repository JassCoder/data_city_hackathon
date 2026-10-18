import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';

import { ManualScheduler, sessionInfo, simEvent, stepResponse } from '../../testing/sim-fixtures';
import { API_BASE_URL } from '../core/api';
import { FRAME_SCHEDULER, SimSession } from './sim-session';
import { ZoneDraft } from './zone-draft';

const BASE = `${API_BASE_URL}/simulations`;
const c = (latitude: number, longitude: number) => ({ latitude, longitude });

describe('ZoneDraft', () => {
  let draft: ZoneDraft;
  let session: SimSession;
  let http: HttpTestingController;
  let clock: ManualScheduler;

  beforeEach(() => {
    sessionStorage.clear();
    clock = new ManualScheduler();
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting(), SimSession, ZoneDraft, { provide: FRAME_SCHEDULER, useValue: clock }],
    });
    session = TestBed.inject(SimSession);
    draft = TestBed.inject(ZoneDraft);
    http = TestBed.inject(HttpTestingController);
    session.start({ scenarioId: 'basic' });
    http.expectOne(BASE).flush(sessionInfo());
  });

  afterEach(() => http.verify());

  it('collects corners only while drawing, with undo and cancel', () => {
    draft.add(c(52.23, 21.0));
    expect(draft.points()).toEqual([]);
    draft.start();
    draft.add(c(52.23, 21.0));
    draft.add(c(52.23, 21.01));
    expect(draft.canFinish()).toBe(false);
    draft.add(c(52.24, 21.01));
    expect(draft.canFinish()).toBe(true);
    draft.undo();
    expect(draft.points().length).toBe(2);
    draft.cancel();
    expect(draft.active()).toBe(false);
    expect(draft.points()).toEqual([]);
  });

  it('explains a bad outline instead of sending it', async () => {
    draft.start();
    draft.add(c(52.23, 21.0));
    draft.add(c(52.23, 21.01));
    await draft.finish();
    expect(draft.error()).toContain('three corners');
    draft.add(c(52.24, 21.01));
    draft.durationMin.set(0);
    await draft.finish();
    expect(draft.error()).toContain('duration');
    http.expectNone(`${BASE}/sess1/events`);
  });

  it('sends the zone with altitude cap, duration and name, then confirms it', async () => {
    draft.start();
    for (const p of [c(52.23, 21.0), c(52.23, 21.01), c(52.24, 21.01)]) draft.add(p);
    draft.upperM.set(90);
    draft.durationMin.set(10);
    draft.name.set('Fire');
    const done = draft.finish();
    const req = http.expectOne(`${BASE}/sess1/events`);
    expect(req.request.body).toEqual({
      type: 'zone', polygon: [[21.0, 52.23], [21.01, 52.23], [21.01, 52.24]], lowerM: 0, upperM: 90, durationS: 600, name: 'Fire',
    });
    req.flush({
      scheduled: [], tick: 0, timeS: 0, simTime: '', finished: false, history: { fromS: 0, toS: 0 },
      zone: { id: 'drawn-1', name: 'Fire', category: 'DRA-R', lowerM: 0, upperM: 90, drawn: true, geometry: { type: 'Polygon', coordinates: [] } },
    });
    await done;
    expect(draft.active()).toBe(false);
    expect(draft.sent()).toEqual({ zoneId: 'drawn-1', text: 'Fire is active from the next tick for 10 min, up to 90 m.' });
    expect(session.zones().map((z) => z.id)).toEqual(['drawn-1']);
  });

  it('shows the backend reason when a zone is rejected', async () => {
    draft.start();
    for (const p of [c(52.23, 21.0), c(52.23, 21.01), c(52.24, 21.01)]) draft.add(p);
    const done = draft.finish();
    http.expectOne(`${BASE}/sess1/events`).flush({ detail: 'the zone is outside Warsaw' }, { status: 422, statusText: 'Unprocessable' });
    await done;
    expect(draft.error()).toBe('the zone is outside Warsaw');
    expect(draft.active()).toBe(true); // still drawing: the user can fix it
  });

  it('reloads the selected drone details when something happens to it', () => {
    session.select('d1');
    clock.advance(16);
    http.expectOne(`${BASE}/sess1/drones/d1`).flush({ drone: { id: 'd1' }, mission: null, missionActive: false, energy: null, missions: [] });
    session.setSpeed(60);
    session.play();
    clock.advance(16);
    http.expectOne(`${BASE}/sess1/step`).flush(stepResponse(0, 30, 5, { events: [simEvent(0, 3, 'FAILURE', { reason: 'test' })] }));
    session.pause();
    clock.advance(16);
    http.expectOne(`${BASE}/sess1/drones/d1`).flush({ drone: { id: 'd1' }, mission: null, missionActive: false, energy: null, missions: [] });
  });
});
