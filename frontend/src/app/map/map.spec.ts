import { TestBed, ComponentFixture } from '@angular/core/testing';
import * as L from 'leaflet';
import { RouteState } from '../core/planner.store';
import { BOUNDARY, CENTRALNA, KOPERNIK, ZONES, routeResponse } from '../../testing/fixtures';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { stubCanvas } from '../../testing/canvas-stub';
import { AirspaceZone } from '../core/airspace';
import { BUILDING_MIN_ZOOM, MapComponent, tilesFor } from './map';
import { Coordinate, RouteRequest } from '../core/models';

const REQUEST: RouteRequest = {
  start: CENTRALNA.coordinate,
  destination: KOPERNIK.coordinate,
  mode: 'NORMAL',
  flightAltitudeMeters: 80,
  droneProfileId: 'DEMO_DRONE_01',
  weatherMode: 'DEMO',
  routeObjective: 'CORRIDORS',
};

describe('MapComponent', () => {
  beforeAll(() => stubCanvas());

  let fixture: ComponentFixture<MapComponent>;
  let el: HTMLElement;

  beforeEach(async () => {
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
    fixture = TestBed.createComponent(MapComponent);
    fixture.detectChanges();
    await fixture.whenStable();
    el = fixture.nativeElement;
  });

  async function set(name: string, value: unknown) {
    fixture.componentRef.setInput(name, value);
    fixture.detectChanges();
    await fixture.whenStable();
  }

  const leaflet = () => (fixture.componentInstance as unknown as { map: L.Map }).map;

  it('shows, moves and removes the start/destination markers', async () => {
    await set('start', CENTRALNA);
    await set('destination', KOPERNIK);
    expect(el.querySelectorAll('.route-pin-start').length).toBe(1);
    expect(el.querySelectorAll('.route-pin-destination').length).toBe(1);

    const moved = { ...CENTRALNA, coordinate: { latitude: 52.235, longitude: 21.0385 } };
    await set('start', moved);
    expect(el.querySelectorAll('.route-pin-start').length).toBe(1);
    const marker = Object.values((leaflet() as unknown as { _layers: Record<string, L.Layer> })._layers).find(
      (l) => l instanceof L.Marker && (l.options.icon as L.DivIcon).options.html?.toString().includes('route-pin-start'),
    ) as L.Marker;
    expect(marker.getLatLng()).toEqual(L.latLng(52.235, 21.0385));

    await set('start', null);
    expect(el.querySelectorAll('.route-pin-start').length).toBe(0);
  });

  it('draws the returned route and styles it by mode and staleness', async () => {
    const response = routeResponse(REQUEST);
    await set('route', { phase: 'ready', response, request: REQUEST } satisfies RouteState);
    expect(el.querySelectorAll('path.route-normal').length).toBe(1);

    const emergency = routeResponse({ ...REQUEST, mode: 'EMERGENCY' });
    await set('route', { phase: 'ready', response: emergency, request: REQUEST } satisfies RouteState);
    expect(el.querySelectorAll('path.route-emergency').length).toBe(1);
    expect(el.querySelectorAll('path.route-normal').length).toBe(0);

    await set('route', { phase: 'stale', response: emergency, request: REQUEST } satisfies RouteState);
    expect(el.querySelectorAll('path.route-stale').length).toBe(1);

    await set('route', { phase: 'idle' } satisfies RouteState);
    expect(el.querySelectorAll('path.route-line').length).toBe(0);
  });

  it('does not draw a line for a NO_ROUTE result', async () => {
    const none = routeResponse(REQUEST, { status: 'NO_ROUTE', geometry: null });
    await set('route', { phase: 'ready', response: none, request: REQUEST } satisfies RouteState);
    expect(el.querySelectorAll('path.route-line').length).toBe(0);
  });

  it('emits map clicks as coordinates', () => {
    const clicks: Coordinate[] = [];
    fixture.componentInstance.mapClick.subscribe((c) => clicks.push(c));
    leaflet().fire('click', { latlng: L.latLng(52.231, 21.012) });
    expect(clicks).toEqual([{ latitude: 52.231, longitude: 21.012 }]);
  });

  it('uses a crosshair while a pick target is armed', async () => {
    await set('picking', true);
    expect(el.querySelector('.map')!.classList.contains('picking')).toBe(true);
  });

  // --- airspace ------------------------------------------------------------

  type ZoneLayer = L.Polygon & { feature: { properties: { id: string; zone: AirspaceZone } } };
  const zoneLayers = () =>
    ((fixture.componentInstance as unknown as { zoneLayer: L.GeoJSON }).zoneLayer.getLayers() as ZoneLayer[]);
  const byId = (id: string) => zoneLayers().find((l) => l.feature.properties.id === id)!;

  it('renders restricted zones without a calculated route', async () => {
    await set('zones', ZONES.zones);
    expect(zoneLayers().length).toBe(ZONES.zones.length);
    expect(fixture.componentInstance.route()).toEqual({ phase: 'idle' });
  });

  it('styles blocked zones red with a solid red outline', async () => {
    await set('zones', ZONES.zones);
    const sejm = byId('DEMO-P-SEJM').options;
    expect(sejm.fillColor).toBe('#d32f2f');
    expect(sejm.color).toBe('#c62828');
    expect(sejm.dashArray).toBeUndefined();
    const pkin = byId('DEMO-RM-PKIN').options;
    expect(pkin.fillColor).toBe('#f57c00'); // orange classification...
    expect(pkin.color).toBe('#c62828'); // ...but a red-outlined obstacle for this route
    const info = byId('DEMO-I-VISTULA').options;
    expect(info.fillColor).toBe('#f9a825');
    expect(info.dashArray).toBeTruthy(); // not an obstacle
    expect(byId('DEMO-X-INCOMPLETE').options.fillColor).toBe('#757575');
    expect(byId('DEMO-RH-SCHOOL').options.dashArray).toBe('4 6'); // inactive at this altitude
  });

  it('popups show name, DRA category, status, altitude, source and DEMO label', async () => {
    await set('zones', ZONES.zones);
    const html = byId('DEMO-P-SEJM').getPopup()!.getContent() as string;
    expect(html).toContain('DEMO prohibited area: Sejm / Wiejska');
    expect(html).toContain('DRA-P');
    expect(html).toContain('Blocked: prohibited for the planned operation');
    expect(html).toContain('0 m – 300 m AGL');
    expect(html).toContain('SkyRoute DEMO dataset (synthetic)');
    expect(html).toContain('NOT an official geographical zone');
    const circle = byId('DEMO-RH-SCHOOL').getPopup()!.getContent() as string;
    expect(circle).toContain('100 m radius');
    const unknown = byId('DEMO-X-INCOMPLETE').getPopup()!.getContent() as string;
    expect(unknown).toContain('unknown floor');
  });

  it('only draws the zones it is given (category filters)', async () => {
    await set('zones', ZONES.zones.filter((z) => z.draCategory !== 'DRA-P'));
    expect(zoneLayers().some((l) => l.feature.properties.id === 'DEMO-P-SEJM')).toBe(false);
  });

  it('highlights the zone that blocks a selected point', async () => {
    await set('zones', ZONES.zones);
    await set('highlightZoneIds', ['DEMO-P-SEJM']);
    expect(byId('DEMO-P-SEJM').options.weight).toBe(5);
  });

  it('shows the airspace source in the banner and legend', async () => {
    await set('airspaceSource', ZONES.source);
    expect(el.querySelector('.airspace-banner')!.textContent).toContain('not official PAŻP boundaries');
    expect(el.querySelector('[data-testid="legend-source"]')!.textContent).toContain('DEMO');
  });

  it('a click inside a zone picks a point while picking is armed', async () => {
    await set('zones', ZONES.zones);
    await set('picking', true);
    const clicks: Coordinate[] = [];
    fixture.componentInstance.mapClick.subscribe((c) => clicks.push(c));
    byId('DEMO-P-SEJM').fire('click', { latlng: L.latLng(52.225, 21.026) });
    expect(clicks).toEqual([{ latitude: 52.225, longitude: 21.026 }]);
  });

  // --- citywide view ----------------------------------------------------------

  const sized = () => {
    (leaflet() as unknown as { getSize: () => L.Point }).getSize = () => L.point(800, 600);
  };

  it('draws the Warsaw boundary and 18-district layer and fits the whole city on load', async () => {
    sized();
    const fit = vi.spyOn(leaflet(), 'fitBounds');
    await set('boundary', BOUNDARY);
    expect(fit).toHaveBeenCalledTimes(1);
    const bounds = fit.mock.calls[0][0] as L.LatLngBounds;
    expect(bounds.getWest()).toBeCloseTo(20.85);
    expect(bounds.getNorth()).toBeCloseTo(52.37);
    expect(el.querySelectorAll('.district-label').length).toBe(BOUNDARY.districts.features.length);
    // Later boundary refreshes do not yank the view again.
    await set('boundary', { ...BOUNDARY });
    expect(fit).toHaveBeenCalledTimes(1);
  });

  it('"Show Entire Warsaw" fits the city again', async () => {
    sized();
    await set('boundary', BOUNDARY);
    const fit = vi.spyOn(leaflet(), 'fitBounds');
    el.querySelector<HTMLButtonElement>('[data-testid="show-warsaw"]')!.click();
    expect(fit).toHaveBeenCalledTimes(1);
  });

  it('shows a labelled fallback view when the boundary is missing', async () => {
    await set('boundaryMissing', true);
    const banner = el.querySelector<HTMLElement>('[data-testid="coverage-banner"]')!;
    expect(banner.hidden).toBe(false);
    expect(banner.textContent).toContain('boundary data unavailable');
    expect(leaflet().getZoom()).toBe(11); // approximate city view, not a blank map
  });

  it('computes the z14 building tiles covering a view', () => {
    const tiles = tilesFor(21.0, 52.225, 21.02, 52.235);
    expect(tiles.length).toBeGreaterThan(0);
    expect(tiles).toContainEqual([9148, 5394]); // Palace of Culture tile
  });

  it('loads building tiles only at street zoom', async () => {
    const http = TestBed.inject(HttpTestingController);
    const map = leaflet();
    (map as unknown as { getSize: () => L.Point }).getSize = () => L.point(800, 600);
    map.setView([52.2297, 21.0122], 12);
    map.fire('moveend');
    http.expectNone((r) => r.url.includes('/map/buildings/'));
    map.setView([52.2297, 21.0122], BUILDING_MIN_ZOOM + 1);
    map.fire('moveend');
    const reqs = http.match((r) => r.url.includes('/map/buildings/14/'));
    expect(reqs.length).toBeGreaterThan(0);
    reqs.forEach((r) => r.flush({ type: 'FeatureCollection', features: [] }));
  });

  it('keeps both markers in place when routes for different scenarios are shown', async () => {
    await set('start', CENTRALNA);
    await set('destination', KOPERNIK);
    const pos = (role: string) =>
      (Object.values((leaflet() as unknown as { _layers: Record<string, L.Layer> })._layers).find(
        (l) => l instanceof L.Marker && (l.options.icon as L.DivIcon).options.html?.toString().includes(`route-pin-${role}`),
      ) as L.Marker).getLatLng();
    const a = pos('start');
    const b = pos('destination');
    for (const scenario of ['BLOOD_DELIVERY', 'AED_DELIVERY', 'AVOID_PROHIBITED_ZONE', 'EMERGENCY'] as const) {
      const req = { ...REQUEST, scenario };
      await set('route', { phase: 'ready', response: routeResponse(req), request: req } satisfies RouteState);
      expect(pos('start')).toEqual(a);
      expect(pos('destination')).toEqual(b);
      expect(el.querySelectorAll('.route-pin-start').length).toBe(1);
    }
  });
});
