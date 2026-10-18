import { TestBed, ComponentFixture } from '@angular/core/testing';
import * as L from 'leaflet';
import { BOUNDARY, CENTRALNA, KOPERNIK, ZONES, routeResponse } from '../../testing/fixtures';
import { Crossing, Drone, createDrone, toRouteRequest, updateDrone } from '../core/fleet';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { stubCanvas } from '../../testing/canvas-stub';
import { AirspaceZone } from '../core/airspace';
import { BUILDING_MIN_ZOOM, MapComponent, MarkerDrag, tilesFor } from './map';
import { DEFAULT_LAYERS } from '../core/map-layers';
import { Coordinate } from '../core/models';

function drone(id: string, over: Partial<Drone> = {}, others: Drone[] = []): Drone {
  return { ...createDrone(others, id, { altitude: 80, profileId: 'DEMO_DRONE_01' }), start: CENTRALNA, destination: KOPERNIK, ...over };
}

function ready(d: Drone, over: Parameters<typeof routeResponse>[1] = {}): Drone {
  const request = toRouteRequest(d, 'DEMO')!;
  return { ...d, route: { phase: 'ready', response: routeResponse(request, over), request } };
}

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

  const markers = () =>
    Object.values((leaflet() as unknown as { _layers: Record<string, L.Layer> })._layers).filter(
      (l) => l instanceof L.Marker && (l.options.icon as L.DivIcon).options.html?.toString().includes('route-pin'),
    ) as L.Marker[];

  it('shows A/B markers per drone in the drone colour, and moves and removes them', async () => {
    const a = drone('a');
    const b = drone('b', { start: KOPERNIK, destination: CENTRALNA }, [a]);
    await set('drones', [a, b]);
    expect(markers().length).toBe(4);
    expect(el.innerHTML).toContain(`--drone:${a.color}`);
    expect(el.innerHTML).toContain(`--drone:${b.color}`);

    const moved = { ...CENTRALNA, coordinate: { latitude: 52.235, longitude: 21.0385 } };
    await set('drones', [{ ...a, start: moved }, b]);
    expect(markers().some((m) => m.getLatLng().equals(L.latLng(52.235, 21.0385)))).toBe(true);

    await set('drones', [a, { ...b, visible: false }]);
    expect(markers().length).toBe(2); // hidden drones are not drawn
    await set('drones', []);
    expect(markers().length).toBe(0);
  });

  it('markers are draggable and report the drop', async () => {
    await set('drones', [drone('a')]);
    const drags: MarkerDrag[] = [];
    fixture.componentInstance.markerDrag.subscribe((d) => drags.push(d));
    const m = markers()[0];
    expect(m.options.draggable).toBe(true);
    m.setLatLng([52.24, 21.03]).fire('dragend');
    expect(drags).toEqual([{ droneId: 'a', role: 'start', coordinate: { latitude: 52.24, longitude: 21.03 } }]);
  });

  it('draws each ready route in its drone colour; outdated ones grey and dashed', async () => {
    const a = ready(drone('a'));
    const b = ready(drone('b', {}, [a]));
    await set('drones', [a, b]);
    const ready_ = [...el.querySelectorAll<SVGPathElement>('path.route-ready')];
    expect(ready_.map((p) => p.getAttribute('stroke')).sort()).toEqual([a.color, b.color].sort());

    const stale = updateDrone([b], 'b', { altitude: 100 })[0];
    await set('drones', [a, stale]);
    const stalePath = el.querySelector<SVGPathElement>('path.route-stale')!;
    expect(stalePath.getAttribute('stroke-dasharray')).toBe('8 8');
    expect(el.querySelectorAll('path.route-ready').length).toBe(1);
  });

  it('draws the selected route on top and wider', async () => {
    const a = ready(drone('a'));
    const b = ready(drone('b', {}, [a]));
    await set('drones', [a, b]);
    await set('selectedId', 'a');
    const paths = [...el.querySelectorAll<SVGPathElement>('path.route-ready')];
    expect(paths[paths.length - 1].getAttribute('stroke')).toBe(a.color);
    expect(paths[paths.length - 1].getAttribute('stroke-width')).toBe('6');
  });

  it('does not draw a line for a NO_ROUTE result', async () => {
    await set('drones', [ready(drone('a'), { status: 'NO_ROUTE', geometry: null })]);
    expect(el.querySelectorAll('path.route-line').length).toBe(0);
  });

  it('clicking a route selects its drone', async () => {
    await set('drones', [ready(drone('a'))]);
    const clicked: string[] = [];
    fixture.componentInstance.routeClick.subscribe((id) => clicked.push(id));
    const group = (fixture.componentInstance as unknown as { routeLayer: L.LayerGroup }).routeLayer;
    const line = group.getLayers().find((l) => (l as L.Polyline).options.className?.includes('route-ready')) as L.Polyline;
    line.fire('click', { latlng: L.latLng(52.235, 21.015) });
    expect(clicked).toEqual(['a']);
  });

  it('marks where two routes cross at a similar altitude', async () => {
    const crossings = new Map<string, Crossing[]>([
      ['a', [{ otherId: 'b', otherName: 'Drone 2', point: { latitude: 52.235, longitude: 21.015 } }]],
      ['b', [{ otherId: 'a', otherName: 'Drone 1', point: { latitude: 52.235, longitude: 21.015 } }]],
    ]);
    await set('drones', [ready(drone('a')), ready(drone('b'))]);
    await set('crossings', crossings);
    expect(el.querySelectorAll('.crossing-marker').length).toBe(1); // one per pair
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

  it('renders restricted zones without any drone', async () => {
    await set('zones', ZONES.zones);
    expect(zoneLayers().length).toBe(ZONES.zones.length);
    expect(fixture.componentInstance.drones()).toEqual([]);
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

  it('keeps a drone’s markers in place when its mode or optimisation changes', async () => {
    const base = drone('a');
    await set('drones', [base]);
    const before = markers().map((m) => m.getLatLng());
    for (const optimisation of ['FASTEST', 'SAFEST', 'LOWEST_ENERGY'] as const) {
      await set('drones', [ready({ ...base, mode: 'EMERGENCY', optimisation })]);
      expect(markers().map((m) => m.getLatLng())).toEqual(before);
    }
  });
});
