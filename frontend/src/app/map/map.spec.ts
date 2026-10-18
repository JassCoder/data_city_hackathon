import { TestBed, ComponentFixture } from '@angular/core/testing';
import * as L from 'leaflet';
import { RouteState } from '../core/planner.store';
import { BOUNDARY, CENTRALNA, KOPERNIK, ZONES, routeResponse } from '../../testing/fixtures';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { stubCanvas } from '../../testing/canvas-stub';
import { AirspaceZone } from '../core/airspace';
import { BUILDING_MIN_ZOOM, MapComponent, tilesFor } from './map';
import { DEFAULT_LAYERS } from '../core/map-layers';
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

  it('gives every zone kind its own pattern and border, not only a colour', async () => {
    await set('zones', ZONES.zones);
    const sejm = byId('DEMO-P-SEJM').options;
    expect(sejm.fillColor).toBe('url(#zp-prohibited)');
    expect(sejm.dashArray).toBeUndefined();
    expect(byId('DEMO-RM-PKIN').options.fillColor).toBe('url(#zp-conditional)'); // authorization required
    expect(byId('DEMO-X-INCOMPLETE').options.fillColor).toBe('url(#zp-unverified)');
    const info = byId('DEMO-I-VISTULA').options;
    expect(info.fillColor).toBe('transparent'); // information: outline only, may be crossed
    expect(byId('DEMO-RH-SCHOOL').options.dashArray).toBe('5 5'); // inactive at this altitude
    // The shared pattern definitions exist once in the document.
    expect(document.querySelectorAll('#zp-prohibited').length).toBe(1);
  });

  it('adds glyphs for every active kind and chart ticks on borders a route must not cross', async () => {
    await set('zones', ZONES.zones);
    const decor = (fixture.componentInstance as unknown as { zoneDecor: L.LayerGroup }).zoneDecor.getLayers();
    const glyphs = decor.filter((l) => l instanceof L.Marker);
    const ticks = decor.filter((l) => l instanceof L.Polygon);
    const inactive = ZONES.zones.filter((z) => z.evaluation.status.startsWith('NOT_')).length;
    expect(glyphs.length).toBe(ZONES.zones.length - inactive);
    expect(ticks.length).toBe(ZONES.zones.filter((z) => z.evaluation.isObstacle && z.evaluation.status !== 'UNVERIFIED').length);
  });

  const popup = (id: string) => {
    const layer = byId(id);
    return (layer.getPopup()!.getContent() as (l: L.Layer) => string)(layer);
  };

  it('popups say what the zone means for the selected flight, with details on demand', async () => {
    await set('zones', ZONES.zones);
    await set('flightLabel', 'Drone 2 at 80 m AGL');
    const html = popup('DEMO-P-SEJM');
    expect(html).toContain('DEMO prohibited area: Sejm / Wiejska');
    expect(html).toContain('DRA-P');
    expect(html).toContain('For Drone 2 at 80 m AGL:');
    expect(html).toContain('Blocked for this flight');
    expect(html).toContain('0 m – 300 m AGL');
    expect(html).toContain('Demo, not official');
    expect(html).toContain('Blocked: prohibited for the planned operation'); // in Details
    expect(popup('DEMO-RH-SCHOOL')).toContain('100 m radius');
    expect(popup('DEMO-RH-SCHOOL')).toContain('Not active at this altitude or time');
    expect(popup('DEMO-X-INCOMPLETE')).toContain('unknown floor');
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

  it('hides and shows layers from the Layers panel state', async () => {
    await set('zones', ZONES.zones);
    const zones = () => leaflet().hasLayer((fixture.componentInstance as unknown as { zoneLayer: L.Layer }).zoneLayer);
    expect(zones()).toBe(true);
    await set('layerVisibility', { ...DEFAULT_LAYERS, zones: false });
    expect(zones()).toBe(false);
    await set('layerVisibility', { ...DEFAULT_LAYERS });
    expect(zones()).toBe(true);
  });

  it('puts projected overlays into Leaflet corners, so they stack instead of overlapping', () => {
    const hosts = el.querySelectorAll('.map-overlay-host.leaflet-control');
    expect(hosts.length).toBe(2);
    expect(el.querySelector('.leaflet-top.leaflet-right [data-overlay="top-right"]')).not.toBeNull();
    expect(el.querySelector('.leaflet-bottom.leaflet-right [data-overlay="bottom-right"]')).not.toBeNull();
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

  it('starts on the approximate city view until the boundary loads', () => {
    expect(leaflet().getZoom()).toBe(11); // never a blank map, even if the boundary is missing
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
