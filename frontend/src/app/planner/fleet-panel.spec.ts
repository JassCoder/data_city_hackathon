import { TestBed, ComponentFixture } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { API_BASE_URL } from '../core/api';
import { FleetService } from '../core/fleet';
import { PlannerStore } from '../core/planner.store';
import { CENTRALNA, KOPERNIK, settle } from '../../testing/fixtures';
import { DEPOTS, HOSPITALS, PAD, SUMMARY, flushFleet, orderFixture } from '../../testing/fleet-fixtures';
import { FleetPanelComponent } from './fleet-panel';

describe('FleetPanelComponent', () => {
  let fixture: ComponentFixture<FleetPanelComponent>;
  let http: HttpTestingController;
  let el: HTMLElement;
  let store: PlannerStore;
  let fleet: FleetService;

  beforeEach(async () => {
    TestBed.configureTestingModule({
      imports: [FleetPanelComponent],
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    http = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(FleetPanelComponent);
    store = TestBed.inject(PlannerStore);
    fleet = TestBed.inject(FleetService);
    fixture.detectChanges();
    await settle(http, fixture);
    fixture.detectChanges();
    el = fixture.nativeElement;
  });

  const q = (id: string) => el.querySelector<HTMLElement>(`[data-testid="${id}"]`)!;
  /** Change detection without whenStable (pending httpResource requests would block it). */
  const render = async () => {
    fixture.detectChanges();
    TestBed.tick();
    fixture.detectChanges();
  };
  /** Answers the fleet reloads issued after a mutation. */
  const pump = async (orders = [orderFixture()]) => {
    for (let i = 0; i < 3; i++) {
      TestBed.tick();
      flushFleet(http, orders);
    }
    await settled();
  };
  /** Only once nothing is pending: lets the flushed responses reach the signals. */
  const settled = async () => {
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  };

  it('shows fleet, station, pad and order counts with the simulation notice', () => {
    expect(q('fleet-notice').textContent).toContain('no facility has agreed to host drones');
    expect(q('stat-hospitals').textContent).toBe('45');
    expect(q('stat-stations').textContent).toBe('6');
    expect(q('stat-depots').textContent).toBe('10');
    expect(q('stat-available').textContent).toBe('50');
    expect(q('stat-charging').textContent).toBe('1');
    expect(q('stat-partners').textContent).toBe('6');
    expect(q('stat-free').textContent).toBe('44');
    expect(q('utilization').textContent).toContain('52/78');
  });

  it('filters the dashboard by district', async () => {
    const select = q('district-filter') as HTMLSelectElement;
    expect([...select.options].map((o) => o.value)).toContain('Praga-Południe');
    select.value = 'Praga-Południe';
    select.dispatchEvent(new Event('change'));
    await render();
    http.expectOne(`${API_BASE_URL}/fleet/summary?district=Praga-Po%C5%82udnie`).flush({ ...SUMMARY, depots: 1 });
    await settled();
    expect(q('stat-depots').textContent).toBe('1');
  });

  it('orders use the planner Point A and B; nothing is sent without both', async () => {
    expect((q('order-submit') as HTMLButtonElement).disabled).toBe(true);
    store.setLocation('start', CENTRALNA);
    store.setLocation('destination', KOPERNIK);
    await render();
    q('order-submit').click();
    const create = http.expectOne(`${API_BASE_URL}/orders`);
    expect(create.request.body).toMatchObject({
      orderType: 'FOOD_DELIVERY', pickup: CENTRALNA.coordinate, destination: KOPERNIK.coordinate,
      pickupFacilityId: null, destinationFacilityId: null,
    });
    create.flush(orderFixture({ id: 'ord-9', status: 'CREATED' }));
    const assign = http.expectOne(`${API_BASE_URL}/orders/ord-9/assign-drone`);
    assign.flush({ order: orderFixture({ id: 'ord-9' }), assigned: true, candidates: [], message: 'Drone SR-001 reserved.' });
    await pump([orderFixture({ id: 'ord-9' })]);
    expect(q('fleet-message').textContent).toContain('SR-001 reserved');
    expect(el.querySelector('[data-order-id="ord-9"]')!.textContent).toContain('ASSIGNED');
  });

  it('an explicitly chosen facility is used only while Point A still sits on it', async () => {
    const padPoint = { latitude: PAD.latitude, longitude: PAD.longitude };
    store.setLocation('start', { coordinate: padPoint, label: 'Zapiecek (pickup pad)', source: 'FACILITY' });
    store.setLocation('destination', KOPERNIK);
    fleet.draft.update((d) => ({ ...d, pickupFacilityId: PAD.id, pickupFacilityPoint: padPoint, partnerId: 'osm:node/10' }));
    await render();
    expect(q('order-pickup').textContent).toContain(PAD.id);
    store.setLocation('start', CENTRALNA); // the user moved Point A: the pad no longer applies
    await render();
    expect(q('order-pickup').textContent).not.toContain(PAD.id);
    q('order-submit').click();
    expect(http.expectOne(`${API_BASE_URL}/orders`).request.body.pickupFacilityId).toBeNull();
  });

  it('choosing a hospital station sets Point B explicitly and requests landing there', async () => {
    store.setLocation('start', CENTRALNA);
    const sel = q('order-station') as HTMLSelectElement;
    const enabled = HOSPITALS[0].station!;
    sel.value = enabled.id;
    sel.dispatchEvent(new Event('change'));
    await render();
    expect(store.destination()?.coordinate).toEqual({ latitude: enabled.latitude, longitude: enabled.longitude });
    expect(store.destination()?.source).toBe('FACILITY');
    q('order-submit').click();
    expect(http.expectOne(`${API_BASE_URL}/orders`).request.body.destinationFacilityId).toBe(enabled.id);
  });

  it('advances an active order', async () => {
    fleet.ordersResource.reload();
    await pump();
    q('order-advance').click();
    http.expectOne(`${API_BASE_URL}/orders/ord-1/advance`).flush(orderFixture({ status: 'TO_PICKUP' }));
  });

  it('admin capacity changes use the development token', async () => {
    q('admin-toggle').click();
    await render();
    const input = el.querySelector<HTMLInputElement>(`[data-admin-depot="${DEPOTS[0].id}"] input[type="number"]`)!;
    input.value = '10';
    input.dispatchEvent(new Event('change'));
    const req = http.expectOne(`${API_BASE_URL}/depots/${DEPOTS[0].id}`);
    expect(req.request.method).toBe('PATCH');
    expect(req.request.body).toEqual({ capacity: 10 });
    expect(req.request.headers.get('X-Admin-Token')).toBe('dev-admin-token');
    req.flush({ ...DEPOTS[0], capacity: 10 });
  });

  it('shows simulated demand recommendations separately from installed capacity', async () => {
    q('demand-toggle').click();
    await render();
    http.expectOne(`${API_BASE_URL}/fleet/demand?scenario=BASELINE`).flush({
      scenario: 'BASELINE', label: 'Baseline simulated demand.', peakConcurrentDeliveries: 40, assumptions: [],
      depots: [{ depotId: 'depot-05', name: 'Proposed depot 05', district: 'Śródmieście', installedCapacity: 12, drones: 8,
        demandShare: 0.4, demandScore: 4, expectedPeakDrones: 16, utilizationAtPeak: 1.33, level: 'HIGH',
        recommendation: 'Add 4 spaces' }],
    });
    await settled();
    const row = el.querySelector('[data-depot="depot-05"]')!;
    expect(row.textContent).toContain('HIGH');
    expect(row.getAttribute('title')).toContain('Add 4 spaces');
    expect(q('demand').textContent).toContain('never change installed capacity');
  });
});
