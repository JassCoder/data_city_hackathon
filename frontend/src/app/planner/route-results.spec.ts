import { TestBed, ComponentFixture } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { PlannerStore } from '../core/planner.store';
import { RouteRequest } from '../core/models';
import { CENTRALNA, KOPERNIK, routeResponse } from '../../testing/fixtures';
import { RouteResultsComponent } from './route-results';

const REQUEST: RouteRequest = {
  start: CENTRALNA.coordinate,
  destination: KOPERNIK.coordinate,
  mode: 'EMERGENCY',
  flightAltitudeMeters: 90,
  droneProfileId: 'DEMO_DRONE_01',
  weatherMode: 'DEMO',
  routeObjective: 'FASTEST',
};

describe('RouteResultsComponent', () => {
  let fixture: ComponentFixture<RouteResultsComponent>;
  let store: PlannerStore;
  let el: HTMLElement;

  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [RouteResultsComponent],
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    store = TestBed.inject(PlannerStore);
    fixture = TestBed.createComponent(RouteResultsComponent);
    el = fixture.nativeElement;
  });

  const q = (sel: string) => el.querySelector(`[data-testid="${sel}"]`);

  it('shows distance, ETA, mode, altitude and warnings', () => {
    store.route.set({
      phase: 'ready',
      request: REQUEST,
      response: routeResponse(REQUEST, { warnings: ['Start moved 20 m to the nearest flyable cell'] }),
    });
    fixture.detectChanges();
    expect(q('route-distance')?.textContent).toContain('3.04 km');
    expect(q('route-eta')?.textContent).toContain('2 min 56 s');
    expect(el.textContent).toContain('EMERGENCY');
    expect(el.textContent).toContain('90 m AGL');
    expect(q('route-warnings')?.textContent).toContain('Start moved 20 m');
  });

  it('shows NO_ROUTE and coverage messages clearly', () => {
    store.route.set({
      phase: 'ready',
      request: REQUEST,
      response: routeResponse(REQUEST, {
        status: 'OUTSIDE_COVERAGE',
        geometry: null,
        message: 'Destination point is outside the supported routing area',
      }),
    });
    fixture.detectChanges();
    expect(q('route-status')?.textContent).toContain('Outside coverage');
    expect(q('route-message')?.textContent).toContain('outside the supported routing area');
    expect(q('route-distance')).toBeNull();
  });

  it('flags stale results', () => {
    store.route.set({ phase: 'stale', request: REQUEST, response: routeResponse(REQUEST) });
    fixture.detectChanges();
    expect(q('route-stale')?.textContent).toContain('outdated');
  });

  it('shows loading and API errors', () => {
    store.route.set({ phase: 'loading' });
    fixture.detectChanges();
    expect(q('route-loading')).not.toBeNull();
    store.route.set({ phase: 'error', message: 'Backend unreachable.' });
    fixture.detectChanges();
    expect(q('route-error')?.textContent).toContain('Backend unreachable');
  });

  it('shows the planning verification status and zone conflicts', () => {
    store.route.set({
      phase: 'ready',
      request: REQUEST,
      response: routeResponse(REQUEST, {
        zoneConflicts: [
          { zoneId: 'DEMO-P-SEJM', name: 'Sejm', draCategory: 'DRA-P', displayClass: 'RED', evaluationStatus: 'BLOCKED',
            relation: 'DIRECT_LINE_BLOCKED', message: "The direct line crosses 'Sejm' (DRA-P)." },
        ],
      }),
    });
    fixture.detectChanges();
    expect(q('route-verification')?.textContent).toContain('Not a check of real-world flight legality');
    expect(q('route-conflicts')?.textContent).toContain('Avoided');
    expect(q('route-conflicts')?.textContent).toContain('Sejm');
  });

  it('explains NO_ROUTE and the conflicting zone for a blocked endpoint', () => {
    store.route.set({
      phase: 'ready',
      request: REQUEST,
      response: routeResponse(REQUEST, {
        status: 'DESTINATION_BLOCKED', geometry: null, message: "Destination lies inside 'Sejm' (DRA-P).",
        zoneConflicts: [
          { zoneId: 'DEMO-P-SEJM', name: 'Sejm', draCategory: 'DRA-P', displayClass: 'RED', evaluationStatus: 'BLOCKED',
            relation: 'DESTINATION_INSIDE', message: "Destination lies inside 'Sejm' (DRA-P)." },
        ],
      }),
    });
    fixture.detectChanges();
    expect(q('route-status')?.textContent).toContain('Destination blocked');
    expect(q('route-conflicts')?.textContent).toContain('Destination inside zone');
    store.route.set({ phase: 'ready', request: REQUEST, response: routeResponse(REQUEST, { status: 'NO_ROUTE', geometry: null }) });
    fixture.detectChanges();
    expect(q('route-no-route-hint')?.textContent).toContain('No path exists');
  });

  it('shows the optimisation objective, districts and search statistics', () => {
    store.route.set({ phase: 'ready', request: REQUEST, response: routeResponse(REQUEST) });
    fixture.detectChanges();
    expect(q('route-objective')?.textContent).toContain('Fastest (wind-aware)');
    expect(q('route-districts')?.textContent).toContain('Śródmieście → Praga-Południe');
    expect(q('route-search')?.textContent).toContain('25 m resolution');
  });

  it('labels search-limit results explicitly', () => {
    store.route.set({
      phase: 'ready', request: REQUEST,
      response: routeResponse(REQUEST, { status: 'SEARCH_LIMIT', geometry: null, message: 'Route could not be calculated within the supported limits' }),
    });
    fixture.detectChanges();
    expect(q('route-status')?.textContent).toContain('Search limit reached');
    expect(q('route-message')?.textContent).toContain('supported limits');
  });

  it('shows the cost breakdown, open for SAFEST routes', () => {
    const safest: RouteRequest = { ...REQUEST, routeObjective: 'SAFEST' };
    store.route.set({ phase: 'ready', request: safest, response: routeResponse(safest) });
    fixture.detectChanges();
    const details = q('route-breakdown') as HTMLDetailsElement;
    expect(details.open).toBe(true);
    expect(q('route-objective')?.textContent).toContain('Safest (multi-criteria)');
    expect(q('breakdown-energy')?.textContent).toContain('14.1 Wh of 80 Wh usable');
    expect(q('breakdown-exposure')?.textContent).toContain('412.3 people/ha');
    expect(details.textContent).toContain('Crowds (estimated)');
    expect(details.textContent).toContain('not census data');
  });

  it('labels an insufficient-battery result and keeps its breakdown', () => {
    store.route.set({
      phase: 'ready',
      request: REQUEST,
      response: routeResponse(REQUEST, {
        status: 'INSUFFICIENT_BATTERY',
        geometry: null,
        message: 'The route needs about 95 Wh, but only 80 Wh is usable.',
      }),
    });
    fixture.detectChanges();
    expect(q('route-status')?.textContent).toContain('Insufficient battery');
    expect(q('route-message')?.textContent).toContain('only 80 Wh');
    expect((q('route-breakdown') as HTMLDetailsElement).open).toBe(false);
  });
});
