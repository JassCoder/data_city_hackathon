import { Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { describeHttpError } from '../core/api';
import { Facility, FleetService, KindUtilization, MEDICAL_ORDER_TYPES, NearestHospital, Order, OrderPlace, OrderType } from '../core/fleet';
import { MapDataService } from '../core/map-data';
import { PlannerStore } from '../core/planner.store';
import { FleetFlightService } from '../core/fleet-flight';
import { AddressSearchComponent, ChosenPlace } from './address-search';

const ORDER_TYPES: { id: OrderType; label: string }[] = [
  { id: 'FOOD_DELIVERY', label: 'Food delivery' },
  { id: 'BLOOD_DELIVERY', label: 'Blood delivery' },
  { id: 'AED_DELIVERY', label: 'AED delivery' },
  { id: 'MEDICAL_SUPPLIES', label: 'Medical supplies' },
];

const KIND_LABEL: Record<string, string> = {
  DEPOT: 'Depots',
  HOSPITAL_STATION: 'Hospital stations (enabled)',
  RESTAURANT_PAD: 'Pickup pads (enabled)',
};

@Component({
  selector: 'app-fleet-panel',
  imports: [DecimalPipe, MatButtonModule, MatIconModule, AddressSearchComponent],
  templateUrl: './fleet-panel.html',
  styleUrl: './fleet-panel.scss',
})
export class FleetPanelComponent {
  protected readonly fleet = inject(FleetService);
  protected readonly store = inject(PlannerStore);
  /** Animates the order's drone along its route legs on the map. */
  protected readonly flight = inject(FleetFlightService);
  private readonly mapData = inject(MapDataService);
  protected readonly orderTypes = ORDER_TYPES;
  protected readonly kindLabel = KIND_LABEL;
  protected readonly busy = signal(false);
  protected readonly showAdmin = signal(false);

  protected readonly districts = computed(() =>
    (this.mapData.boundaryData()?.districts.features ?? []).map((f) => f.properties.name).sort((a, b) => a.localeCompare(b, 'pl')),
  );
  protected readonly utilization = computed(() => {
    const s = this.fleet.summary();
    return s ? (Object.entries(s.utilization) as [string, KindUtilization][]) : [];
  });

  protected readonly isMedical = computed(() => MEDICAL_ORDER_TYPES.has(this.fleet.draft().orderType));
  protected readonly nearest = signal<NearestHospital | null>(null);
  protected readonly nearestLoading = signal(false);
  protected readonly nearestError = signal<string | null>(null);
  protected readonly canOrder = computed(() => {
    const d = this.fleet.draft();
    return !!d.delivery && (this.isMedical() ? !!this.nearest() : !!d.pickup) && !this.busy();
  });
  protected readonly missing = computed(() => {
    const d = this.fleet.draft();
    if (this.isMedical()) return d.delivery ? null : 'Enter the delivery address; the nearest hospital is the pickup.';
    if (!d.pickup && !d.delivery) return 'Enter the pickup address and the delivery address.';
    if (!d.pickup) return 'Enter the pickup address.';
    return d.delivery ? null : 'Enter the delivery address.';
  });
  protected readonly depotsSorted = computed(() =>
    [...this.fleet.depots()].filter((d) => !this.fleet.district() || d.district === this.fleet.district()),
  );
  protected readonly charging = computed(() => this.fleet.drones().filter((d) => d.status === 'CHARGING'));

  constructor() {
    // The map shows the layers that matter for the current order type.
    effect(() => {
      const type = this.fleet.draft().orderType;
      untracked(() => this.fleet.showLayersFor(type));
    });
    // Medical orders: the nearest hospital to the delivery address is the pickup.
    effect(() => {
      const medical = this.isMedical();
      const delivery = this.fleet.draft().delivery;
      untracked(() => this.loadNearest(medical ? delivery : null));
    });
  }

  private loadNearest(delivery: OrderPlace | null): void {
    this.nearest.set(null);
    this.nearestError.set(null);
    if (!delivery) return;
    this.nearestLoading.set(true);
    this.fleet.nearestHospital(delivery.coordinate).subscribe({
      next: (n) => {
        if (this.fleet.draft().delivery === delivery) this.nearest.set(n);
        this.nearestLoading.set(false);
      },
      error: (e) => {
        this.nearestError.set(describeHttpError(e, 'Nearest hospital could not be found'));
        this.nearestLoading.set(false);
      },
    });
  }

  /** Arms (or disarms) a map click for an order-form field; the planner's own pick is released. */
  protected togglePick(field: 'pickup' | 'delivery'): void {
    const next = this.fleet.pickTarget() === field ? null : field;
    this.fleet.pickTarget.set(next);
    if (next) this.store.pickTarget.set(null);
  }

  protected setType(t: string): void {
    this.fleet.draft.update((d) => ({ ...d, orderType: t as OrderType }));
  }

  /** A searched address replaces any facility chosen from a popup. */
  protected setPickup(p: ChosenPlace | null): void {
    this.fleet.draft.update((d) => ({ ...d, pickup: p, pickupFacilityId: null, partnerId: null }));
  }

  protected setDelivery(p: ChosenPlace | null): void {
    this.fleet.draft.update((d) => ({ ...d, delivery: p, destinationFacilityId: null }));
  }

  protected createAndAssign(): void {
    const d = this.fleet.draft();
    const n = this.nearest();
    if (!d.delivery || (this.isMedical() ? !n : !d.pickup)) return;
    this.busy.set(true);
    const pickup = this.isMedical()
      ? { pickup: n!.pickup, pickupFacilityId: n!.pickupFacilityId, partnerId: n!.hospital.id }
      : { pickup: d.pickup!.coordinate, pickupFacilityId: d.pickupFacilityId, partnerId: d.pickupFacilityId ? d.partnerId : null };
    this.fleet.createOrder({
      orderType: d.orderType,
      ...pickup,
      destination: d.delivery.coordinate,
      destinationFacilityId: d.destinationFacilityId,
      flightAltitudeMeters: this.store.altitudeValid() ? this.store.altitude() : 80,
    }).subscribe({
      next: (o) => this.assign(o),
      error: (e) => this.done(false, describeHttpError(e, 'Order could not be created')),
    });
  }

  protected assign(o: Order): void {
    this.busy.set(true);
    this.fleet.assign(o.id).subscribe({
      next: (r) => this.done(r.assigned, r.message),
      error: (e) => this.done(false, describeHttpError(e, 'Assignment failed')),
    });
  }

  /** One simulated step; flight steps fly the drone along that leg of the order's route. */
  protected advance(o: Order): void {
    this.fleet.advance(o.id).subscribe({
      next: (updated) => this.flight.show(updated),
      error: (e) => this.done(false, describeHttpError(e, 'Advance failed')),
    });
  }

  protected cancel(o: Order): void {
    if (this.flight.orderId() === o.id) this.flight.clear();
    this.fleet.cancel(o.id).subscribe({ error: (e) => this.done(false, describeHttpError(e, 'Cancel failed')) });
  }

  protected finishCharging(id: string): void {
    this.fleet.finishCharging(id).subscribe();
  }

  protected setCapacity(f: Facility, value: string): void {
    const capacity = Number(value);
    if (!Number.isInteger(capacity) || capacity === f.capacity) return;
    this.fleet.patchFacility(f, { capacity }).subscribe({
      next: () => this.done(true, `${f.name}: capacity set to ${capacity}.`),
      error: (e) => this.done(false, describeHttpError(e, 'Capacity change refused')),
    });
  }

  protected toggleEnabled(f: Facility): void {
    this.fleet.patchFacility(f, { verification: f.dispatchEnabled ? 'DISABLED' : 'SIMULATION_ENABLED' }).subscribe({
      error: (e) => this.done(false, describeHttpError(e, 'Change refused')),
    });
  }

  protected toggleDemand(): void {
    this.fleet.demandOpen.update((v) => !v);
  }

  protected minutes(s: number | null | undefined): string {
    return s === null || s === undefined ? '–' : `${(s / 60).toFixed(1)} min`;
  }

  protected pct(v: number): string {
    return `${Math.round(v * 100)}%`;
  }

  private done(ok: boolean, text: string): void {
    this.busy.set(false);
    this.fleet.lastMessage.set({ ok, text });
  }
}
