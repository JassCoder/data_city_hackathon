import { TestBed, ComponentFixture } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { FleetStore } from '../core/fleet.store';
import { Drone, createDrone, setRoute, toRouteRequest } from '../core/fleet';
import { CENTRALNA, KOPERNIK, COST_BREAKDOWN, routeResponse } from '../../testing/fixtures';
import { RouteDetailsComponent } from './route-details';

describe('RouteDetailsComponent', () => {
  let fixture: ComponentFixture<RouteDetailsComponent>;
  let fleet: FleetStore;
  let el: HTMLElement;

  beforeEach(() => {
    localStorage.clear();
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
    fleet = TestBed.inject(FleetStore);
    fixture = TestBed.createComponent(RouteDetailsComponent);
    el = fixture.nativeElement;
  });

  function show(over: Parameters<typeof routeResponse>[1]) {
    const d: Drone = { ...createDrone([], 'd1', { altitude: 80, profileId: 'DEMO_DRONE_01' }), start: CENTRALNA, destination: KOPERNIK };
    const request = toRouteRequest(d, 'DEMO')!;
    fleet.drones.set(setRoute([d], 'd1', { phase: 'ready', response: routeResponse(request, over), request }));
    fleet.select('d1');
    fixture.detectChanges();
  }

  const q = (testid: string) => el.querySelector(`[data-testid="${testid}"]`)?.textContent ?? '';

  it('asks to select a drone when none is selected', () => {
    fixture.detectChanges();
    expect(q('details-empty')).toContain('Select a drone');
  });

  it('explains a failed result in plain language with the next step and the blocking zone', () => {
    show({
      status: 'NO_ROUTE',
      geometry: null,
      distanceM: null,
      message: 'No route found anywhere in the Warsaw coverage.',
      zoneConflicts: [
        { zoneId: 'DEMO-P-SEJM', name: 'DEMO prohibited area: Sejm', draCategory: 'DRA-P', displayClass: 'RED',
          evaluationStatus: 'BLOCKED', relation: 'DIRECT_LINE_BLOCKED', message: 'The direct line crosses it.' },
      ],
    });
    expect(q('details-headline')).toContain('No feasible route');
    expect(q('details-message')).toContain('No route found anywhere');
    expect(q('details-next')).toContain('higher altitude');
    expect(q('details-zones')).toContain('Avoided');
    expect(q('details-zones')).toContain('DEMO prohibited area: Sejm');
  });

  it('shows distance, time, energy, the cost breakdown and the safety note for a route', () => {
    show({ costBreakdown: COST_BREAKDOWN });
    expect(q('details-headline')).toContain('Route ready');
    expect(q('details-distance')).toBe('3.04 km');
    expect(q('details-energy')).toContain('14.1 Wh of 80 Wh usable');
    expect(q('details-breakdown')).toContain('Crowds (estimated)');
    expect(q('details-breakdown')).toContain('not census data');
    expect(q('details-safety')).toContain('not a flight authorization');
    expect(q('details-safety')).toContain('PANSA DroneMap and DroneTower');
  });
});
