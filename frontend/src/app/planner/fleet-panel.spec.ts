import { TestBed, ComponentFixture } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { API_BASE_URL } from '../core/api';
import { MapLayerStore } from '../core/map-layers';
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
    sessionStorage.clear(); // "my orders" and layer choices are kept per browser session
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

  /** Searches an address in one of the order form fields and answers with a single building match. */
  async function chooseAddress(field: string, name: string, latitude: number, longitude: number) {
    const box = q(field);
    const input = box.querySelector<HTMLInputElement>('[data-testid="query"]')!;
    input.value = name;
    input.dispatchEvent(new Event('input'));
    box.querySelector<HTMLButtonElement>('[data-testid="search"]')!.click();
    http.expectOne((r) => r.url === `${API_BASE_URL}/geocoding/search`).flush({
      query: name, provider: 'test', attribution: 'test', cached: false, note: null,
      results: [{ displayName: name, latitude, longitude, placeId: 'prg:' + name, category: 'address/prg',
        source: 'gugik-prg', inCoverage: true, accuracy: 'ADDRESS' }],
    });
    await render();
  }

  it('food orders ask for a pickup and a delivery address (not the planner points)', async () => {
    store.setLocation('start', CENTRALNA); // planner points are not used by the fleet form
    store.setLocation('destination', KOPERNIK);
    await render();
    expect(el.textContent).not.toContain('Point A');
    expect(el.textContent).not.toContain('Point B');
    expect((q('order-submit') as HTMLButtonElement).disabled).toBe(true);
    expect(q('order-missing').textContent).toContain('pickup address and the delivery address');
    await chooseAddress('order-pickup', 'Nowy Świat 10, Warszawa', 52.2335, 21.0186);
    expect(q('order-pickup').textContent).toContain('Nowy Świat 10');
    expect((q('order-submit') as HTMLButtonElement).disabled).toBe(true);
    await chooseAddress('order-delivery', 'Puławska 2, Warszawa', 52.2126, 21.0207);
    q('order-submit').click();
    const create = http.expectOne(`${API_BASE_URL}/orders`);
    expect(create.request.body).toMatchObject({
      orderType: 'FOOD_DELIVERY', pickup: { latitude: 52.2335, longitude: 21.0186 },
      destination: { latitude: 52.2126, longitude: 21.0207 }, pickupFacilityId: null, destinationFacilityId: null,
    });
    create.flush(orderFixture({ id: 'ord-9', status: 'CREATED' }));
    const assign = http.expectOne(`${API_BASE_URL}/orders/ord-9/assign-drone`);
    assign.flush({ order: orderFixture({ id: 'ord-9' }), assigned: true, candidates: [], message: 'Drone SR-001 reserved.' });
    await pump([orderFixture({ id: 'ord-9' })]);
    expect(q('fleet-message').textContent).toContain('SR-001 reserved');
    expect(el.querySelector('[data-order-id="ord-9"]')!.textContent).toContain('ASSIGNED');
  });

  it('medical orders ask only for the delivery address and start at the nearest hospital', async () => {
    const type = q('order-type') as HTMLSelectElement;
    type.value = 'AED_DELIVERY';
    type.dispatchEvent(new Event('change'));
    await render();
    expect(el.querySelector('[data-testid="order-pickup"]')).toBeNull();
    expect(q('order-hospital').textContent).toContain('nearest hospital');
    await chooseAddress('order-delivery', 'Puławska 2, Warszawa', 52.2126, 21.0207);
    const near = http.expectOne((r) => r.url === `${API_BASE_URL}/hospitals/nearest`);
    expect(near.request.params.get('latitude')).toBe('52.2126');
    const hospital = HOSPITALS[0];
    near.flush({ hospital, distanceM: 1250, pickup: { latitude: hospital.latitude, longitude: hospital.longitude },
      pickupFacilityId: null, note: 'Pickup at the hospital\'s mapped location.' });
    await render();
    expect(q('order-hospital').textContent).toContain(hospital.name!);
    expect(q('order-hospital').textContent).toContain('1.3 km');
    q('order-submit').click();
    expect(http.expectOne(`${API_BASE_URL}/orders`).request.body).toMatchObject({
      orderType: 'AED_DELIVERY', pickup: { latitude: hospital.latitude, longitude: hospital.longitude },
      partnerId: hospital.id, destination: { latitude: 52.2126, longitude: 21.0207 },
    });
  });

  it('the order type switches on the matching map layers', async () => {
    const layers = TestBed.inject(MapLayerStore);
    const type = q('order-type') as HTMLSelectElement;
    type.value = 'BLOOD_DELIVERY';
    type.dispatchEvent(new Event('change'));
    await render();
    expect(layers.isVisible('hospitals')).toBe(true);
    expect(layers.isVisible('depots')).toBe(true);
    expect(layers.isVisible('partners')).toBe(false);
    type.value = 'FOOD_DELIVERY';
    type.dispatchEvent(new Event('change'));
    await render();
    expect(layers.isVisible('partners')).toBe(true);
    expect(layers.isVisible('pads')).toBe(true);
    expect(layers.isVisible('hospitals')).toBe(false);
  });

  it('a restaurant pad chosen in a popup is used until the user searches another pickup', async () => {
    fleet.draft.update((d) => ({ ...d, pickup: { coordinate: { latitude: PAD.latitude, longitude: PAD.longitude },
      label: 'Zapiecek (pickup pad)' }, pickupFacilityId: PAD.id, partnerId: 'osm:node/10' }));
    await render();
    expect(q('order-pickup').textContent).toContain('Zapiecek');
    await chooseAddress('order-delivery', 'Puławska 2, Warszawa', 52.2126, 21.0207);
    q('order-submit').click();
    expect(http.expectOne(`${API_BASE_URL}/orders`).request.body).toMatchObject({ pickupFacilityId: PAD.id, partnerId: 'osm:node/10' });
  });

  it('lists only the orders created in this session, not older orders from the database', async () => {
    fleet.ordersResource.reload();
    await pump([orderFixture({ id: 'ord-old', status: 'NO_DRONE_AVAILABLE', message: 'No eligible drone: Needs 22.3 km…' })]);
    expect(el.querySelector('[data-order-id="ord-old"]')).toBeNull();
    expect(q('orders').textContent).toContain('No orders yet');
    expect(fleet.activeOrders()).toEqual([]); // nothing of someone else's is drawn on the map either
  });

  it('"Select on map" fills the order field from the next map click', async () => {
    const box = q('order-delivery');
    box.querySelector<HTMLButtonElement>('[data-testid="pick"]')!.click();
    await render();
    expect(fleet.pickTarget()).toBe('delivery');
    expect(store.pickTarget()).toBeNull();
    expect(box.textContent).toContain('Click the map');
    fleet.setPickedPoint({ latitude: 52.2126, longitude: 21.0207 }); // what App does with the map click
    await render();
    expect(fleet.draft().delivery?.coordinate).toEqual({ latitude: 52.2126, longitude: 21.0207 });
    expect(q('order-delivery').textContent).toContain('Map point 52.21260, 21.02070');
    expect(fleet.pickTarget()).toBeNull();
    expect(store.destination()).toBeNull(); // the planner's points are untouched
  });

  it('advances an active order', async () => {
    fleet.myOrderIds.set(['ord-1']);
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
