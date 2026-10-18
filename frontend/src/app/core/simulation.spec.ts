import { ApplicationRef } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { API_BASE_URL } from './api';
import { LayersService } from './layers';
import { MapDataService } from './map-data';
import { RouteRequest } from './models';
import { PlannerApi } from './planner-api';
import { PlannerStore } from './planner.store';
import {
  DWELL_REAL_S, Leg, SIM_SCHEDULER, SIM_TIME_SCALE, SimScheduler, SimulationService, bearingDeg, buildLeg, pointAt,
  segmentLengthM, trailOf,
} from './simulation';
import { CENTRALNA, KOPERNIK, routeResponse, settle } from '../../testing/fixtures';

const ROUTE_URL = `${API_BASE_URL}/routes/calculate`;

/** Frames run only when the test says so. */
class ManualScheduler implements SimScheduler {
  pending = new Map<number, (t: number) => void>();
  private next = 1;
  request(cb: (t: number) => void): number {
    this.pending.set(this.next, cb);
    return this.next++;
  }
  cancel(h: number): void {
    this.pending.delete(h);
  }
}

describe('route geometry helpers', () => {
  // An L-shaped route: north, then east. The straight A-B line would cut the corner.
  const res = routeResponse({ start: { latitude: 52.2, longitude: 21.0 }, destination: { latitude: 52.21, longitude: 21.01 } } as RouteRequest);
  res.geometry!.coordinates = [[21.0, 52.2], [21.0, 52.21], [21.01, 52.21]];
  const leg = buildLeg(res)!;

  it('follows every waypoint and turn, never the straight line', () => {
    const corner = leg.cum[1];
    const mid = pointAt(leg, corner / 2);
    expect(mid.lng).toBeCloseTo(21.0, 9); // still on the northbound segment
    expect(mid.heading).toBeCloseTo(0, 0);
    const after = pointAt(leg, corner + 10);
    expect(after.lat).toBeCloseTo(52.21, 6); // turned east at the corner
    expect(after.heading).toBeCloseTo(90, 0);
    expect(pointAt(leg, corner).lat).toBeCloseTo(52.21, 9);
  });

  it('clamps to the endpoints and builds the flown trail from passed vertices', () => {
    expect(pointAt(leg, -5)).toMatchObject({ lat: 52.2, lng: 21.0 });
    const end = pointAt(leg, leg.lengthM + 50);
    expect([end.lat, end.lng]).toEqual([52.21, 21.01]);
    const trail = trailOf(leg, leg.cum[1] + 1);
    expect(trail.slice(0, 2)).toEqual([[52.2, 21.0], [52.21, 21.0]]);
    expect(trail).toHaveLength(3);
  });

  it('measures segments and bearings', () => {
    expect(segmentLengthM([52.2, 21.0], [52.21, 21.0])).toBeCloseTo(1112, -1);
    expect(bearingDeg([52.2, 21.0], [52.2, 21.01])).toBeCloseTo(90, 0);
    expect(buildLeg({ ...res, status: 'NO_ROUTE', geometry: null })).toBeNull();
  });
});

describe('SimulationService', () => {
  let store: PlannerStore;
  let sim: SimulationService;
  let http: HttpTestingController;
  let sched: ManualScheduler;

  beforeEach(async () => {
    sched = new ManualScheduler();
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting(), { provide: SIM_SCHEDULER, useValue: sched }],
    });
    store = TestBed.inject(PlannerStore);
    sim = TestBed.inject(SimulationService);
    http = TestBed.inject(HttpTestingController);
    TestBed.inject(LayersService).resource.value();
    TestBed.inject(PlannerApi).profiles.value();
    TestBed.inject(PlannerApi).scenarios.value();
    TestBed.inject(MapDataService).boundary.value();
    await settle(http, TestBed.inject(ApplicationRef));
  });

  afterEach(() => http.verify());

  function findRoute() {
    store.setLocation('start', CENTRALNA);
    store.setLocation('destination', KOPERNIK);
    store.calculate();
    const req = http.expectOne(ROUTE_URL);
    req.flush(routeResponse(req.request.body));
    TestBed.tick();
  }

  /** Real seconds needed at 1× to fly a leg of `etaS` simulated seconds. */
  const realFor = (etaS: number) => etaS / SIM_TIME_SCALE;
  const outboundLeg = () => buildLeg(routeResponse(store.request()!))!;

  it('cannot start before a valid route exists', () => {
    expect(sim.canStart()).toBe(false);
    expect(sim.start()).toBe(false);
    expect(sim.startError()).toContain('Find a route');
    http.expectNone(ROUTE_URL);
  });

  it('flies A → B on the displayed route, returns on a separately calculated B → A route and ends at A', () => {
    findRoute();
    expect(sim.canStart()).toBe(true);
    expect(sim.start()).toBe(true);
    // The return leg is requested at once with the same settings and swapped endpoints.
    const back = http.expectOne(ROUTE_URL);
    const body = back.request.body as RouteRequest;
    expect(body.start).toEqual(KOPERNIK.coordinate);
    expect(body.destination).toEqual(CENTRALNA.coordinate);
    expect({ ...body, start: null, destination: null }).toEqual({ ...store.request()!, start: null, destination: null });
    const returnResponse = routeResponse(body, { etaS: 200, distanceM: 3100 });
    returnResponse.geometry!.coordinates = [
      [KOPERNIK.coordinate.longitude, KOPERNIK.coordinate.latitude],
      [21.03, 52.23], // a different path than the outbound one
      [CENTRALNA.coordinate.longitude, CENTRALNA.coordinate.latitude],
    ];
    back.flush(returnResponse);

    expect(sim.phase()).toBe('OUTBOUND');
    expect(sim.frame()).toMatchObject({ lat: CENTRALNA.coordinate.latitude, lng: CENTRALNA.coordinate.longitude });
    expect(sched.pending.size).toBe(1); // one animation loop only

    sim.advance(realFor(175.6) / 2);
    const half = sim.stats()!;
    expect(half.phaseLabel).toBe('Outbound');
    expect(half.travelledM).toBeCloseTo(3035.2 / 2, -1);
    expect(half.progressPct).toBeCloseTo((100 * 3035.2) / 2 / (3035.2 + 3100), 0);
    expect(half.speedKmh).toBeCloseTo((3035.2 / 175.6) * 3.6, 1);

    sim.advance(realFor(175.6) / 2 + 0.01); // just past arrival (the rest of a step carries on into the dwell)
    expect(sim.phase()).toBe('AT_DESTINATION');
    expect(sim.message()).toBe('Destination Reached');
    expect(sim.frame()).toMatchObject({ lat: KOPERNIK.coordinate.latitude, lng: KOPERNIK.coordinate.longitude });

    sim.advance(DWELL_REAL_S + 0.01);
    expect(sim.phase()).toBe('RETURNING');
    expect(sim.frame()!.returnPath).toHaveLength(3);
    sim.advance(realFor(200) / 2);
    expect(sim.frame()!.lng).toBeGreaterThan(21.02); // on the return geometry, not the outbound one

    sim.advance(realFor(200));
    expect(sim.phase()).toBe('COMPLETED');
    expect(sim.message()).toBe('Round Trip Completed');
    expect(sim.frame()).toMatchObject({ lat: CENTRALNA.coordinate.latitude, lng: CENTRALNA.coordinate.longitude });
    expect(sim.stats()!.progressPct).toBeCloseTo(100, 5);
    expect(sim.stats()!.remainingS).toBe(0);
    expect(sched.pending.size).toBe(0); // loop stopped
  });

  it('stops at Point B with the reason when there is no valid return route (never reverses)', () => {
    findRoute();
    sim.start();
    const back = http.expectOne(ROUTE_URL);
    back.flush(routeResponse(back.request.body, { status: 'NO_ROUTE', message: 'No route found.', geometry: null }));
    sim.advance(realFor(175.6) + DWELL_REAL_S + 0.5);
    expect(sim.phase()).toBe('STOPPED');
    expect(sim.message()).toContain('Stopped at the destination');
    expect(sim.message()).toContain('NO_ROUTE');
    expect(sim.frame()).toMatchObject({ lat: KOPERNIK.coordinate.latitude, lng: KOPERNIK.coordinate.longitude });
  });

  it('waits at Point B while the return route is still being calculated', () => {
    findRoute();
    sim.start();
    const back = http.expectOne(ROUTE_URL);
    sim.advance(realFor(175.6) + DWELL_REAL_S + 1);
    expect(sim.phase()).toBe('AT_DESTINATION');
    expect(sim.message()).toContain('Calculating the return route');
    back.flush(routeResponse(back.request.body));
    expect(sim.phase()).toBe('RETURNING');
  });

  it('pause, resume, speed, stop and restart', () => {
    findRoute();
    sim.start();
    http.expectOne(ROUTE_URL).flush(routeResponse({ ...store.request()!, start: KOPERNIK.coordinate, destination: CENTRALNA.coordinate }));
    sim.advance(1);
    const d1 = sim.stats()!.travelledM;
    sim.pause();
    expect(sim.playing()).toBe(false);
    expect(sched.pending.size).toBe(0);
    sim.advance(5); // paused: no movement
    expect(sim.stats()!.travelledM).toBe(d1);
    sim.resume();
    sim.setSpeed(10);
    sim.advance(0.5);
    expect(sim.stats()!.travelledM - d1).toBeCloseTo(outboundLeg().distanceM / outboundLeg().etaS * 0.5 * SIM_TIME_SCALE * 10, -1);
    sim.stop();
    expect(sim.phase()).toBe('IDLE');
    expect(sim.frame()).toBeNull();
    expect(sim.canStart()).toBe(true);
    sim.restart();
    http.expectOne(ROUTE_URL).flush(routeResponse({ ...store.request()!, start: KOPERNIK.coordinate, destination: CENTRALNA.coordinate }));
    expect(sim.phase()).toBe('OUTBOUND');
    expect(sim.stats()!.travelledM).toBe(0);
    expect(sched.pending.size).toBe(1);
  });

  it('changing a setting during the flight stops it and requires a new route', () => {
    findRoute();
    sim.start();
    http.expectOne(ROUTE_URL).flush(routeResponse({ ...store.request()!, start: KOPERNIK.coordinate, destination: CENTRALNA.coordinate }));
    sim.advance(1);
    store.setAltitude(100);
    TestBed.tick();
    expect(sim.phase()).toBe('STOPPED');
    expect(sim.message()).toContain('Find the route again');
    expect(sim.canStart()).toBe(false);
    expect(sched.pending.size).toBe(0);
  });

  it('a route that no longer matches the inputs cannot be simulated', () => {
    findRoute();
    store.setWeatherMode('SAMPLE'); // route becomes stale
    TestBed.tick();
    expect(sim.canStart()).toBe(false);
    expect(sim.start()).toBe(false);
  });

  it('a leg uses the backend distance and ETA', () => {
    findRoute();
    const leg: Leg = outboundLeg();
    expect(leg.distanceM).toBe(3035.2);
    expect(leg.etaS).toBe(175.6);
  });
});
