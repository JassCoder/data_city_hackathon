import { DestroyRef, Injectable, computed, inject, signal } from '@angular/core';
import { Order, OrderStatus, RouteLeg } from './fleet';
import { Leg, SIM_SCHEDULER, SIM_TIME_SCALE, SimFrame, legFromLine, pointAt, trailOf } from './simulation';

/** Fleet playback: 1 real second shows this many simulated seconds (a 4-minute leg plays in about 6 s). */
export const FLEET_PLAYBACK = SIM_TIME_SCALE * 2;
const MAX_STEP_S = 0.25;

/** The flight leg each order status flies, and where the drone waits on the ground steps. */
const FLIGHT_OF: Partial<Record<OrderStatus, RouteLeg['leg']>> = {
  TO_PICKUP: 'TO_PICKUP', IN_DELIVERY: 'DELIVERY', RETURNING: 'RETURN',
};
const PARKED_AT: Partial<Record<OrderStatus, RouteLeg['leg']>> = {
  LOADING: 'TO_PICKUP', DELIVERED: 'DELIVERY', COMPLETED: 'RETURN',
};

/** A drone standing at one point (no flight). */
function standingLeg(lat: number, lng: number): Leg {
  return { coords: [[lat, lng], [lat, lng]], cum: [0, 0], lengthM: 0, distanceM: 0, etaS: 1 };
}

/**
 * Shows a fleet order's simulated drone on the map: each "Advance simulation" step that is a
 * flight animates the drone along that leg's exact backend route; ground steps park it at the
 * leg's end. Virtual only, never a real drone.
 */
@Injectable({ providedIn: 'root' })
export class FleetFlightService {
  private readonly scheduler = inject(SIM_SCHEDULER);

  readonly orderId = signal<string | null>(null);
  readonly flying = signal(false);
  private readonly leg = signal<Leg | null>(null);
  private readonly distance = signal(0);
  private handle: number | null = null;
  private lastMs: number | null = null;

  readonly frame = computed<SimFrame | null>(() => {
    const leg = this.leg();
    if (!leg) return null;
    const d = this.distance();
    const p = pointAt(leg, d);
    return { lat: p.lat, lng: p.lng, heading: p.heading, trails: [trailOf(leg, d)], returnPath: null, follow: this.flying(),
      focus: leg.coords };
  });

  constructor() {
    inject(DestroyRef).onDestroy(() => this.cancel());
  }

  /** Called with the order returned by an advance step. */
  show(order: Order): void {
    const flight = FLIGHT_OF[order.status];
    const parked = PARKED_AT[order.status];
    const routeLeg = order.legs.find((l) => l.leg === (flight ?? parked));
    let leg = legFromLine(routeLeg?.geometry?.coordinates, routeLeg?.distanceM, routeLeg?.etaS);
    if (!leg && routeLeg && !routeLeg.geometry) {
      // Zero-length leg: e.g. a hospital's own drone is already at the pickup. Show it waiting there.
      const at = routeLeg.leg === 'TO_PICKUP' ? order.pickup : routeLeg.leg === 'DELIVERY' ? order.destination : null;
      leg = at ? standingLeg(at.latitude, at.longitude) : null;
    }
    this.cancel();
    this.orderId.set(order.id);
    this.leg.set(leg);
    if (!leg) {
      this.clear(); // ASSIGNED: no drone shown yet
      return;
    }
    if (leg.lengthM === 0) {
      this.distance.set(0);
      this.flying.set(false);
      return;
    }
    if (flight) {
      this.distance.set(0);
      this.flying.set(true);
      this.lastMs = null;
      this.loop();
    } else {
      this.distance.set(leg.lengthM); // waiting at the end of the leg just flown
      this.flying.set(false);
    }
  }

  clear(): void {
    this.cancel();
    this.orderId.set(null);
    this.leg.set(null);
    this.flying.set(false);
  }

  /** Moves the drone by `realSeconds` of playback (public for tests). */
  advance(realSeconds: number): void {
    const leg = this.leg();
    let left = Math.max(0, realSeconds);
    while (leg && this.flying() && left > 0) {
      const dt = Math.min(left, MAX_STEP_S);
      left -= dt;
      const d = this.distance() + (leg.lengthM / leg.etaS) * dt * FLEET_PLAYBACK;
      if (d >= leg.lengthM) {
        this.distance.set(leg.lengthM);
        this.flying.set(false); // landed; the next Advance step continues the delivery
        this.cancel();
        return;
      }
      this.distance.set(d);
    }
  }

  private loop(): void {
    this.handle = this.scheduler.request((ms) => {
      this.handle = null;
      const dt = this.lastMs === null ? 0 : (ms - this.lastMs) / 1000;
      this.lastMs = ms;
      this.advance(dt);
      if (this.flying()) this.loop();
    });
  }

  private cancel(): void {
    if (this.handle !== null) this.scheduler.cancel(this.handle);
    this.handle = null;
    this.lastMs = null;
  }
}
