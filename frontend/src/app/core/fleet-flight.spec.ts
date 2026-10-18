import { TestBed } from '@angular/core/testing';
import { Order, RouteLeg } from './fleet';
import { FLEET_PLAYBACK, FleetFlightService } from './fleet-flight';
import { SIM_SCHEDULER, SimScheduler } from './simulation';
import { orderFixture } from '../../testing/fleet-fixtures';

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

const line = (coordinates: number[][]) => ({ type: 'LineString', coordinates }) as GeoJSON.LineString;
// An L-shaped delivery leg: the drone must turn at the corner, never cut across.
const LEGS: RouteLeg[] = [
  { leg: 'TO_PICKUP', status: 'OK', distanceM: 1000, etaS: 100, geometry: line([[21.0, 52.20], [21.0, 52.209]]), message: '' },
  { leg: 'DELIVERY', status: 'OK', distanceM: 2000, etaS: 200,
    geometry: line([[21.0, 52.209], [21.0, 52.218], [21.013, 52.218]]), message: '' },
  { leg: 'RETURN', status: 'OK', distanceM: 2100, etaS: 210, geometry: line([[21.013, 52.218], [21.0, 52.20]]), message: '' },
];
const order = (status: Order['status']): Order => ({ ...orderFixture({ status }), legs: LEGS });

describe('FleetFlightService', () => {
  let flight: FleetFlightService;
  let sched: ManualScheduler;

  beforeEach(() => {
    sched = new ManualScheduler();
    TestBed.configureTestingModule({ providers: [{ provide: SIM_SCHEDULER, useValue: sched }] });
    flight = TestBed.inject(FleetFlightService);
  });

  it('a flight step flies the drone along that leg of the order route and lands at its end', () => {
    flight.show(order('IN_DELIVERY'));
    expect(flight.flying()).toBe(true);
    expect(sched.pending.size).toBe(1);
    expect(flight.frame()).toMatchObject({ lat: 52.209, lng: 21.0 });
    flight.advance(100 / FLEET_PLAYBACK); // halfway (200 s leg)
    const mid = flight.frame()!;
    expect(mid.lng).toBeCloseTo(21.0, 6); // still on the northbound part: no shortcut across the corner
    expect(mid.heading).toBeCloseTo(0, 0);
    flight.advance(200 / FLEET_PLAYBACK);
    expect(flight.flying()).toBe(false);
    expect(flight.frame()).toMatchObject({ lat: 52.218, lng: 21.013 });
    expect(sched.pending.size).toBe(0);
  });

  it('ground steps park the drone at the end of the leg just flown', () => {
    flight.show(order('LOADING'));
    expect(flight.flying()).toBe(false);
    expect(flight.frame()).toMatchObject({ lat: 52.209, lng: 21.0 });
    flight.show(order('COMPLETED'));
    expect(flight.frame()).toMatchObject({ lat: 52.20, lng: 21.0 }); // back at the depot
  });

  it('a step without a flown leg shows no drone', () => {
    flight.show(order('ASSIGNED'));
    expect(flight.frame()).toBeNull();
    flight.show({ ...order('TO_PICKUP'), legs: [{ ...LEGS[0], geometry: null, distanceM: 0 }] });
    expect(flight.frame()).toBeNull();
    expect(flight.orderId()).toBeNull();
  });
});
