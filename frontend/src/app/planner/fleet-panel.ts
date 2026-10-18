import { Component, computed, inject, signal } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { describeHttpError } from '../core/api';
import { Facility, FleetService, KindUtilization, Order, OrderType } from '../core/fleet';
import { MapDataService } from '../core/map-data';
import { PlannerStore } from '../core/planner.store';

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

function same(a: { latitude: number; longitude: number } | null | undefined, b: { latitude: number; longitude: number } | null | undefined): boolean {
  return !!a && !!b && a.latitude === b.latitude && a.longitude === b.longitude;
}

@Component({
  selector: 'app-fleet-panel',
  imports: [DecimalPipe, MatButtonModule, MatIconModule],
  templateUrl: './fleet-panel.html',
  styleUrl: './fleet-panel.scss',
})
export class FleetPanelComponent {
  protected readonly fleet = inject(FleetService);
  protected readonly store = inject(PlannerStore);
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

  /** Facility ids are used only while Point A/B still sit exactly on that facility (explicit choice). */
  protected readonly pickupFacility = computed(() => {
    const d = this.fleet.draft();
    return d.pickupFacilityId && same(d.pickupFacilityPoint, this.store.start()?.coordinate) ? d.pickupFacilityId : null;
  });
  protected readonly destinationFacility = computed(() => {
    const d = this.fleet.draft();
    return d.destinationFacilityId && same(d.destinationFacilityPoint, this.store.destination()?.coordinate)
      ? d.destinationFacilityId : null;
  });
  protected readonly canOrder = computed(() => !!this.store.start() && !!this.store.destination() && !this.busy());
  protected readonly depotsSorted = computed(() =>
    [...this.fleet.depots()].filter((d) => !this.fleet.district() || d.district === this.fleet.district()),
  );
  protected readonly charging = computed(() => this.fleet.drones().filter((d) => d.status === 'CHARGING'));

  protected setType(t: string): void {
    this.fleet.draft.update((d) => ({ ...d, orderType: t as OrderType }));
  }

  protected setDestinationStation(id: string): void {
    const st = this.fleet.enabledStations().find((s) => s.station.id === id);
    if (!st) {
      this.fleet.draft.update((d) => ({ ...d, destinationFacilityId: null, destinationFacilityPoint: null }));
      return;
    }
    const point = { latitude: st.station.latitude, longitude: st.station.longitude };
    // Explicit user choice: the station becomes Point B.
    if (this.store.setLocation('destination', { coordinate: point, label: st.hospital.name ?? st.station.name, source: 'FACILITY' })) {
      this.fleet.draft.update((d) => ({ ...d, destinationFacilityId: id, destinationFacilityPoint: point }));
    }
  }

  protected createAndAssign(): void {
    const a = this.store.start();
    const b = this.store.destination();
    if (!a || !b) return;
    const d = this.fleet.draft();
    this.busy.set(true);
    this.fleet.createOrder({
      orderType: d.orderType,
      pickup: a.coordinate,
      destination: b.coordinate,
      pickupFacilityId: this.pickupFacility(),
      destinationFacilityId: this.destinationFacility(),
      partnerId: this.pickupFacility() ? d.partnerId : null,
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

  protected advance(o: Order): void {
    this.fleet.advance(o.id).subscribe({ error: (e) => this.done(false, describeHttpError(e, 'Advance failed')) });
  }

  protected cancel(o: Order): void {
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
