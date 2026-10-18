import { Component } from '@angular/core';
import { TestBed, ComponentFixture } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { API_BASE_URL } from '../core/api';
import { AirspaceService } from '../core/airspace';
import { LAYER_DEFS, MapLayerStore, defaultVisibility } from '../core/map-layers';
import { PlannerStore } from '../core/planner.store';
import { CENTRALNA, CITYWIDE_ZONES, KOPERNIK, ZONES, routeResponse, settle } from '../../testing/fixtures';
import { RouteDetailsPanelComponent } from '../planner/route-details-panel';
import { AirspaceLegendComponent } from './airspace-legend';
import { MapLayersControlComponent } from './layers-control';
import { ZONE_COLORS } from './map';

@Component({
  imports: [MapLayersControlComponent, RouteDetailsPanelComponent, AirspaceLegendComponent],
  template: `<app-map-layers-control /><app-route-details-panel /><app-airspace-legend />`,
})
class Host {}

const ROUTE_URL = `${API_BASE_URL}/routes/calculate`;

describe('Map overlays: Layers, Route Details, Airspace Legend', () => {
  let fixture: ComponentFixture<Host>;
  let http: HttpTestingController;
  let el: HTMLElement;
  let layers: MapLayerStore;

  beforeEach(async () => {
    sessionStorage.clear();
    TestBed.configureTestingModule({ imports: [Host], providers: [provideHttpClient(), provideHttpClientTesting()] });
    http = TestBed.inject(HttpTestingController);
    layers = TestBed.inject(MapLayerStore);
    fixture = TestBed.createComponent(Host);
    fixture.detectChanges();
    await settle(http, fixture);
    fixture.detectChanges();
    el = fixture.nativeElement;
  });

  const q = <T extends HTMLElement = HTMLElement>(id: string) => el.querySelector<T>(`[data-testid="${id}"]`)!;
  const box = (id: string) => q<HTMLLabelElement>(id).querySelector<HTMLInputElement>('input')!;
  const render = () => fixture.detectChanges();

  // --- Layers --------------------------------------------------------------------------

  it('Layers opens and closes; buttons are stacked Layers then Route Details', () => {
    const buttons = Array.from(el.querySelectorAll('.map-fab')).map((b) => b.textContent!.trim());
    expect(buttons.slice(0, 2)).toEqual(['layers Layers', 'route Route Details']);
    expect(q('layers-panel').hidden).toBe(true);
    q('layers-toggle').click();
    render();
    expect(q('layers-panel').hidden).toBe(false);
    expect(q('layers-toggle').getAttribute('aria-expanded')).toBe('true');
    q('layers-toggle').click();
    render();
    expect(q('layers-panel').hidden).toBe(true);
  });

  it('lists every layer with the exact labels and the specified defaults', () => {
    const text = q('layers-panel').textContent!;
    for (const label of ['Airspace zones', 'All buildings (zoom ≥ 15)', 'Hospitals (OSM; stations simulated)',
      'Drone depots (simulated)', 'Subscribed restaurants (demo)', 'All restaurants (OSM)', 'Proposed pickup pads',
      'Drones at facilities', 'Delivery routes', 'Warsaw boundary (GUGiK PRG)', '18 districts', 'River', 'Parks / green',
      'Buildings ≥ 50 m', 'Sample landing stations (legacy)']) {
      expect(text).toContain(label);
    }
    const on = LAYER_DEFS.filter((d) => box('layer-' + d.key).checked).map((d) => d.key);
    expect(on).toEqual(['airspaceZones', 'deliveries', 'boundary', 'districts', 'river', 'parks']);
  });

  it.each(LAYER_DEFS.map((d) => d.key))('checkbox %s toggles that layer in the store', (key) => {
    const input = box('layer-' + key);
    const before = layers.isVisible(key);
    input.click();
    render();
    expect(layers.isVisible(key)).toBe(!before);
    input.click();
    expect(layers.isVisible(key)).toBe(before);
  });

  it('DRA categories show dynamic counts from the loaded dataset', async () => {
    const text = () => q('airspace-categories').textContent!;
    expect(text()).toContain('DRA-P prohibited (1)');
    expect(text()).toContain('DRA-R / RH / RM / RL restricted (2)');
    expect(text()).toContain('DRA-T technical (0)');
    expect(text()).toContain('DRA-U U-space (0)');
    expect(text()).toContain('DRA-I information (1)');
    expect(text()).toContain('Unknown category (1)');
    TestBed.inject(PlannerStore).setAltitude(100); // new evaluation → new dataset response
    render();
    http.expectOne(`${API_BASE_URL}/zones?altitudeM=100`).flush({ ...ZONES, zones: [...ZONES.zones, ...CITYWIDE_ZONES] });
    await fixture.whenStable();
    render();
    expect(text()).toContain('DRA-P prohibited (2)');
    expect(text()).toContain('DRA-U U-space (1)');
  });

  it('counts planning constraints (OSM airports, military, government) separately from official DRA types', async () => {
    const plan = {
      ...ZONES.zones[0], id: 'PLAN-osm_way_237594029', name: 'Airport grounds: Lotnisko Chopina', draCategory: 'PLANNING' as const,
      sourceType: 'PLANNING_CONSTRAINT' as const,
      evaluation: { status: 'BLOCKED' as const, displayClass: 'RED' as const, isObstacle: true, reasons: ['SkyRoute planning constraint'] },
    };
    TestBed.inject(PlannerStore).setAltitude(100);
    render();
    http.expectOne(`${API_BASE_URL}/zones?altitudeM=100`).flush({ ...ZONES, zones: [...ZONES.zones, plan] });
    await fixture.whenStable();
    render();
    const text = q('airspace-categories').textContent!;
    expect(text).toContain('Planning constraints: airports, military, government (OSM, not official) (1)');
    expect(text).toContain('DRA-P prohibited (1)'); // not counted as an official prohibited zone
    expect(q('airspace-legend').textContent).toContain('planning constraints');
  });

  it('category filters hide zones on the map only and survive hiding the parent layer', () => {
    const airspace = TestBed.inject(AirspaceService);
    box('category-P').click();
    render();
    expect(airspace.visibleZones().some((z) => z.draCategory === 'DRA-P')).toBe(false);
    expect(airspace.zones().length).toBe(ZONES.zones.length); // routing data untouched
    box('layer-airspaceZones').click(); // hide the parent
    box('layer-airspaceZones').click(); // show it again
    render();
    expect(airspace.filters().P).toBe(false); // the individual choice is kept
    expect(box('category-P').checked).toBe(false);
  });

  it('warns that zero loaded features is not proof of no restrictions when official data is missing', async () => {
    TestBed.inject(PlannerStore).setAltitude(100);
    render();
    http.expectOne(`${API_BASE_URL}/zones?altitudeM=100`).flush({
      ...ZONES, zones: [],
      airspaceStatus: { sourceState: 'UNAVAILABLE', officialDataAvailable: false, officialCoveragePct: 0,
        coverageBasis: 'NO_OFFICIAL_DATA', ageDays: null, staleAfterDays: 28, provider: 'none', label: 'No airspace data loaded',
        message: 'Official airspace data UNAVAILABLE.' },
    });
    await fixture.whenStable();
    render();
    expect(q('airspace-categories').textContent).toContain('DRA-P prohibited (0)');
    expect(q('airspace-coverage-warning').textContent).toContain('zero does not mean there are no restrictions');
  });

  it('Reset to defaults restores the specified layers', () => {
    layers.set('buildings', true);
    layers.set('hospitals', false);
    q('layers-reset').click();
    expect(layers.visible()).toEqual(defaultVisibility());
  });

  // --- Route Details -------------------------------------------------------------------

  it('Route Details opens/closes, starts empty and stays closed for a new route until clicked', async () => {
    expect(q('route-details-panel').hidden).toBe(true);
    q('route-details-toggle').click();
    render();
    expect(q('route-details-panel').hidden).toBe(false);
    expect(q('layers-panel').hidden).toBe(true); // one top-right panel at a time
    expect(q('route-idle').textContent).toContain('No route calculated yet');
    q('route-details-toggle').click();
    render();
    expect(q('route-details-panel').hidden).toBe(true);

    const store = TestBed.inject(PlannerStore);
    store.setLocation('start', CENTRALNA);
    store.setLocation('destination', KOPERNIK);
    store.calculate();
    const req = http.expectOne(ROUTE_URL);
    req.flush(routeResponse(req.request.body));
    render();
    expect(q('route-details-panel').hidden).toBe(true); // only opens when the user clicks it
    q('route-details-toggle').click();
    render();
    expect(q('route-details-panel').hidden).toBe(false);
    const panel = q('route-details-panel').textContent!;
    for (const part of ['Route overview', 'Weather conditions', 'Drone', 'Safety and warnings', 'Standard Drone']) {
      expect(panel).toContain(part);
    }
    expect(q('route-from').textContent).toContain(CENTRALNA.label);
    expect(q('route-distance').textContent).toContain('3.04 km');
    expect(q('route-calculated').textContent).toContain('Warsaw time');
    expect(q('route-details-panel').querySelector('[data-testid="zone-list"]')).toBeNull(); // no zone listing here
    q('route-details-toggle').click();
    q('route-details-toggle').click();
    render();
    expect(q('route-distance').textContent).toContain('3.04 km'); // kept while toggling
  });

  // --- Airspace Legend -----------------------------------------------------------------

  it('Airspace Legend opens/closes with colours that match the map styles', () => {
    expect(q('airspace-legend').hidden).toBe(true);
    q('legend-toggle').click();
    render();
    expect(q('airspace-legend').hidden).toBe(false);
    const swatches = Array.from(q('airspace-legend').querySelectorAll<HTMLElement>('.legend-rows .sw')).slice(0, 5);
    const rgb = (hex: string) => {
      const n = parseInt(hex.slice(1), 16);
      return `rgb(${n >> 16}, ${(n >> 8) & 255}, ${n & 255})`;
    };
    expect(swatches[0].style.background).toBe(rgb(ZONE_COLORS.RED));
    expect(swatches[1].style.background).toBe(rgb(ZONE_COLORS.ORANGE));
    expect(swatches[4].style.background).toBe(rgb(ZONE_COLORS.GRAY));
    expect(q('legend-altitude').textContent).toContain('80 m AGL');
    expect(q('legend-source').textContent).toContain('No airspace data loaded');
    expect(q('legend-freshness').textContent).not.toBe('');
    expect(q('legend-margin').textContent).toContain('20 m around blocked zones (modelling assumption');
    const before = layers.visible();
    q('legend-toggle').click();
    render();
    expect(q('airspace-legend').hidden).toBe(true);
    expect(layers.visible()).toEqual(before); // closing never changes layers
  });
});
