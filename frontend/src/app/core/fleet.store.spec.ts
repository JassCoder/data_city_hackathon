import { TestBed } from '@angular/core/testing';
import { ApplicationRef } from '@angular/core';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, TestRequest, provideHttpClientTesting } from '@angular/common/http/testing';
import { API_BASE_URL } from './api';
import { LayersService } from './layers';
import { MapDataService } from './map-data';
import { DEMO_FLEET, FleetStore } from './fleet.store';
import { CENTRALNA, KOPERNIK, OUTSIDE_POINT, routeResponse, settle } from '../../testing/fixtures';
import { RouteRequest } from './models';
import { SETTINGS } from './settings';

const ROUTE_URL = `${API_BASE_URL}/routes/calculate`;

describe('FleetStore', () => {
  let store: FleetStore;
  let http: HttpTestingController;

  beforeEach(async () => {
    localStorage.clear();
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
    store = TestBed.inject(FleetStore);
    http = TestBed.inject(HttpTestingController);
    TestBed.inject(LayersService).resource.value();
    TestBed.inject(MapDataService).boundary.value();
    await settle(http, TestBed.inject(ApplicationRef));
  });

  afterEach(() => http.verify());

  function droneWithPoints(): string {
    const d = store.addDrone();
    store.setLocation(d.id, 'start', CENTRALNA);
    store.setLocation(d.id, 'destination', KOPERNIK);
    return d.id;
  }

  const route = (id: string) => store.drones().find((d) => d.id === id)!.route;
  const answer = (req: TestRequest) => req.flush(routeResponse(req.request.body as RouteRequest));

  it('adds drones with their own name and colour, and opens the new one', () => {
    const a = store.addDrone();
    const b = store.addDrone();
    const c = store.addDrone();
    expect(new Set([a.color, b.color, c.color]).size).toBe(3);
    expect(store.editingId()).toBe(c.id);
    expect(store.selectedId()).toBe(c.id);
    expect(a.profileId).toBe(SETTINGS.defaultProfileId);
  });

  it('calculates all drones in parallel; one failure does not affect the others', () => {
    const ids = [droneWithPoints(), droneWithPoints(), droneWithPoints()];
    store.calculateAll();
    const reqs = http.match(ROUTE_URL);
    expect(reqs.length).toBe(3);
    expect(ids.every((id) => route(id).phase === 'calculating')).toBe(true);

    reqs[1].flush({ detail: 'Unknown droneProfileId' }, { status: 422, statusText: 'Unprocessable' });
    expect(route(ids[1])).toEqual({ phase: 'error', message: 'Unknown droneProfileId' });
    expect(route(ids[0]).phase).toBe('calculating'); // still waiting, unaffected
    answer(reqs[0]);
    answer(reqs[2]);
    expect(route(ids[0]).phase).toBe('ready');
    expect(route(ids[2]).phase).toBe('ready');
    expect(store.anyCalculating()).toBe(false);
  });

  it('skips drones that are not ready to calculate', () => {
    droneWithPoints();
    store.addDrone(); // no points
    store.calculateAll();
    expect(http.match(ROUTE_URL).length).toBe(1);
  });

  it('a settings change cancels the request and the late answer is ignored', () => {
    const id = droneWithPoints();
    store.calculate(id);
    const req = http.expectOne(ROUTE_URL);
    store.setAltitude(id, 100);
    expect(req.cancelled).toBe(true);
    expect(route(id).phase).toBe('draft');
  });

  it('recalculating replaces the older request', () => {
    const id = droneWithPoints();
    store.calculate(id);
    const first = http.expectOne(ROUTE_URL);
    store.calculate(id);
    expect(first.cancelled).toBe(true);
    answer(http.expectOne(ROUTE_URL));
    expect(route(id).phase).toBe('ready');
  });

  it('marks a ready route outdated when its inputs change, and keeps it for display changes', () => {
    const id = droneWithPoints();
    store.calculate(id);
    answer(http.expectOne(ROUTE_URL));
    store.rename(id, 'Courier');
    store.toggleVisible(id);
    expect(route(id).phase).toBe('ready');
    store.setOptimisation(id, 'SAFEST');
    expect(route(id).phase).toBe('stale');
  });

  it('rejects points outside Warsaw with a notice and keeps the old point', () => {
    const id = droneWithPoints();
    const ok = store.setLocation(id, 'start', { coordinate: OUTSIDE_POINT, label: 'Piaseczno', source: 'MANUAL' });
    expect(ok).toBe(false);
    const d = store.drones().find((x) => x.id === id)!;
    expect(d.start).toEqual(CENTRALNA);
    expect(d.notices.start).toContain('Outside the supported area');
    expect(store.handleMarkerDrag(id, 'destination', OUTSIDE_POINT)).toBe(false);
  });

  it('a map click fills the armed point, otherwise the first empty point of the open drone', () => {
    const d = store.addDrone();
    store.handleMapClick(CENTRALNA.coordinate);
    expect(store.drones()[0].start?.coordinate).toEqual(CENTRALNA.coordinate);
    store.pick(d.id, 'start');
    store.handleMapClick(KOPERNIK.coordinate);
    expect(store.drones()[0].start?.coordinate).toEqual(KOPERNIK.coordinate);
    expect(store.pickTarget()).toBeNull();
    store.edit(null);
    store.handleMapClick(CENTRALNA.coordinate); // nothing open, nothing armed: ignored
    expect(store.drones()[0].destination).toBeNull();
  });

  it('dragging a marker updates the point and invalidates the route', () => {
    const id = droneWithPoints();
    store.calculate(id);
    answer(http.expectOne(ROUTE_URL));
    expect(store.handleMarkerDrag(id, 'destination', { latitude: 52.24, longitude: 21.03 })).toBe(true);
    const d = store.drones().find((x) => x.id === id)!;
    expect(d.destination?.source).toBe('MAP_DRAG');
    expect(d.route.phase).toBe('stale');
  });

  it('deletes with undo', () => {
    const a = droneWithPoints();
    const b = droneWithPoints();
    store.remove(a);
    expect(store.drones().map((d) => d.id)).toEqual([b]);
    expect(store.lastDeleted()?.drone.id).toBe(a);
    store.undoRemove();
    expect(store.drones().map((d) => d.id)).toEqual([a, b]);
    expect(store.lastDeleted()).toBeNull();
  });

  it('duplicates next to the original', () => {
    const a = droneWithPoints();
    const b = droneWithPoints();
    const copy = store.duplicate(a)!;
    expect(store.drones().map((d) => d.id)).toEqual([a, copy.id, b]);
    expect(store.selectedId()).toBe(copy.id);
  });

  it('remembers the fleet in this browser without routes', () => {
    const id = droneWithPoints();
    store.calculate(id);
    answer(http.expectOne(ROUTE_URL));
    TestBed.tick();
    const saved = JSON.parse(localStorage.getItem('skyroute.fleet.v1')!);
    expect(saved[0].id).toBe(id);
    expect(saved[0].route).toBeUndefined();
  });

  it('loads the explicit demo fleet as extra drones and calculates them', () => {
    store.addDrone();
    expect(store.loadDemoFleet()).toBeNull();
    expect(store.drones().length).toBe(1 + DEMO_FLEET.length);
    const reqs = http.match(ROUTE_URL);
    expect(reqs.length).toBe(DEMO_FLEET.length);
    const bodies = reqs.map((r) => r.request.body as RouteRequest);
    expect(bodies[0]).toMatchObject({ mode: 'EMERGENCY', routeObjective: 'FASTEST', droneProfileId: 'DEMO_DRONE_01' });
    expect(bodies.every((b) => b.scenario === undefined && b.droneProfileId === 'DEMO_DRONE_01')).toBe(true);
    expect(bodies[2].flightAltitudeMeters).toBe(20);
    reqs.forEach(answer);
  });

  it('migrates saved drones from older versions to the Standard profile without missions', () => {
    localStorage.setItem('skyroute.fleet.v1', JSON.stringify([
      { id: 'old', name: 'Old', color: '#0072b2', start: null, destination: null, mode: 'EMERGENCY',
        mission: 'BLOOD_DELIVERY', optimisation: 'FASTEST', altitude: 60, profileId: 'DEMO_DRONE_02', payloadKg: 2, visible: true },
    ]));
    const restored = (TestBed.inject(FleetStore) as unknown as { restore: () => unknown[] }).restore();
    expect(restored).toEqual([expect.objectContaining({ id: 'old', mode: 'EMERGENCY', profileId: 'DEMO_DRONE_01', altitude: 60 })]);
    expect(restored[0]).not.toHaveProperty('mission');
    expect(restored[0]).not.toHaveProperty('payloadKg');
  });

  it('marks routes from an older airspace dataset as outdated', () => {
    const id = droneWithPoints();
    store.calculate(id);
    answer(http.expectOne(ROUTE_URL));
    store.onAirspaceVersion('a-newer-version');
    expect(route(id).phase).toBe('stale');
  });
});
