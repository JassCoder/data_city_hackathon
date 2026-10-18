import { TestBed, ComponentFixture } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import * as L from 'leaflet';
import { stubCanvas } from '../../testing/canvas-stub';
import { DEPOTS, DRONES, HOSPITALS, PAD, PARTNERS, RESTAURANT_PLAIN, orderFixture } from '../../testing/fleet-fixtures';
import { clusterPoints } from './cluster';
import { FacilityAction, FleetLayers, hospitalPopup, restaurantPopup } from './fleet-layers';
import { MapComponent } from './map';
import { LAYER_DEFS, LayerKey, MapLayerStore } from '../core/map-layers';

describe('clusterPoints', () => {
  it('merges points in the same screen cell and keeps distant ones apart', () => {
    const project = (lat: number, lng: number) => ({ x: lng * 1000 + 20, y: lat * 1000 + 20 });
    const groups = clusterPoints([
      { lat: 52.2, lng: 21.0, data: 'a' },
      { lat: 52.2001, lng: 21.0001, data: 'b' },
      { lat: 52.3, lng: 21.2, data: 'c' },
    ], project, 50);
    expect(groups.map((g) => g.items.sort())).toEqual([['a', 'b'], ['c']]);
    expect(groups[0].lat).toBeCloseTo(52.20005);
  });
});

describe('Fleet map layers', () => {
  beforeAll(() => stubCanvas());

  let fixture: ComponentFixture<MapComponent>;
  let el: HTMLElement;
  const actions: FacilityAction[] = [];

  beforeEach(async () => {
    actions.length = 0;
    sessionStorage.clear();
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
    // Every layer on, so each marker type is drawn (defaults are tested separately).
    const store = TestBed.inject(MapLayerStore);
    store.visible.set(Object.fromEntries(LAYER_DEFS.map((d) => [d.key, true])) as Record<LayerKey, boolean>);
    fixture = TestBed.createComponent(MapComponent);
    fixture.componentInstance.facilityAction.subscribe((a) => actions.push(a));
    fixture.detectChanges();
    await fixture.whenStable();
    el = fixture.nativeElement;
  });

  async function set(name: string, value: unknown) {
    fixture.componentRef.setInput(name, value);
    fixture.detectChanges();
    await fixture.whenStable();
  }

  const map = () => (fixture.componentInstance as unknown as { map: L.Map }).map;
  const layers = () => (fixture.componentInstance as unknown as { fleet: FleetLayers }).fleet;

  it('registers every infrastructure layer under its Layers-panel key', () => {
    const keys = (fixture.componentInstance as unknown as { visibleLayerKeys(): string[] }).visibleLayerKeys();
    for (const k of ['hospitals', 'depots', 'partners', 'allRestaurants', 'pads', 'drones', 'deliveries']) expect(keys).toContain(k);
    TestBed.inject(MapLayerStore).set('hospitals', false);
    fixture.detectChanges();
    expect(map().hasLayer(layers().hospitals)).toBe(false);
  });

  it('draws hospitals with the medical cross and clusters them at city zoom', async () => {
    const near = { ...HOSPITALS[0], id: 'osm:way/x', latitude: HOSPITALS[0].latitude + 0.0005 };
    await set('hospitals', [...HOSPITALS, near]);
    map().setView([52.23, 21.01], 11);
    expect(layers().hospitals.clusterCount).toBe(1); // the two close hospitals merge
    expect(el.querySelector('.cluster.cluster-hospital')!.textContent).toBe('2');
    map().setView([52.23, 21.01], 16);
    expect(layers().hospitals.clusterCount).toBe(0);
    expect(el.querySelectorAll('.leaflet-marker-pane .station-icon.station-hospital').length).toBe(4);
    expect(el.querySelectorAll('.station-hospital.enabled').length).toBe(2); // enabled stations highlighted
  });

  it('hospital popup shows capacity, station status and the no-consent disclaimer', () => {
    const html = hospitalPopup(HOSPITALS[0]);
    expect(html).toContain('Warszawski Szpital Dla Dzieci');
    expect(html).toContain('Śródmieście');
    expect(html).toContain('2 available / 2 spaces');
    expect(html).toContain('SIMULATION_ENABLED');
    expect(html).toContain('has not agreed to host drones');
    expect(html).toContain('data-action="deliverTo"');
    expect(hospitalPopup(HOSPITALS[2])).toContain('Unnamed hospital (name not mapped in OSM)');
    expect(hospitalPopup(HOSPITALS[1])).not.toContain('data-action="deliverTo"'); // proposed station: no dispatch
  });

  it('restaurant popup offers ordering only for an enabled subscribed pad', () => {
    expect(restaurantPopup(PARTNERS[0])).toContain('data-action="orderFrom"');
    expect(restaurantPopup(PARTNERS[0])).toContain('DEMO partner, fictional');
    expect(restaurantPopup(RESTAURANT_PLAIN)).not.toContain('orderFrom');
    expect(restaurantPopup(RESTAURANT_PLAIN)).toContain('NOT_SUBSCRIBED');
  });

  it('popup buttons emit explicit Point A / order actions', async () => {
    await set('partners', PARTNERS);
    const marker = layers().partners.getLayers()[0] as L.Marker;
    marker.openPopup();
    const btn = marker.getPopup()!.getElement()!.querySelector<HTMLButtonElement>('[data-action="orderFrom"]')!;
    btn.click();
    expect(actions).toEqual([{ action: 'orderFrom', restaurantId: 'osm:node/10', padId: PAD.id,
      latitude: PAD.latitude, longitude: PAD.longitude, label: 'Zapiecek' }]);
    marker.openPopup();
    marker.getPopup()!.getElement()!.querySelector<HTMLButtonElement>('[data-action="setDestination"]')!.click();
    expect(actions[1]).toMatchObject({ action: 'setDestination', latitude: 52.248, longitude: 21.014 });
  });

  it('depots, pads and drone availability badges', async () => {
    await set('depots', DEPOTS);
    await set('pads', [PAD]);
    await set('drones', DRONES);
    expect(el.querySelectorAll('.leaflet-marker-pane .station-depot').length).toBe(2);
    expect(el.querySelectorAll('.leaflet-marker-pane .station-depot.high-demand').length).toBe(1);
    expect(el.querySelectorAll('.leaflet-marker-pane .station-pad').length).toBe(1);
    expect(el.querySelector('.drone-badge.available[data-facility="st-depot"]')!.textContent).toContain('1/1');
    expect(el.querySelector('.drone-badge.busy[data-facility="depot-05"]')!.textContent).toContain('0/1');
    const depotPopup = (layers().depots.getLayers()[1] as L.Marker).getPopup()!.getContent() as string;
    expect(depotPopup).toContain('4 available / 12 spaces');
    expect(depotPopup).toContain('8 available of 8 assigned');
  });

  it('draws delivery routes for active orders', async () => {
    await set('deliveries', [orderFixture()]);
    expect(el.querySelectorAll('path.delivery-delivery').length).toBe(1);
    expect(el.querySelectorAll('path.delivery-to_pickup, path.delivery-return').length).toBe(2);
    await set('deliveries', []);
    expect(el.querySelectorAll('path.delivery-delivery').length).toBe(0);
  });
});
