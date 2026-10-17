import { TestBed } from '@angular/core/testing';
import { ApplicationRef } from '@angular/core';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { API_BASE_URL } from './api';
import { LayersService } from './layers';
import { PlannerApi } from './planner-api';
import { PLANNER_DEFAULTS, PlannerStore } from './planner.store';
import { CENTRALNA, KOPERNIK, flushStartup, routeResponse } from '../../testing/fixtures';
import { RouteRequest } from './models';

const ROUTE_URL = `${API_BASE_URL}/routes/calculate`;

describe('PlannerStore', () => {
  let store: PlannerStore;
  let http: HttpTestingController;

  beforeEach(async () => {
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
    store = TestBed.inject(PlannerStore);
    http = TestBed.inject(HttpTestingController);
    // Instantiate the resources so their requests start, then answer them.
    TestBed.inject(LayersService).resource.value();
    TestBed.inject(PlannerApi).profiles.value();
    TestBed.tick();
    flushStartup(http);
    await TestBed.inject(ApplicationRef).whenStable();
  });

  afterEach(() => http.verify());

  function withPoints() {
    store.setLocation('start', CENTRALNA);
    store.setLocation('destination', KOPERNIK);
  }

  it('builds no request until both points are selected', () => {
    expect(store.request()).toBeNull();
    expect(store.canCalculate()).toBe(false);
    store.setLocation('start', CENTRALNA);
    expect(store.canCalculate()).toBe(false);
    store.setLocation('destination', KOPERNIK);
    expect(store.canCalculate()).toBe(true);
  });

  it('generates the exact request payload from current state', () => {
    withPoints();
    store.setAltitude(95);
    store.setMode('EMERGENCY');
    store.setDroneProfile('DEMO_DRONE_02');
    store.setWeatherMode('LIVE');
    expect(store.request()).toEqual({
      start: { latitude: 52.22882, longitude: 21.00316 },
      destination: { latitude: 52.24178, longitude: 21.0286 },
      mode: 'EMERGENCY',
      flightAltitudeMeters: 95,
      droneProfileId: 'DEMO_DRONE_02',
      weatherMode: 'LIVE',
    } satisfies RouteRequest);
    expect(typeof store.request()!.start.latitude).toBe('number');
  });

  it('uses the documented defaults', () => {
    withPoints();
    expect(store.request()).toMatchObject({
      mode: 'NORMAL',
      flightAltitudeMeters: 80,
      droneProfileId: 'DEMO_DRONE_01',
      weatherMode: 'DEMO',
    });
  });

  it.each([NaN, 15, 125, 82])('disables calculation for invalid altitude %s', (alt) => {
    withPoints();
    store.setAltitude(alt);
    expect(store.altitudeValid()).toBe(false);
    expect(store.canCalculate()).toBe(false);
  });

  it('rejects an unknown drone profile', () => {
    withPoints();
    store.setDroneProfile('DEMO_DRONE_99');
    expect(store.profileValid()).toBe(false);
    expect(store.request()).toBeNull();
  });

  it('rejects identical start and destination', () => {
    store.setLocation('start', CENTRALNA);
    store.setLocation('destination', { ...CENTRALNA, label: 'same' });
    expect(store.request()).toBeNull();
  });

  it('rejects out-of-coverage points with a precise notice', () => {
    const airport = { coordinate: { latitude: 52.16307, longitude: 20.97081 }, label: 'Airport', source: 'MANUAL' as const };
    expect(store.setLocation('destination', airport)).toBe(false);
    expect(store.destination()).toBeNull();
    expect(store.notices().destination).toContain('Outside the supported routing area');
  });

  it('posts the request, shows loading, then the route', () => {
    withPoints();
    store.calculate();
    expect(store.route().phase).toBe('loading');
    expect(store.canCalculate()).toBe(false);
    const req = http.expectOne(ROUTE_URL);
    expect(req.request.method).toBe('POST');
    expect(req.request.body).toEqual(store.request());
    req.flush(routeResponse(req.request.body));
    const r = store.route();
    expect(r.phase).toBe('ready');
    if (r.phase === 'ready') expect(r.response.distanceM).toBe(3035.2);
  });

  it.each([
    ['altitude', (s: PlannerStore) => s.setAltitude(100)],
    ['mode', (s: PlannerStore) => s.setMode('EMERGENCY')],
    ['drone profile', (s: PlannerStore) => s.setDroneProfile('DEMO_DRONE_02')],
    ['weather mode', (s: PlannerStore) => s.setWeatherMode('LIVE')],
    ['start', (s: PlannerStore) => s.setLocation('start', { ...CENTRALNA, coordinate: { latitude: 52.235, longitude: 21.0385 } })],
    ['destination', (s: PlannerStore) => s.setLocation('destination', { ...KOPERNIK, coordinate: { latitude: 52.2398, longitude: 21.0454 } })],
  ])('marks the route stale when %s changes', (_, change) => {
    withPoints();
    store.calculate();
    const req = http.expectOne(ROUTE_URL);
    req.flush(routeResponse(req.request.body));
    change(store);
    expect(store.route().phase).toBe('stale');
  });

  it('drops an outdated response when inputs change during calculation', () => {
    withPoints();
    store.calculate();
    const first = http.expectOne(ROUTE_URL);
    store.setLocation('destination', { ...KOPERNIK, coordinate: { latitude: 52.2398, longitude: 21.0454 } });
    expect(first.cancelled).toBe(true);
    expect(store.route().phase).toBe('idle');

    store.calculate();
    const second = http.expectOne(ROUTE_URL);
    expect(second.request.body.destination).toEqual({ latitude: 52.2398, longitude: 21.0454 });
    second.flush(routeResponse(second.request.body));
    const r = store.route();
    expect(r.phase === 'ready' && r.request.destination.latitude).toBe(52.2398);
  });

  it('cancels the previous request when calculating again', () => {
    withPoints();
    store.calculate();
    const first = http.expectOne(ROUTE_URL);
    store.setAltitude(100);
    store.calculate();
    expect(first.cancelled).toBe(true);
    http.expectOne(ROUTE_URL).flush(routeResponse(store.request()!));
    expect(store.route().phase).toBe('ready');
  });

  it('shows the backend error detail', () => {
    withPoints();
    store.calculate();
    http.expectOne(ROUTE_URL).flush({ detail: "Unknown droneProfileId 'X'." }, { status: 422, statusText: 'Unprocessable' });
    const r = store.route();
    expect(r.phase).toBe('error');
    if (r.phase === 'error') expect(r.message).toContain('Unknown droneProfileId');
  });

  it('reports an unreachable backend', () => {
    withPoints();
    store.calculate();
    http.expectOne(ROUTE_URL).error(new ProgressEvent('error'), { status: 0 });
    const r = store.route();
    expect(r.phase === 'error' && r.message).toContain('Backend unreachable');
  });

  it('keeps NO_ROUTE responses as results, not fake routes', () => {
    withPoints();
    store.calculate();
    const req = http.expectOne(ROUTE_URL);
    req.flush(routeResponse(req.request.body, { status: 'NO_ROUTE', geometry: null, distanceM: null, etaS: null }));
    const r = store.route();
    expect(r.phase === 'ready' && r.response.geometry).toBeNull();
  });

  it('map clicks fill the first empty point, or the armed one', () => {
    store.handleMapClick({ latitude: 52.23, longitude: 21.01 });
    store.handleMapClick({ latitude: 52.24, longitude: 21.02 });
    expect(store.start()?.source).toBe('MAP_CLICK');
    expect(store.destination()?.coordinate).toEqual({ latitude: 52.24, longitude: 21.02 });
    store.pickTarget.set('start');
    store.handleMapClick({ latitude: 52.235, longitude: 21.03 });
    expect(store.start()?.coordinate.latitude).toBe(52.235);
    expect(store.pickTarget()).toBeNull();
  });

  it('Clear Route keeps points and settings', () => {
    withPoints();
    store.setAltitude(100);
    store.calculate();
    const req = http.expectOne(ROUTE_URL);
    req.flush(routeResponse(req.request.body));
    store.clearRoute();
    expect(store.route().phase).toBe('idle');
    expect(store.start()).toEqual(CENTRALNA);
    expect(store.altitude()).toBe(100);
  });

  it('Reset Planner clears points and restores defaults', () => {
    withPoints();
    store.setAltitude(100);
    store.setMode('EMERGENCY');
    store.setWeatherMode('LIVE');
    store.setDroneProfile('DEMO_DRONE_02');
    store.calculate();
    const req = http.expectOne(ROUTE_URL);
    store.reset();
    expect(req.cancelled).toBe(true);
    expect(store.start()).toBeNull();
    expect(store.destination()).toBeNull();
    expect(store.route().phase).toBe('idle');
    expect(store.altitude()).toBe(PLANNER_DEFAULTS.altitude);
    expect(store.mode()).toBe('NORMAL');
    expect(store.weatherMode()).toBe('DEMO');
    expect(store.droneProfileId()).toBe('DEMO_DRONE_01');
  });

  it('demo scenario uses the synthetic stations and the normal route API', () => {
    expect(store.loadDemoScenario()).toBeNull();
    expect(store.start()?.source).toBe('DEMO');
    expect(store.scenarioLabel()).toContain('DEMO');
    const req = http.expectOne(ROUTE_URL);
    expect(req.request.body).toMatchObject({
      start: { latitude: 52.2352, longitude: 21.0385 },
      destination: { latitude: 52.23, longitude: 20.993 },
      droneProfileId: 'DEMO_DRONE_02',
    });
    req.flush(routeResponse(req.request.body));
  });

  it('marks the route stale when the airspace dataset version changes', () => {
    withPoints();
    store.calculate();
    const req = http.expectOne(ROUTE_URL);
    req.flush(routeResponse(req.request.body)); // planned on airspace version v1
    store.onAirspaceVersion('v1');
    expect(store.route().phase).toBe('ready');
    store.onAirspaceVersion('v2');
    expect(store.route().phase).toBe('stale');
  });
});
