import { TestBed, ComponentFixture } from '@angular/core/testing';
import * as L from 'leaflet';
import { RouteState } from '../core/planner.store';
import { BOUNDARY, CENTRALNA, CITYWIDE_ZONES, KOPERNIK, ZONES, routeResponse } from '../../testing/fixtures';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { stubCanvas } from '../../testing/canvas-stub';
import { AirspaceZone } from '../core/airspace';
import { BUILDING_MIN_ZOOM, MapComponent, tilesFor } from './map';
import { MapLayerStore } from '../core/map-layers';
import { Coordinate, RouteRequest } from '../core/models';

const REQUEST: RouteRequest = {
  start: CENTRALNA.coordinate,
  destination: KOPERNIK.coordinate,
  mode: 'NORMAL',
  flightAltitudeMeters: 80,
  droneProfileId: 'DEMO_DRONE_01',
  weatherMode: 'SAMPLE',
  optimization: 'BALANCED',
};

describe('MapComponent', () => {
  beforeAll(() => stubCanvas());

  let fixture: ComponentFixture<MapComponent>;
  let el: HTMLElement;

  beforeEach(async () => {
    sessionStorage.clear(); // layer visibility is kept per browser session
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

  it('draws offered entrances and emits the chosen one; a searched address zooms to building level', async () => {
    (leaflet() as unknown as { getSize: () => L.Point }).getSize = () => L.point(800, 600);
    const chosen: unknown[] = [];
    fixture.componentInstance.entranceSelected.subscribe((e) => chosen.push(e));
    const e = { id: 'node/2', latitude: 52.2127, longitude: 21.0209, entrance: 'staircase', ref: 'B', flats: '11-20',
      housenumber: null, street: null, wheelchair: null, matchesFlat: true };
    await set('entrances', [e]);
    const pin = el.querySelector<HTMLElement>('.entrance-pin[data-entrance-id="node/2"]')!;
    expect(pin.textContent).toBe('B');
    expect(pin.classList.contains('flat-match')).toBe(true);
    const marker = Object.values((leaflet() as unknown as { _layers: Record<string, L.Layer> })._layers).find(
      (l) => l instanceof L.Marker && String((l.options.icon as L.DivIcon).options.html).includes('entrance-pin'),
    ) as L.Marker;
    marker.fire('click');
    expect(chosen).toEqual([e]);
    await set('destination', { coordinate: { latitude: 52.2126, longitude: 21.0207 }, label: 'Puławska 2', source: 'SEARCH', accuracy: 'ADDRESS' });
    expect(leaflet().getZoom()).toBe(18);
    expect(leaflet().getCenter().lat).toBeCloseTo(52.2126, 4);
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
    const sejm = byId('-P-SEJM').options;
    expect(sejm.fillColor).toBe('#dc2626');
    expect(sejm.color).toBe('#b91c1c');
    expect(sejm.weight).toBe(2);
    expect(sejm.fillOpacity).toBeGreaterThanOrEqual(0.25);
    expect(sejm.fillOpacity).toBeLessThanOrEqual(0.4);
    expect(sejm.dashArray).toBeUndefined();
    const pkin = byId('-RM-PKIN').options;
    expect(pkin.fillColor).toBe('#dc2626'); // restricted, no authorization: red like prohibited
    expect(pkin.color).toBe('#b91c1c'); // with the solid red obstacle boundary
    const info = byId('-I-VISTULA').options;
    expect(info.fillColor).toBe('#0277bd'); // information only: blue, distinct from technical yellow
    expect(info.dashArray).toBeTruthy(); // not an obstacle
    expect(byId('-X-INCOMPLETE').options.fillColor).toBe('#757575');
    expect(byId('-RH-SCHOOL').options.dashArray).toBe('4 6'); // inactive at this altitude
  });

  it('popups show name, DRA category, status, altitude, source and  label', async () => {
    await set('zones', ZONES.zones);
    const html = byId('-P-SEJM').getPopup()!.getContent() as string;
    expect(html).toContain(' prohibited area: Sejm / Wiejska');
    expect(html).toContain('DRA-P');
    expect(html).toContain('Blocked: prohibited for the planned operation');
    expect(html).toContain('0 m – 300 m AGL');
    expect(html).toContain('Synthetic test fixture');
    expect(html).toContain('not an official geographical zone');
    const circle = byId('-RH-SCHOOL').getPopup()!.getContent() as string;
    expect(circle).toContain('100 m radius');
    const unknown = byId('-X-INCOMPLETE').getPopup()!.getContent() as string;
    expect(unknown).toContain('unknown floor');
  });

  it('popups show the zone identifier, validity, authorization and the dataset update', async () => {
    await set('airspaceSource', ZONES.source);
    await set('zones', ZONES.zones);
    const html = byId('-P-SEJM').getPopup()!.getContent() as string;
    expect(html).toContain('<dt>Zone ID</dt><dd>-P-SEJM</dd>');
    expect(html).toContain('Permanent / not specified');
    expect(html).toContain('<dt>Authorization</dt><dd>required</dd>');
    expect(html).toContain('dataset vv1, loaded 2026-10-17 12:00 UTC');
  });

  it('renders zones across the whole city, including MultiPolygons with holes', async () => {
    await set('zones', CITYWIDE_ZONES);
    expect(zoneLayers().map((l) => l.feature.properties.id).sort()).toEqual(
      ['TEST-P-NORTH', 'TEST-R-WEST', 'TEST-RM-SOUTH', 'TEST-U-EAST'],
    );
    const lats = zoneLayers().map((l) => l.getBounds().getCenter().lat);
    expect(Math.max(...lats) - Math.min(...lats)).toBeGreaterThan(0.1); // north to south, ~17 km
    const west = byId('TEST-R-WEST').getLatLngs() as L.LatLng[][][];
    expect(west.length).toBe(2); // two parts
    expect(west[0].length).toBe(2); // outer ring + hole
    expect(west[0][0][0].lng).toBeCloseTo(20.9); // GeoJSON [lon, lat] -> LatLng(lat, lon)
    expect(west[0][0][0].lat).toBeCloseTo(52.23);
  });

  it('keeps every zone when the map is zoomed or panned', async () => {
    await set('zones', CITYWIDE_ZONES);
    const http = TestBed.inject(HttpTestingController);
    leaflet().fire('zoomend');
    leaflet().fire('moveend');
    expect(zoneLayers().length).toBe(CITYWIDE_ZONES.length);
    expect(http.match((r) => r.url.includes('/zones')).length).toBe(0); // zones are not fetched per viewport
  });

  it('draws the route and markers above the zone polygons', async () => {
    await set('zones', ZONES.zones);
    await set('start', CENTRALNA);
    const z = (pane: string) => Number(leaflet().getPane(pane)!.style.zIndex || getComputedStyle(leaflet().getPane(pane)!).zIndex);
    expect(z('routePane')).toBeGreaterThan(400); // zones are in the overlay pane (z-index 400)
    const zonePane = (byId('-P-SEJM').options as L.PathOptions & { pane: string }).pane;
    expect(zonePane).toBe('overlayPane');
    expect(el.querySelector('.leaflet-marker-pane .route-pin-start')).not.toBeNull(); // marker pane (600)
  });

  it('draws the simulated drone above all layers, rotated to its heading, with trails and the return route', async () => {
    const frame = {
      lat: 52.23, lng: 21.01, heading: 135, follow: false,
      trails: [[[52.229, 21.003], [52.23, 21.01]]] as [number, number][][],
      returnPath: [[52.241, 21.028], [52.235, 21.02], [52.229, 21.003]] as [number, number][],
    };
    await set('simulation', frame);
    const drone = el.querySelector<HTMLElement>('[data-testid="sim-drone"]')!;
    expect(drone).not.toBeNull();
    expect(drone.closest('.leaflet-drone-pane')).not.toBeNull();
    expect(drone.style.transform).toBe('rotate(135.0deg)');
    expect(el.querySelector('path.sim-trail')).not.toBeNull();
    expect(el.querySelector('path.sim-return')).not.toBeNull();
    await set('simulation', { ...frame, lat: 52.231, heading: 90 });
    expect(el.querySelectorAll('[data-testid="sim-drone"]').length).toBe(1); // moved, not duplicated
    expect(el.querySelector<HTMLElement>('[data-testid="sim-drone"]')!.style.transform).toBe('rotate(90.0deg)');
    await set('simulation', null);
    expect(el.querySelector('[data-testid="sim-drone"]')).toBeNull();
    expect(el.querySelector('path.sim-trail')).toBeNull();
  });

  it('only draws the zones it is given (category filters)', async () => {
    await set('zones', ZONES.zones.filter((z) => z.draCategory !== 'DRA-P'));
    expect(zoneLayers().some((l) => l.feature.properties.id === '-P-SEJM')).toBe(false);
  });

  it('highlights the zone that blocks a selected point', async () => {
    await set('zones', ZONES.zones);
    await set('highlightZoneIds', ['-P-SEJM']);
    expect(byId('-P-SEJM').options.weight).toBe(5);
  });

  it('shows no airspace banner on the map (source details live in the Airspace Legend)', async () => {
    await set('airspaceSource', ZONES.source);
    expect(el.querySelector('.airspace-banner')).toBeNull();
    expect(el.querySelector('.leaflet-control-layers')).toBeNull(); // replaced by the Layers panel
    expect(el.querySelector('.map-legend')).toBeNull();
  });

  it('layer visibility follows the Layers store and never removes data', async () => {
    const layers = TestBed.inject(MapLayerStore);
    const map = fixture.componentInstance as unknown as { visibleLayerKeys(): string[] };
    await set('zones', ZONES.zones);
    expect(map.visibleLayerKeys()).toContain('airspaceZones');
    layers.set('airspaceZones', false);
    fixture.detectChanges();
    expect(map.visibleLayerKeys()).not.toContain('airspaceZones');
    expect(zoneLayers().length).toBe(ZONES.zones.length); // still built, just hidden
    layers.set('airspaceZones', true);
    fixture.detectChanges();
    expect(map.visibleLayerKeys()).toContain('airspaceZones');
  });

  it('a click inside a zone picks a point while picking is armed', async () => {
    await set('zones', ZONES.zones);
    await set('picking', true);
    const clicks: Coordinate[] = [];
    fixture.componentInstance.mapClick.subscribe((c) => clicks.push(c));
    byId('-P-SEJM').fire('click', { latlng: L.latLng(52.225, 21.026) });
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
    expect(el.querySelectorAll('.district-label').length).toBe(BOUNDARY.districts.features.length); // on by default
    TestBed.inject(MapLayerStore).set('districts', false);
    fixture.detectChanges();
    expect(el.querySelectorAll('.district-label').length).toBe(0);
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
    map.setView([52.2297, 21.0122], BUILDING_MIN_ZOOM + 1);
    map.fire('moveend');
    http.expectNone((r) => r.url.includes('/map/buildings/')); // layer off by default: nothing is downloaded
    map.setView([52.2297, 21.0122], 12);
    TestBed.inject(MapLayerStore).set('buildings', true);
    fixture.detectChanges();
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
