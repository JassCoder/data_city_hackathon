import {
  Component,
  ElementRef,
  OnDestroy,
  ViewEncapsulation,
  inject,
  afterNextRender,
  effect,
  input,
  output,
  viewChild,
} from '@angular/core';
import * as L from 'leaflet';
import { HttpClient } from '@angular/common/http';
import type { FeatureCollection } from 'geojson';
import { API_BASE_URL } from '../core/api';
import { SETTINGS } from '../core/settings';
import { BoundaryResponse, FALLBACK_VIEW } from '../core/map-data';
import { AirspaceSource, AirspaceZone, SOURCE_LABEL, STATUS_LABEL } from '../core/airspace';
import { BuildingProps, CorridorProps, Layers, StationProps, StationType, TALL_BUILDING_M } from '../core/layers';
import { DEFAULT_LAYERS, LayerKey } from '../core/map-layers';
import { Crossing, Drone, shownResponse } from '../core/fleet';
import { Coordinate, PointRole, SelectedLocation } from '../core/models';
import { iconSvg } from '../ui/icon';
import {
  MAP_COLORS,
  ZONE_KINDS,
  ZoneKind,
  zoneGlyphSvg,
  zoneKind,
  zonePathStyle,
  zonePatternDefs,
  zoneTickStyle,
} from './map-style';

/** All footprints are loaded as z14 tiles once the map is zoomed in this far. */
export const BUILDING_TILE_ZOOM = 14;
export const BUILDING_MIN_ZOOM = 15;
const MAX_TILES_IN_VIEW = 30;

/** z14 web-mercator tiles covering a lon/lat box. */
export function tilesFor(west: number, south: number, east: number, north: number, z = BUILDING_TILE_ZOOM): [number, number][] {
  const n = 2 ** z;
  const tx = (lon: number) => Math.floor(((lon + 180) / 360) * n);
  const ty = (lat: number) => {
    const r = (lat * Math.PI) / 180;
    return Math.floor(((1 - Math.asinh(Math.tan(r)) / Math.PI) / 2) * n);
  };
  const out: [number, number][] = [];
  for (let x = tx(west); x <= tx(east); x++) for (let y = ty(north); y <= ty(south); y++) out.push([x, y]);
  return out;
}

export interface MarkerDrag {
  droneId: string;
  role: PointRole;
  coordinate: Coordinate;
}

export function esc(v: unknown): string {
  return String(v ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/**
 * Leaflet 1.9's canvas renderer can run an animation-frame redraw queued while
 * layers were being removed after its 2D context is gone (e.g. on map
 * teardown); skip such redraws instead of throwing.
 */
function guardedCanvas(): L.Renderer {
  const c = L.canvas({ padding: 0.5 }) as L.Renderer & { _redraw: () => void; _ctx?: unknown };
  const redraw = c._redraw;
  c._redraw = function (this: typeof c) {
    if (this._ctx) redraw.call(this);
  };
  return c;
}

const HEIGHT_SOURCE_LABEL: Record<BuildingProps['height_source'], string> = {
  osm_height: 'OSM height tag',
  levels_x3: 'levels × 3 m',
  default_15m: 'unknown, default 15 m (estimated)',
};

/** Station glyphs (filled, white on the station colour). */
const STATION_GLYPH: Record<StationType, string> = {
  HOSPITAL: 'M10 5h4v5h5v4h-5v5h-4v-5H5v-4h5z',
  ROOFTOP: 'M5 20V10l7-5 7 5v10h-5v-5h-4v5z',
  PARK: 'M12 3l6 8h-3.5l4 6H13v4h-2v-4H5.5l4-6H6z',
  DEPOT: 'M4 8l8-4 8 4v9l-8 4-8-4zM12 12v9M4 8l8 4 8-4',
};

const STATION_LABEL: Record<StationType, string> = {
  HOSPITAL: 'Hospital pad',
  ROOFTOP: 'Rooftop pad',
  PARK: 'Park pad',
  DEPOT: 'Depot',
};

function altitudeBand(z: AirspaceZone): string {
  const alt = (v: number | null, unknown: string) => (v === null ? unknown : `${v} m`);
  return `${alt(z.lowerAltitude, 'unknown floor')} – ${alt(z.upperAltitude, 'unknown ceiling')} ${z.altitudeReference}`;
}

function validityText(z: AirspaceZone): string {
  if (!z.validityStart && !z.validityEnd) return 'Permanent or not specified';
  const fmt = new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' });
  const d = (v: string | null) => (v ? fmt.format(new Date(v)) : '…');
  return `${d(z.validityStart)} to ${d(z.validityEnd)} UTC`;
}

/** Popup: what the zone means for the selected flight first, details on demand. */
export function zonePopupHtml(z: AirspaceZone, flightLabel: string): string {
  const kind = zoneKind(z.evaluation);
  const k = ZONE_KINDS[kind];
  const e = z.evaluation;
  const demo = z.sourceType === 'DEMO' ? '<span class="badge badge-demo">Demo, not official</span>' : '';
  const reasons = e.reasons.length ? `<ul class="reasons">${e.reasons.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>` : '';
  return `
    <div class="zone-popup" data-zone-id="${esc(z.id)}" data-kind="${kind}">
      <div class="zp-head">${zoneGlyphSvg(kind, 20)}<div><div class="zp-title">${esc(z.name)}</div>
        <div class="zp-meta"><span class="zp-cat">${esc(z.draCategory)}</span> ${demo}</div></div></div>
      <div class="zp-meaning zp-${kind}"><b>For ${esc(flightLabel)}:</b> ${esc(k.meaning)}</div>
      <dl>
        <dt>Altitude</dt><dd>${esc(altitudeBand(z))}</dd>
        <dt>Valid</dt><dd>${esc(validityText(z))}</dd>
      </dl>
      <details><summary>Details</summary>
        <p class="zp-status">${esc(STATUS_LABEL[e.status])}</p>
        ${reasons}
        <dl>
          <dt>Restriction</dt><dd>${esc(z.restrictionType)}</dd>
          <dt>Authorization</dt><dd>${z.authorizationRequired === null ? 'unknown' : z.authorizationRequired ? 'required' : 'not required'}</dd>
          ${z.operationalConditions ? `<dt>Conditions</dt><dd>${esc(z.operationalConditions)}</dd>` : ''}
          ${z.circle ? `<dt>Circle</dt><dd>${z.circle.radiusM} m radius around ${z.circle.center[1].toFixed(5)}, ${z.circle.center[0].toFixed(5)}</dd>` : ''}
          <dt>Source</dt><dd>${esc(z.source ?? 'unknown')} (${esc(SOURCE_LABEL[z.sourceType])})</dd>
          <dt>Verification</dt><dd>${esc(z.verificationStatus)}</dd>
        </dl>
      </details>
    </div>`;
}

@Component({
  selector: 'app-map',
  template: `
    <div #mapEl class="map"></div>
    <div #topRight class="map-overlay-host" data-overlay="top-right"><ng-content select="[mapTopRight]" /></div>
    <div #bottomRight class="map-overlay-host" data-overlay="bottom-right"><ng-content select="[mapBottomRight]" /></div>
  `,
  // Leaflet builds its own DOM (icons, popups): its styles are global (src/styles/map.scss).
  encapsulation: ViewEncapsulation.None,
})
export class MapComponent implements OnDestroy {
  readonly layers = input<Layers | undefined>();
  /** Every drone; hidden ones are not drawn. */
  readonly drones = input<Drone[]>([]);
  readonly selectedId = input<string | null>(null);
  readonly crossings = input<Map<string, Crossing[]>>(new Map());
  /** One-shot "fit this drone" request (list action "Show on map"). */
  readonly focusRequest = input<{ droneId: string; nonce: number } | null>(null);
  /** True while a pick target is armed (crosshair cursor; clicks inside zones pick too). */
  readonly picking = input(false);
  /** Evaluated airspace zones to draw (already filtered for display). */
  readonly zones = input<AirspaceZone[]>([]);
  readonly airspaceSource = input<AirspaceSource | undefined>();
  readonly highlightZoneIds = input<string[]>([]);
  readonly focusZoneId = input<string | null>(null);
  /** Official Warsaw boundary + districts (undefined while loading). */
  readonly boundary = input<BoundaryResponse | undefined>();
  /** Which display layers are on (Layers panel). */
  readonly layerVisibility = input<Record<LayerKey, boolean>>(DEFAULT_LAYERS);
  /** Whose evaluation the zones show, used in zone popups. */
  readonly flightLabel = input('the planned flight');
  readonly mapClick = output<Coordinate>();
  readonly markerDrag = output<MarkerDrag>();
  readonly routeClick = output<string>();
  readonly focusDone = output<void>();

  private readonly mapEl = viewChild.required<ElementRef<HTMLDivElement>>('mapEl');
  private readonly topRight = viewChild.required<ElementRef<HTMLDivElement>>('topRight');
  private readonly bottomRight = viewChild.required<ElementRef<HTMLDivElement>>('bottomRight');
  private map?: L.Map;
  private canvas?: L.Renderer;
  private zoneRenderer?: L.Renderer;
  private zoneLayer?: L.GeoJSON;
  private zoneDecor?: L.LayerGroup;
  private readonly keyed: Partial<Record<LayerKey, L.Layer>> = {};
  private corridorLayers: L.GeoJSON[] = [];
  /** Point markers by `${droneId}:${role}`. */
  private readonly markers = new Map<string, L.Marker>();
  private routeLayer?: L.LayerGroup;
  private routeRenderer?: L.Renderer;
  private lastFitted?: unknown;
  private lastFocusNonce = 0;
  /** Last automatic fit; re-applied when the map resizes (e.g. the drawer opens) until the user moves the map. */
  private lastFit?: L.LatLngBounds;
  private keepFit = false;
  private readonly http = inject(HttpClient, { optional: true });
  private cityBounds?: L.LatLngBounds;
  private fittedCity = false;
  private tallLayer?: L.GeoJSON;
  /** Building footprint tiles (z14): loaded once, shown only at street zoom. */
  private tileGroup?: L.LayerGroup;
  private readonly tiles = new Map<string, L.GeoJSON>();
  private readonly pendingTiles = new Set<string>();
  private resizeObserver?: ResizeObserver;
  private defs?: SVGSVGElement;

  constructor() {
    afterNextRender(() => {
      const host = this.mapEl().nativeElement;
      // Starts on an approximate view; fits the official boundary once it loads.
      this.map = L.map(host, { zoomControl: true }).setView(FALLBACK_VIEW.center, FALLBACK_VIEW.zoom);
      L.tileLayer(SETTINGS.tileUrl, { maxZoom: 19, attribution: SETTINGS.tileAttribution }).addTo(this.map);
      this.installPatternDefs();
      // Corner controls: Leaflet stacks controls inside a corner, so overlays never overlap.
      this.showWarsawControl().addTo(this.map);
      this.hostControl(this.topRight().nativeElement, 'topright').addTo(this.map);
      this.hostControl(this.bottomRight().nativeElement, 'bottomright').addTo(this.map);

      // One canvas for corridors and buildings (thousands of polygons).
      this.canvas = guardedCanvas();
      // Zones: SVG (fill patterns) in their own pane above the canvas, below routes and markers.
      this.map.createPane('zonePane').style.zIndex = '420';
      this.zoneRenderer = L.svg({ pane: 'zonePane' });
      this.zoneDecor = L.layerGroup();
      this.zoneLayer = L.geoJSON(undefined, {
        // GeoJSON forwards `renderer` to each path at runtime; the typings omit it.
        ...({ renderer: this.zoneRenderer } as L.PathOptions),
        bubblingMouseEvents: false,
        style: (f) => zonePathStyle(f?.properties.kind, f?.properties.highlighted),
        onEachFeature: (f, l) => {
          const z = f.properties.zone as AirspaceZone;
          l.bindTooltip(`<b>${esc(z.name)}</b><br>${esc(ZONE_KINDS[f.properties.kind as ZoneKind].label)}`, {
            sticky: true,
            className: 'zone-tooltip',
          });
          l.bindPopup(() => zonePopupHtml(z, this.flightLabel()), { maxWidth: 300, className: 'zone-popup-wrap' });
          l.on('popupopen', () => l.closeTooltip());
          // While a point is being picked, clicks inside zones pick the point instead.
          l.on('click', (e: L.LeafletMouseEvent) => {
            if (this.picking()) {
              l.closePopup();
              this.mapClick.emit({ latitude: e.latlng.lat, longitude: e.latlng.lng });
            }
          });
        },
      });
      this.keyed.zones = L.layerGroup([this.zoneLayer, this.zoneDecor]);
      this.tileGroup = L.layerGroup();
      this.keyed.buildings = this.tileGroup;
      this.map.on('moveend', () => this.syncBuildingTiles());
      if (typeof ResizeObserver !== 'undefined') {
        this.resizeObserver = new ResizeObserver(() => {
          const map = this.map;
          if (!map) return;
          // invalidateSize() would pan by half the size change (animated) and undo a re-fit.
          const refit = this.keepFit && !!this.lastFit;
          map.invalidateSize(refit ? { pan: false } : true);
          if (refit && map.getSize().x > 0) map.fitBounds(this.lastFit!, { padding: [48, 48], maxZoom: 16, animate: false });
          // First real layout after a zero-size start: fit the city now.
          if (this.cityBounds && this.map && this.map.getZoom() === FALLBACK_VIEW.zoom && this.fittedCity) this.showEntireWarsaw();
        });
        this.resizeObserver.observe(host);
      }
      // Any direct interaction with the map ends the automatic fit.
      for (const type of ['pointerdown', 'wheel', 'keydown'] as const) {
        host.addEventListener(type, () => (this.keepFit = false), { passive: true });
      }
      this.map.on('click', (e: L.LeafletMouseEvent) =>
        this.mapClick.emit({ latitude: e.latlng.lat, longitude: e.latlng.lng }),
      );
      // Route above all data layers, below markers.
      this.map.createPane('routePane').style.zIndex = '450';
      this.routeRenderer = L.svg({ pane: 'routePane' });
      this.routeLayer = L.layerGroup().addTo(this.map);
      this.render(this.layers());
      this.syncDrones(this.drones(), this.selectedId(), this.crossings());
      this.syncZones(this.zones(), this.highlightZoneIds());
      this.syncSource(this.airspaceSource());
      this.syncBoundary(this.boundary());
      this.applyVisibility(this.layerVisibility());
    });

    effect(() => this.render(this.layers()));
    effect(() => this.syncDrones(this.drones(), this.selectedId(), this.crossings()));
    effect(() => this.focusDrone(this.focusRequest()));
    effect(() => this.mapEl().nativeElement.classList.toggle('picking', this.picking()));
    effect(() => this.syncZones(this.zones(), this.highlightZoneIds()));
    effect(() => this.syncSource(this.airspaceSource()));
    effect(() => this.focus(this.focusZoneId()));
    effect(() => this.syncBoundary(this.boundary()));
    effect(() => this.applyVisibility(this.layerVisibility()));
  }

  // --- controls -------------------------------------------------------------------

  /** Turns an Angular-rendered element into a Leaflet corner control (Angular keeps its bindings). */
  private hostControl(el: HTMLElement, position: L.ControlPosition): L.Control {
    const c = new L.Control({ position });
    c.onAdd = () => {
      el.classList.add('leaflet-control');
      L.DomEvent.disableClickPropagation(el);
      L.DomEvent.disableScrollPropagation(el);
      return el;
    };
    return c;
  }

  private showWarsawControl(): L.Control {
    const c = new L.Control({ position: 'topleft' });
    c.onAdd = () => {
      const bar = L.DomUtil.create('div', 'leaflet-bar show-warsaw');
      const btn = L.DomUtil.create('button', 'show-warsaw-btn', bar) as HTMLButtonElement;
      btn.type = 'button';
      btn.title = 'Show entire Warsaw';
      btn.setAttribute('aria-label', 'Show entire Warsaw');
      btn.setAttribute('data-testid', 'show-warsaw');
      btn.innerHTML = iconSvg('expand');
      L.DomEvent.disableClickPropagation(bar);
      L.DomEvent.on(btn, 'click', () => this.showEntireWarsaw());
      return bar;
    };
    return c;
  }

  /** One <defs> with the zone fill patterns, shared by the zone renderer and the legend. */
  private installPatternDefs(): void {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'zone-pattern-defs');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('width', '0');
    svg.setAttribute('height', '0');
    svg.innerHTML = `<defs>${zonePatternDefs()}</defs>`;
    this.mapEl().nativeElement.parentElement?.appendChild(svg);
    this.defs = svg;
  }

  private applyVisibility(v: Record<LayerKey, boolean>): void {
    const map = this.map;
    if (!map) return;
    for (const key of Object.keys(v) as LayerKey[]) {
      const layer = this.keyed[key];
      if (!layer) continue;
      if (v[key] && !map.hasLayer(layer)) layer.addTo(map);
      if (!v[key] && map.hasLayer(layer)) layer.remove();
    }
    this.enforceOrder();
    this.syncBuildingTiles();
  }

  private addKeyed(key: LayerKey, layer: L.Layer): void {
    this.keyed[key]?.remove();
    this.keyed[key] = layer;
    if (this.map && this.layerVisibility()[key]) layer.addTo(this.map);
  }

  // --- city boundary ------------------------------------------------------------

  private syncBoundary(boundary: BoundaryResponse | undefined): void {
    const map = this.map;
    if (!map || !boundary || this.keyed.city) return;
    this.addKeyed(
      'districts',
      L.geoJSON(boundary.districts, {
        style: { color: MAP_COLORS.district, weight: 1.2, opacity: 0.8, fill: false },
        interactive: false,
        onEachFeature: (f, l) =>
          l.bindTooltip(String(f.properties.name), { permanent: true, direction: 'center', className: 'district-label' }),
      }),
    );
    const city = L.geoJSON(boundary.city, {
      style: { color: MAP_COLORS.city, weight: 2.5, opacity: 0.9, fill: false },
      interactive: false,
    });
    this.addKeyed('city', city);
    this.cityBounds = city.getBounds();
    if (!this.fittedCity) {
      this.fittedCity = true;
      this.showEntireWarsaw();
    }
  }

  /** Fits the whole official city boundary in the map (with padding). */
  showEntireWarsaw(): void {
    if (!this.map) return;
    // A zero-size container (hidden tab, not laid out yet) would make fitBounds
    // jump to maximum zoom; keep the city view and refit on the next resize.
    const sized = this.map.getSize().x > 0 && this.map.getSize().y > 0;
    if (this.cityBounds?.isValid() && sized) this.map.fitBounds(this.cityBounds, { padding: [24, 24] });
    else this.map.setView(FALLBACK_VIEW.center, FALLBACK_VIEW.zoom);
  }

  // --- building tiles ------------------------------------------------------------

  private buildingStyle = (f?: GeoJSON.Feature): L.PathOptions => {
    const tall = (f?.properties as BuildingProps).height_m >= TALL_BUILDING_M;
    const color = tall ? MAP_COLORS.tallBuilding : MAP_COLORS.building;
    return { color, weight: tall ? 1 : 0.5, fillColor: color, fillOpacity: tall ? 0.85 : 0.45 };
  };

  private buildingTooltip = (f: GeoJSON.Feature, l: L.Layer): void => {
    const p = f.properties as BuildingProps;
    l.bindTooltip(`<b>${p.height_m} m</b><br>${HEIGHT_SOURCE_LABEL[p.height_source]}`, { sticky: true });
  };

  /** Loads/shows z14 footprint tiles in view at street zoom; hides them when zoomed out or switched off. */
  private syncBuildingTiles(): void {
    const map = this.map;
    const group = this.tileGroup;
    if (!map || !group) return;
    if (!this.layerVisibility().buildings || map.getZoom() < BUILDING_MIN_ZOOM || map.getSize().x === 0) {
      group.clearLayers();
      return;
    }
    const b = map.getBounds();
    const wanted = tilesFor(b.getWest(), b.getSouth(), b.getEast(), b.getNorth()).slice(0, MAX_TILES_IN_VIEW);
    const keys = new Set(wanted.map(([x, y]) => `${x}/${y}`));
    for (const layer of group.getLayers()) {
      if (!keys.has((layer as L.GeoJSON & { tileKey?: string }).tileKey ?? '')) group.removeLayer(layer);
    }
    for (const key of keys) {
      const cached = this.tiles.get(key);
      if (cached) {
        if (!group.hasLayer(cached)) group.addLayer(cached);
      } else if (!this.pendingTiles.has(key) && this.http) {
        this.pendingTiles.add(key);
        this.http.get<FeatureCollection>(`${API_BASE_URL}/map/buildings/${BUILDING_TILE_ZOOM}/${key}`).subscribe({
          next: (fc) => {
            this.pendingTiles.delete(key);
            const layer = L.geoJSON(fc, {
              ...({ renderer: this.canvas } as L.PathOptions),
              style: this.buildingStyle,
              onEachFeature: this.buildingTooltip,
            }) as L.GeoJSON & { tileKey?: string };
            layer.tileKey = key;
            this.tiles.set(key, layer);
            if (map.getZoom() >= BUILDING_MIN_ZOOM && this.layerVisibility().buildings) group.addLayer(layer);
            this.enforceOrder();
          },
          error: () => this.pendingTiles.delete(key),
        });
      }
    }
    this.enforceOrder();
  }

  // --- airspace -------------------------------------------------------------

  private syncZones(zones: AirspaceZone[], highlighted: string[]): void {
    const layer = this.zoneLayer;
    const decor = this.zoneDecor;
    if (!layer || !decor) return;
    layer.clearLayers();
    decor.clearLayers();
    layer.addData({
      type: 'FeatureCollection',
      features: zones.map((z) => ({
        type: 'Feature',
        properties: { id: z.id, zone: z, kind: zoneKind(z.evaluation), highlighted: highlighted.includes(z.id) },
        geometry: z.geojsonGeometry,
      })),
    } as GeoJSON.FeatureCollection);
    // Chart-style ticks on borders that must not be crossed, and a glyph per zone.
    layer.eachLayer((l) => {
      const path = l as L.Polygon;
      const kind = path.feature?.properties.kind as ZoneKind;
      if (ZONE_KINDS[kind].border === 'ticked') {
        decor.addLayer(L.polygon(path.getLatLngs() as L.LatLngExpression[][], { renderer: this.zoneRenderer, ...zoneTickStyle(kind) }));
      }
      const glyph = zoneGlyphSvg(kind);
      if (glyph) {
        decor.addLayer(
          L.marker(path.getBounds().getCenter(), {
            icon: L.divIcon({ className: 'zone-glyph', html: glyph, iconSize: [22, 22], iconAnchor: [11, 11] }),
            interactive: false,
            keyboard: false,
          }),
        );
      }
    });
  }

  /** Canvas draw order = hit-test order: corridors at the back, buildings on top. */
  private enforceOrder(): void {
    for (const c of this.corridorLayers) c.bringToBack();
    this.tallLayer?.bringToFront();
    this.tileGroup?.eachLayer((l) => (l as L.GeoJSON).bringToFront());
  }

  private focus(id: string | null): void {
    if (!id || !this.map || !this.zoneLayer) return;
    const target = this.zoneLayer
      .getLayers()
      .find((l) => (l as L.Polygon).feature?.properties.id === id) as L.Polygon | undefined;
    if (target) {
      this.map.fitBounds(target.getBounds(), { padding: [60, 60], maxZoom: 16 });
      target.openPopup();
    }
    this.focusDone.emit();
  }

  /** Where the zone dataset ends: outside it zones are unknown, not "clear". */
  private syncSource(src: AirspaceSource | undefined): void {
    if (!this.map || this.keyed.extent || !src?.extent) return;
    const extent = L.geoJSON(src.extent as GeoJSON.Geometry, {
      style: { color: MAP_COLORS.extent, weight: 2, dashArray: '6 6', fill: false },
      interactive: false,
    });
    extent.bindTooltip(src.extentLabel ?? 'Zone data extent');
    this.addKeyed('extent', extent);
  }

  // --- drones: markers and routes ---------------------------------------------------

  private syncDrones(drones: Drone[], selectedId: string | null, crossings: Map<string, Crossing[]>): void {
    const map = this.map;
    const group = this.routeLayer;
    if (!map || !group) return;
    group.clearLayers();
    const shown = drones.filter((d) => d.visible);
    // Selected drone last, so its line is drawn on top.
    const ordered = [...shown.filter((d) => d.id !== selectedId), ...shown.filter((d) => d.id === selectedId)];
    for (const d of ordered) this.drawRoute(d, d.id === selectedId);
    this.syncMarkers(shown, selectedId);
    this.drawCrossings(crossings, drones);

    const sel = drones.find((d) => d.id === selectedId);
    const r = sel?.route;
    if (r?.phase === 'ready' && r.response.geometry && this.lastFitted !== r.response) {
      this.lastFitted = r.response;
      this.fit(r.response.geometry.coordinates.map(([lon, lat]) => L.latLng(lat, lon)));
    }
  }

  private drawRoute(d: Drone, selected: boolean): void {
    const group = this.routeLayer!;
    const response = shownResponse(d);
    if (!response?.geometry) return;
    const fresh = d.route.phase === 'ready';
    const color = fresh ? d.color : MAP_COLORS.routeStale;
    const latlngs = response.geometry.coordinates.map(([lon, lat]) => L.latLng(lat, lon));
    const weight = selected ? 6 : 4;
    // Halo for contrast on the busy basemap.
    group.addLayer(
      L.polyline(latlngs, { renderer: this.routeRenderer, color: MAP_COLORS.halo, weight: weight + 4, opacity: fresh ? 0.85 : 0.35, interactive: false }),
    );
    const line = L.polyline(latlngs, {
      renderer: this.routeRenderer,
      color,
      weight,
      opacity: fresh ? (selected ? 1 : 0.85) : 0.7,
      dashArray: fresh ? undefined : '8 8',
      className: `route-line route-${fresh ? 'ready' : 'stale'} route-${response.mode.toLowerCase()}`,
      bubblingMouseEvents: false,
    });
    line.bindTooltip(`<b>${esc(d.name)}</b>${fresh ? '' : ' (outdated)'}`, { sticky: true });
    line.on('click', (e: L.LeafletMouseEvent) => {
      if (this.picking()) this.mapClick.emit({ latitude: e.latlng.lat, longitude: e.latlng.lng });
      else this.routeClick.emit(d.id);
    });
    group.addLayer(line);
    // Snapped endpoints: dotted link from the chosen point to where the route starts.
    const link = (from: SelectedLocation | null, to: Coordinate | null) => {
      if (!from || !to) return;
      const a = L.latLng(from.coordinate.latitude, from.coordinate.longitude);
      const b = L.latLng(to.latitude, to.longitude);
      if (a.distanceTo(b) > 2) {
        group.addLayer(L.polyline([a, b], { renderer: this.routeRenderer, color, weight: 2, dashArray: '2 6', interactive: false }));
      }
    };
    link(d.start, response.routeStart);
    link(d.destination, response.routeDestination);
  }

  private syncMarkers(drones: Drone[], selectedId: string | null): void {
    const map = this.map!;
    const wanted = new Set<string>();
    for (const d of drones) {
      for (const role of ['start', 'destination'] as const) {
        const loc = d[role];
        if (!loc) continue;
        const key = `${d.id}:${role}`;
        wanted.add(key);
        const latlng = L.latLng(loc.coordinate.latitude, loc.coordinate.longitude);
        const letter = role === 'start' ? 'A' : 'B';
        const selected = d.id === selectedId;
        const icon = L.divIcon({
          className: '',
          html: `<div class="route-pin${selected ? ' selected' : ''}" style="--drone:${d.color}"><span>${letter}</span></div>`,
          iconSize: [28, 28],
          iconAnchor: [14, 28],
        });
        const tooltip = `<b>${esc(d.name)} · Point ${letter}</b><br>${esc(loc.label)}<br><span class="muted">Drag to move</span>`;
        let m = this.markers.get(key);
        if (!m) {
          m = L.marker(latlng, { icon, draggable: true, keyboard: false, autoPan: true, zIndexOffset: selected ? 1200 : 1000 })
            .bindTooltip(tooltip, { direction: 'top', offset: [0, -26] })
            .addTo(map);
          m.on('dragend', () => {
            const p = m!.getLatLng();
            this.markerDrag.emit({ droneId: d.id, role, coordinate: { latitude: p.lat, longitude: p.lng } });
            // Rejected points (outside Warsaw) snap back to the stored position.
            setTimeout(() => this.syncMarkers(this.drones().filter((x) => x.visible), this.selectedId()));
          });
          this.markers.set(key, m);
          // Typed or searched points may be off-screen: pan there, keeping the zoom.
          if (loc.source !== 'MAP_CLICK' && loc.source !== 'MAP_DRAG' && loc.source !== 'DEMO' && !map.getBounds().contains(latlng)) {
            map.panTo(latlng);
          }
        } else {
          if (!m.getLatLng().equals(latlng)) m.setLatLng(latlng);
          m.setIcon(icon).setTooltipContent(tooltip).setZIndexOffset(selected ? 1200 : 1000);
        }
      }
    }
    for (const [key, m] of this.markers) {
      if (!wanted.has(key)) {
        m.remove();
        this.markers.delete(key);
      }
    }
  }

  private drawCrossings(crossings: Map<string, Crossing[]>, drones: Drone[]): void {
    const seen = new Set<string>();
    for (const [id, list] of crossings) {
      for (const c of list) {
        const pair = [id, c.otherId].sort().join('|');
        if (seen.has(pair)) continue;
        seen.add(pair);
        const a = drones.find((d) => d.id === id)?.name ?? '';
        this.routeLayer!.addLayer(
          L.marker([c.point.latitude, c.point.longitude], {
            icon: L.divIcon({ className: 'crossing-marker', html: iconSvg('alert'), iconSize: [22, 22], iconAnchor: [11, 11] }),
            keyboard: false,
            zIndexOffset: 900,
          }).bindTooltip(`${esc(a)} and ${esc(c.otherName)} cross at a similar altitude`),
        );
      }
    }
  }

  private focusDrone(req: { droneId: string; nonce: number } | null): void {
    if (!req || !this.map || req.nonce === this.lastFocusNonce) return;
    this.lastFocusNonce = req.nonce;
    const d = this.drones().find((x) => x.id === req.droneId);
    if (!d) return;
    const coords = shownResponse(d)?.geometry?.coordinates.map(([lon, lat]) => L.latLng(lat, lon)) ?? [];
    const points = [d.start, d.destination].filter((p): p is SelectedLocation => !!p).map((p) => L.latLng(p.coordinate.latitude, p.coordinate.longitude));
    this.fit([...coords, ...points]);
  }

  private fit(latlngs: L.LatLng[]): void {
    const map = this.map;
    if (!map || !latlngs.length || map.getSize().x === 0) return;
    if (latlngs.length === 1) {
      map.setView(latlngs[0], Math.max(map.getZoom(), 15));
      return;
    }
    this.lastFit = L.latLngBounds(latlngs);
    this.keepFit = true;
    // Not animated: a running zoom animation would overwrite the re-fit done when the drawer resizes the map.
    map.fitBounds(this.lastFit, { padding: [48, 48], maxZoom: 16, animate: false });
  }

  ngOnDestroy(): void {
    this.resizeObserver?.disconnect();
    this.defs?.remove();
    this.map?.remove();
  }

  // --- static data layers ---------------------------------------------------------

  private render(layers: Layers | undefined): void {
    const map = this.map;
    if (!map || !layers) return;

    // Thousands of building/park polygons share one canvas; canvas hit-testing picks
    // the topmost shape, so buildings are drawn last (tooltips work in the gaps).
    const onCanvas: L.PathOptions = { renderer: this.canvas };

    const corridors = (type: CorridorProps['corridor_type'], color: string, opacity: number) =>
      L.geoJSON(layers.corridors, {
        ...onCanvas,
        filter: (f) => f.properties.corridor_type === type,
        style: { color, weight: 0, fillColor: color, fillOpacity: opacity },
        onEachFeature: (f, l) => {
          const p = f.properties as CorridorProps;
          if (p.name) l.bindTooltip(esc(p.name), { sticky: true });
        },
      });

    // Citywide overview: buildings >= 50 m are always available; all footprints come as tiles.
    const tall = L.geoJSON(layers.tallBuildings, { ...onCanvas, style: this.buildingStyle, onEachFeature: this.buildingTooltip });
    const stations = L.geoJSON(layers.stations, {
      pointToLayer: (f, latlng) =>
        L.marker(latlng, {
          icon: this.stationIcon((f.properties as StationProps).station_type),
          alt: (f.properties as StationProps).name,
        }),
      onEachFeature: (f, l) => l.bindPopup(this.stationPopup(f.properties as StationProps)),
    });

    const river = corridors('RIVER', MAP_COLORS.river, 0.35);
    const parks = corridors('PARK', MAP_COLORS.park, 0.3);
    this.corridorLayers = [parks, river];
    this.tallLayer = tall;
    this.addKeyed('river', river);
    this.addKeyed('parks', parks);
    this.addKeyed('tallBuildings', tall);
    this.addKeyed('stations', stations);
    this.enforceOrder();
  }

  private stationIcon(type: StationType): L.DivIcon {
    return L.divIcon({
      className: '',
      html: `<div class="station-icon station-${type.toLowerCase()}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="${STATION_GLYPH[type]}"/></svg></div>`,
      iconSize: [26, 26],
      iconAnchor: [13, 13],
      popupAnchor: [0, -14],
    });
  }

  private stationPopup(p: StationProps): string {
    return `
      <div class="station-popup">
        <div class="title">${esc(p.name)}</div>
        <div>${STATION_LABEL[p.station_type]}</div>
        <div>Status: <span class="status status-${p.status.toLowerCase()}">${esc(p.status)}</span></div>
        <div>Capacity: ${p.capacity} drone${p.capacity === 1 ? '' : 's'}</div>
        <span class="badge badge-demo">Demo data</span>
      </div>`;
  }
}
