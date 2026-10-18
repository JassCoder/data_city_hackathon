import { DEPOTS, PAD, flushFleet } from '../testing/fleet-fixtures';
import { FleetService } from './core/fleet';
import { PlannerStore } from './core/planner.store';
import { MapLayerStore } from './core/map-layers';
import { settle } from '../testing/fixtures';
import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { App } from './app';
import { API_BASE_URL } from './core/api';
import { BOUNDARY, COVERAGE, _WEATHER, LAYERS, PROFILES, SCENARIOS, ZONES } from '../testing/fixtures';
import { stubCanvas } from '../testing/canvas-stub';

describe('App', () => {
  beforeAll(() => stubCanvas());

  beforeEach(async () => {
    sessionStorage.clear(); // layer visibility is kept per browser session
    await TestBed.configureTestingModule({
      imports: [App],
      providers: [provideHttpClient(), provideHttpClientTesting()],
    }).compileComponents();
  });

  it('shows no SAMPLE DATA badge, footer disclaimer or map airspace banner', () => {
    const fixture = TestBed.createComponent(App);
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.textContent).not.toContain('SAMPLE DATA');
    expect(el.querySelector('footer.disclaimer')).toBeNull();
    expect(el.querySelector('.airspace-banner')).toBeNull();
  });

  it('loads health, layers, profiles, weather, zones and the Warsaw boundary once', async () => {
    const fixture = TestBed.createComponent(App);
    fixture.detectChanges();
    const http = TestBed.inject(HttpTestingController);
    http.expectOne(`${API_BASE_URL}/health`).flush({
      status: 'ok',
      version: '0.1.0',
      mapCenter: [52.2297, 21.0122],
      coverageAvailable: true,
    });
    http.expectOne(`${API_BASE_URL}/layers`).flush(LAYERS);
    http.expectOne(`${API_BASE_URL}/drone-profiles`).flush(PROFILES);
    http.expectOne(`${API_BASE_URL}/scenarios`).flush(SCENARIOS);
    http.expectOne(`${API_BASE_URL}/weather?mode=LIVE&altitude_m=80`).flush(_WEATHER);
    http.expectOne(`${API_BASE_URL}/map/warsaw-boundary`).flush(BOUNDARY);
    http.expectOne(`${API_BASE_URL}/map/coverage`).flush(COVERAGE);
    http.expectOne(`${API_BASE_URL}/zones?altitudeM=80`).flush(ZONES);
    flushFleet(http);
    await fixture.whenStable();
    http.verify();

    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('[data-testid="backend-status"]')).toBeNull(); // no backend status in the menu bar
    const summary = el.querySelector('[data-testid="layer-summary"]')?.textContent ?? '';
    expect(summary).toContain('Buildings (OSM)');
    // Depots and hospitals are off by default (the user switches them on in Layers).
    expect(el.querySelectorAll('.leaflet-marker-pane .station-icon.station-depot').length).toBe(0);
    TestBed.inject(MapLayerStore).set('depots', true);
    fixture.detectChanges();
    expect(el.querySelectorAll('.leaflet-marker-pane .station-icon.station-depot').length).toBe(DEPOTS.length);
    expect(el.querySelector('[data-testid="route-idle"]')).not.toBeNull();
    expect(el.querySelector('[data-testid="location-start"]')).not.toBeNull();
    expect(el.querySelector('[data-testid="legend-source"]')?.textContent).toContain('No airspace data loaded');
    expect(el.querySelector('[data-testid="airspace-legend"] [data-testid="zone-list"]')).toBeNull(); // no zone list in the legend
    expect(el.querySelector('[data-testid="show-warsaw"]')).not.toBeNull();
    expect(summary).toContain('18 districts');
  });

  it('facility popup actions are the only way facilities become Point A/B', async () => {
    const fixture = TestBed.createComponent(App);
    fixture.detectChanges();
    const http = TestBed.inject(HttpTestingController);
    await settle(http, fixture);
    const app = fixture.componentInstance as unknown as { onFacilityAction(a: unknown): void };
    const store = TestBed.inject(PlannerStore);
    const fleet = TestBed.inject(FleetService);
    expect(store.start()).toBeNull();
    app.onFacilityAction({ action: 'orderFrom', restaurantId: 'osm:node/10', padId: PAD.id,
      latitude: PAD.latitude, longitude: PAD.longitude, label: 'Zapiecek' });
    expect(store.start()).toMatchObject({ coordinate: { latitude: PAD.latitude, longitude: PAD.longitude }, source: 'FACILITY' });
    expect(fleet.draft()).toMatchObject({ orderType: 'FOOD_DELIVERY', pickupFacilityId: PAD.id, partnerId: 'osm:node/10' });
    expect(fleet.dashboardOpen()).toBe(true);
    app.onFacilityAction({ action: 'setDestination', latitude: 52.2353, longitude: 21.0225, label: 'Szpital' });
    expect(store.destination()?.label).toBe('Szpital');
    store.selectScenario('EMERGENCY'); // scenario selection never moves the points
    expect(store.start()?.coordinate).toEqual({ latitude: PAD.latitude, longitude: PAD.longitude });
  });

  it('lays out the planner, a full map and floating controls instead of a right column', async () => {
    const fixture = TestBed.createComponent(App);
    fixture.detectChanges();
    await settle(TestBed.inject(HttpTestingController), fixture);
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('.panel.right')).toBeNull();
    expect(el.querySelector('.panel.left app-planner-panel')).not.toBeNull();
    const topRight = el.querySelector('.map-area .overlay.top-right')!;
    expect(Array.from(topRight.children).map((c) => c.tagName.toLowerCase())).toEqual([
      'app-map-layers-control', 'app-route-details-panel',
    ]);
    expect(el.querySelector('.map-area .overlay.bottom-right app-airspace-legend')).not.toBeNull();
    expect(el.querySelector('[data-testid="layers-panel"]')!.hasAttribute('hidden')).toBe(true); // panels start closed
    expect(el.querySelector('[data-testid="route-details-panel"]')!.hasAttribute('hidden')).toBe(true);
    expect(el.querySelector('[data-testid="airspace-legend"]')!.hasAttribute('hidden')).toBe(true);
  });
});
