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
import { BoundaryResponse, FALLBACK_VIEW } from '../core/map-data';
import { Drone, Facility, Hospital, Order, Restaurant } from '../core/fleet';
import { FacilityAction, FleetLayers, FLEET_COLORS } from './fleet-layers';
import { AirspaceSource, AirspaceZone, DisplayClass, SOURCE_LABEL, STATUS_LABEL } from '../core/airspace';
import { BuildingProps, CorridorProps, Layers, StationProps, StationType, TALL_BUILDING_M } from '../core/layers';
import { Coordinate, Entrance, SelectedLocation } from '../core/models';
import { BUILDING_MIN_ZOOM, LayerKey, MapLayerStore } from '../core/map-layers';
import { RouteState } from '../core/planner.store';
import type { SimFrame } from '../core/simulation';

/** All footprints are loaded as z14 tiles once the map is zoomed in this far. */
export const BUILDING_TILE_ZOOM = 14;
export { BUILDING_MIN_ZOOM } from '../core/map-layers';
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

export const COLORS = {
  river: '#1e88e5',
  park: '#43a047',
  building: '#9e9e9e',
  tallBuilding: '#37474f',
  bbox: '#455a64',
  city: '#263238',
  district: '#5c6bc0',
  routeNormal: '#1565c0',
  routeEmergency: '#2e7d32',
  routeStale: '#757575',
  simTrail: '#2e7d32',
  simReturn: '#6a1b9a',
} as const;

/** Airspace legend colours (fill = evaluation class for the planned flight). */
export const ZONE_COLORS: Record<DisplayClass, string> = {
  RED: '#dc2626',
  ORANGE: '#f57c00',
  YELLOW: '#f9a825',
  GRAY: '#757575',
  INACTIVE: '#9e9e9e',
};
const OBSTACLE_OUTLINE = '#b91c1c';
/** Information-only zones (warning, not an obstacle) are blue, distinct from technical (yellow). */
export const INFO_BLUE = '#0277bd';

export function zoneFill(z: AirspaceZone): string {
  const e = z.evaluation;
  return e.displayClass === 'YELLOW' && !e.isObstacle ? INFO_BLUE : ZONE_COLORS[e.displayClass];
}

/** Top-view quadcopter; the nose (arrow) points along the flight heading. */
function droneIcon(): L.DivIcon {
  return L.divIcon({
    className: 'drone-marker',
    iconSize: [40, 40],
    iconAnchor: [20, 20],
    html: `<div class="drone-body" data-testid="sim-drone"><svg viewBox="0 0 40 40" width="40" height="40" aria-label="Simulated drone">
      <g stroke="#263238" stroke-width="2.5" stroke-linecap="round"><line x1="9" y1="9" x2="31" y2="31"/><line x1="31" y1="9" x2="9" y2="31"/></g>
      <g fill="rgba(255,255,255,0.85)" stroke="#263238" stroke-width="1.5">
        <circle cx="9" cy="9" r="6"/><circle cx="31" cy="9" r="6"/><circle cx="9" cy="31" r="6"/><circle cx="31" cy="31" r="6"/></g>
      <rect x="14" y="14" width="12" height="12" rx="3" fill="#1565c0" stroke="#fff" stroke-width="1.5"/>
      <path d="M20 2 L25 10 L15 10 Z" fill="#e53935" stroke="#fff" stroke-width="1"/>
    </svg></div>`,
  });
}

function esc(v: unknown): string {
  return String(v ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** Leaflet path style for a zone: fill by class, solid red outline when it is a routing obstacle. */
export function zoneStyle(z: AirspaceZone, highlighted = false): L.PathOptions {
  const e = z.evaluation;
  const fill = zoneFill(z);
  if (e.displayClass === 'INACTIVE') {
    return { color: '#757575', weight: highlighted ? 4 : 1.5, dashArray: '4 6', fillColor: fill, fillOpacity: 0.06 };
  }
  return {
    color: e.isObstacle ? OBSTACLE_OUTLINE : fill,
    weight: highlighted ? 5 : e.isObstacle ? 2 : 1.5,
    dashArray: e.isObstacle ? undefined : '6 4',
    fillColor: fill,
    fillOpacity: e.displayClass === 'RED' ? 0.3 : 0.28,
  };
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
  unknown: 'no OSM height or levels (unknown; routing uses the configured policy)',
};

const STATION_ICON: Record<StationType, string> = {
  HOSPITAL: 'local_hospital',
  ROOFTOP: 'apartment',
  PARK: 'park',
  DEPOT: 'warehouse',
};

const STATION_LABEL: Record<StationType, string> = {
  HOSPITAL: 'Hospital pad',
  ROOFTOP: 'Rooftop pad',
  PARK: 'Park pad',
  DEPOT: 'Depot',
};

@Component({
  selector: 'app-map',
  template: `<div #mapEl class="map"></div>`,
  // Leaflet builds its own DOM (legend, icons, popups): its styles are global (src/styles/map.scss).
  encapsulation: ViewEncapsulation.None,
})
export class MapComponent implements OnDestroy {
  readonly layers = input<Layers | undefined>();
  readonly start = input<SelectedLocation | null>(null);
  readonly destination = input<SelectedLocation | null>(null);
  readonly route = input<RouteState>({ phase: 'idle' });
  /** Virtual flight frame (drone position, heading, flown trails, return route); null = no simulation. */
  readonly simulation = input<SimFrame | null>(null);
  /** True while a "Pick on map" target is armed (crosshair cursor). */
  readonly picking = input(false);
  /** Evaluated airspace zones to draw (already filtered for display). */
  readonly zones = input<AirspaceZone[]>([]);
  readonly airspaceSource = input<AirspaceSource | undefined>();
  readonly highlightZoneIds = input<string[]>([]);
  readonly focusZoneId = input<string | null>(null);
  /** Official Warsaw boundary + districts (undefined while loading). */
  readonly boundary = input<BoundaryResponse | undefined>();
  /** The boundary could not be loaded: show a labelled fallback view. */
  readonly boundaryMissing = input(false);
  /** Simulated delivery infrastructure (hospitals/restaurants are real OSM records). */
  readonly hospitals = input<Hospital[]>([]);
  readonly depots = input<Facility[]>([]);
  readonly pads = input<Facility[]>([]);
  readonly partners = input<Restaurant[]>([]);
  readonly allRestaurants = input<Restaurant[]>([]);
  readonly drones = input<Drone[]>([]);
  readonly deliveries = input<Order[]>([]);
  readonly facilityAction = output<FacilityAction>();
  /** Mapped entrances offered for the point just searched (choose one to move the point there). */
  readonly entrances = input<Entrance[]>([]);
  readonly entranceSelected = output<Entrance>();
  readonly mapClick = output<Coordinate>();
  readonly focusDone = output<void>();

  private readonly mapEl = viewChild.required<ElementRef<HTMLDivElement>>('mapEl');
  private map?: L.Map;
  /** Map layers by Layers-panel key; visibility comes from MapLayerStore (display only). */
  private readonly layerStore = inject(MapLayerStore);
  private readonly registry = new Map<LayerKey, L.Layer[]>();
  private entranceLayer?: L.LayerGroup;
  private dataLayers: L.Layer[] = [];
  private corridorLayers: L.GeoJSON[] = [];
  private zoneLayer?: L.GeoJSON;
  private canvas?: L.Renderer;
  private readonly markers: Partial<Record<'start' | 'destination', L.Marker>> = {};
  private routeLayer?: L.LayerGroup;
  private routeRenderer?: L.Renderer;
  private simLayer?: L.LayerGroup;
  private simReturn?: L.Polyline;
  private simTrails: L.Polyline[] = [];
  private drone?: L.Marker;
  private lastFitted?: unknown;
  private readonly http = inject(HttpClient, { optional: true });
  private cityLayer?: L.GeoJSON;
  private districtLayer?: L.GeoJSON;
  private cityBounds?: L.LatLngBounds;
  private fittedCity = false;
  private coverageBanner?: HTMLElement;
  private extentLayer?: L.GeoJSON;
  private tallLayer?: L.GeoJSON;
  /** Building footprint tiles (z14): loaded once, shown only at street zoom. */
  private tileGroup?: L.LayerGroup;
  private readonly tiles = new Map<string, L.GeoJSON>();
  private readonly pendingTiles = new Set<string>();
  private resizeObserver?: ResizeObserver;
  private fleet?: FleetLayers;

  constructor() {
    afterNextRender(() => {
      // Starts on an approximate view; fits the official boundary once it loads.
      this.map = L.map(this.mapEl().nativeElement).setView(FALLBACK_VIEW.center, FALLBACK_VIEW.zoom);
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        attribution: '&copy; OpenStreetMap contributors',
      }).addTo(this.map);
      this.showWarsawControl().addTo(this.map);
      this.coverageBannerControl().addTo(this.map);
      // One canvas for corridors, zones and buildings (thousands of polygons).
      this.canvas = guardedCanvas();
      this.zoneLayer = L.geoJSON(undefined, {
        // GeoJSON forwards `renderer` to each path at runtime; the typings omit it.
        ...({ renderer: this.canvas } as L.PathOptions),
        bubblingMouseEvents: false,
        style: (f) => zoneStyle(f?.properties.zone, f?.properties.highlighted),
        onEachFeature: (f, l) => {
          const z = f.properties.zone as AirspaceZone;
          l.bindPopup(this.zonePopup(z), { maxWidth: 320 });
          // While a point is being picked, clicks inside zones pick the point instead.
          l.on('click', (e: L.LeafletMouseEvent) => {
            if (this.picking()) {
              l.closePopup();
              this.mapClick.emit({ latitude: e.latlng.lat, longitude: e.latlng.lng });
            }
          });
        },
      });
      this.register('airspaceZones', this.zoneLayer);
      this.tileGroup = L.layerGroup();
      this.register('buildings', this.tileGroup);
      this.map.on('moveend', () => this.syncBuildingTiles());
      if (typeof ResizeObserver !== 'undefined') {
        this.resizeObserver = new ResizeObserver(() => {
          this.map?.invalidateSize();
          // First real layout after a zero-size start: fit the city now.
          if (this.cityBounds && this.map && this.map.getZoom() === FALLBACK_VIEW.zoom && this.fittedCity) this.showEntireWarsaw();
        });
        this.resizeObserver.observe(this.mapEl().nativeElement);
      }
      this.map.on('click', (e: L.LeafletMouseEvent) =>
        this.mapClick.emit({ latitude: e.latlng.lat, longitude: e.latlng.lng }),
      );
      // Route above all data layers (canvas + SVG in overlayPane), below markers.
      this.map.createPane('routePane').style.zIndex = '450';
      this.routeRenderer = L.svg({ pane: 'routePane' });
      this.routeLayer = L.layerGroup().addTo(this.map);
      // The simulated drone flies above every layer and marker.
      this.map.createPane('dronePane').style.zIndex = '660';
      this.simLayer = L.layerGroup().addTo(this.map);
      this.entranceLayer = L.layerGroup().addTo(this.map);
      this.fleet = new FleetLayers(this.map, (key, layer) => this.register(key, layer),
        (a) => this.facilityAction.emit(a), this.routeRenderer);
      this.syncFleet();
      this.render(this.layers());
      this.syncMarker('start', this.start());
      this.syncMarker('destination', this.destination());
      this.syncRoute(this.route());
      this.syncSimulation(this.simulation());
      this.syncZones(this.zones(), this.highlightZoneIds());
      this.syncSource(this.airspaceSource());
      this.syncBoundary(this.boundary(), this.boundaryMissing());
    });

    effect(() => this.render(this.layers()));
    effect(() => this.syncMarker('start', this.start()));
    effect(() => this.syncMarker('destination', this.destination()));
    effect(() => this.syncRoute(this.route()));
    effect(() => this.syncSimulation(this.simulation()));
    effect(() => this.mapEl().nativeElement.classList.toggle('picking', this.picking()));
    effect(() => this.syncZones(this.zones(), this.highlightZoneIds()));
    effect(() => this.syncSource(this.airspaceSource()));
    effect(() => this.focus(this.focusZoneId()));
    effect(() => this.syncBoundary(this.boundary(), this.boundaryMissing()));
    effect(() => this.syncLayerVisibility(this.layerStore.visible()));
    effect(() => this.syncEntrances(this.entrances()));
    effect(() => {
      const v = this.hospitals(); // read first: the input must be tracked even before the layers exist
      this.fleet?.setHospitals(v);
    });
    effect(() => {
      const v = this.depots(); // read first: the input must be tracked even before the layers exist
      this.fleet?.setDepots(v);
    });
    effect(() => {
      const v = this.pads(); // read first: the input must be tracked even before the layers exist
      this.fleet?.setPads(v);
    });
    effect(() => {
      const v = this.partners(); // read first: the input must be tracked even before the layers exist
      this.fleet?.setPartners(v);
    });
    effect(() => {
      const v = this.allRestaurants(); // read first: the input must be tracked even before the layers exist
      this.fleet?.setAllRestaurants(v);
    });
    effect(() => {
      const v = this.drones(); // read first: the input must be tracked even before the layers exist
      this.fleet?.setDrones(v);
    });
    effect(() => {
      const v = this.deliveries(); // read first: the input must be tracked even before the layers exist
      this.fleet?.setOrders(v);
    });
  }

  private syncFleet(): void {
    const f = this.fleet;
    if (!f) return;
    f.setHospitals(this.hospitals());
    f.setDepots(this.depots());
    f.setPads(this.pads());
    f.setPartners(this.partners());
    f.setAllRestaurants(this.allRestaurants());
    f.setDrones(this.drones());
    f.setOrders(this.deliveries());
  }

  // --- city boundary ------------------------------------------------------------

  private syncBoundary(boundary: BoundaryResponse | undefined, missing: boolean): void {
    const map = this.map;
    if (!map) return;
    if (this.coverageBanner) {
      this.coverageBanner.hidden = !missing;
      this.coverageBanner.innerHTML = missing
        ? '<b>Warsaw boundary data unavailable.</b> Showing an approximate view; routing coverage cannot be validated.'
        : '';
    }
    if (!boundary || this.cityLayer) return;
    this.districtLayer = L.geoJSON(boundary.districts, {
      style: { color: COLORS.district, weight: 1.2, opacity: 0.8, fill: false },
      interactive: false,
      onEachFeature: (f, l) =>
        l.bindTooltip(String(f.properties.name), { permanent: true, direction: 'center', className: 'district-label' }),
    });
    this.cityLayer = L.geoJSON(boundary.city, {
      style: { color: COLORS.city, weight: 3, opacity: 0.9, fill: false },
      interactive: false,
    });
    this.register('districts', this.districtLayer);
    this.register('boundary', this.cityLayer);
    this.cityBounds = this.cityLayer.getBounds();
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

  private showWarsawControl(): L.Control {
    const c = new L.Control({ position: 'topleft' });
    c.onAdd = () => {
      const btn = L.DomUtil.create('button', 'show-warsaw-btn') as HTMLButtonElement;
      btn.type = 'button';
      btn.title = 'Show Entire Warsaw';
      btn.setAttribute('data-testid', 'show-warsaw');
      btn.innerHTML = '<span class="material-icons">zoom_out_map</span><span>Show Entire Warsaw</span>';
      L.DomEvent.disableClickPropagation(btn);
      L.DomEvent.on(btn, 'click', () => this.showEntireWarsaw());
      return btn;
    };
    return c;
  }

  private coverageBannerControl(): L.Control {
    const c = new L.Control({ position: 'topleft' });
    c.onAdd = () => {
      this.coverageBanner = L.DomUtil.create('div', 'coverage-banner');
      this.coverageBanner.setAttribute('data-testid', 'coverage-banner');
      this.coverageBanner.hidden = true;
      return this.coverageBanner;
    };
    return c;
  }

  // --- building tiles ------------------------------------------------------------

  private buildingStyle = (f?: GeoJSON.Feature): L.PathOptions => {
    const tall = ((f?.properties as BuildingProps).height_m ?? 0) >= TALL_BUILDING_M;
    const color = tall ? COLORS.tallBuilding : COLORS.building;
    return { color, weight: tall ? 1 : 0.5, fillColor: color, fillOpacity: tall ? 0.85 : 0.45 };
  };

  private buildingTooltip = (f: GeoJSON.Feature, l: L.Layer): void => {
    const p = f.properties as BuildingProps;
    const h = p.height_m === null ? 'height unknown' : `${p.height_m} m`;
    l.bindTooltip(`<b>${h}</b><br>${HEIGHT_SOURCE_LABEL[p.height_source]}`, { sticky: true });
  };

  /** Loads/shows z14 footprint tiles in view at street zoom; hides them when zoomed out. */
  private syncBuildingTiles(): void {
    const map = this.map;
    const group = this.tileGroup;
    if (!map || !group) return;
    // Viewport-based: nothing is fetched while the layer is off or below the zoom threshold.
    if (!this.layerStore.isVisible('buildings') || map.getZoom() < BUILDING_MIN_ZOOM || map.getSize().x === 0) {
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
            if (map.getZoom() >= BUILDING_MIN_ZOOM) group.addLayer(layer);
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
    if (!layer) return;
    layer.clearLayers();
    layer.addData({
      type: 'FeatureCollection',
      features: zones.map((z) => ({
        type: 'Feature',
        properties: { id: z.id, zone: z, highlighted: highlighted.includes(z.id) },
        geometry: z.geojsonGeometry,
      })),
    } as GeoJSON.FeatureCollection);
    this.enforceOrder();
  }

  /** Canvas draw order = hit-test order: corridors, zones, then buildings on top. */
  private enforceOrder(): void {
    this.zoneLayer?.bringToBack();
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

  private syncSource(src: AirspaceSource | undefined): void {
    if (!src) return;
    // Where the zone dataset ends: outside it zones are unknown, not "clear".
    if (this.map && !this.extentLayer && src.extent) {
      this.extentLayer = L.geoJSON(src.extent as GeoJSON.Geometry, {
        style: { color: COLORS.bbox, weight: 2, dashArray: '6 6', fill: false },
        interactive: false,
      });
      this.extentLayer.bindTooltip(src.extentLabel ?? 'Airspace data extent');
      this.register('airspaceZones', this.extentLayer); // shown with the zones
    }
  }

  private zonePopup(z: AirspaceZone): string {
    const e = z.evaluation;
    const src = this.airspaceSource();
    const alt = (v: number | null, unknown: string) => (v === null ? unknown : `${v} m`);
    const band = `${alt(z.lowerAltitude, 'unknown floor')} – ${alt(z.upperAltitude, 'unknown ceiling')} ${z.altitudeReference}`;
    const validity =
      z.validityStart || z.validityEnd
        ? `${z.validityStart ? new Date(z.validityStart).toISOString().slice(0, 16).replace('T', ' ') : '…'} → ${
            z.validityEnd ? new Date(z.validityEnd).toISOString().slice(0, 16).replace('T', ' ') : '…'
          } UTC`
        : 'Permanent / not specified';
    const syntheticNotice =
      z.sourceType === 'SYNTHETIC'
        ? '<div class="zone-source-warning">Synthetic boundary, not an official geographical zone</div>'
        : z.sourceType === 'PLANNING_CONSTRAINT'
          ? '<div class="zone-source-warning">PLANNING CONSTRAINT: avoided by SkyRoute policy (OSM-mapped area). Not an official no-fly zone.</div>'
          : '';
    return `
      <div class="zone-popup" data-zone-id="${esc(z.id)}">
        ${syntheticNotice}
        <div class="title">${esc(z.name)}</div>
        <div class="row"><span class="chip chip-${e.displayClass.toLowerCase()}">${esc(z.draCategory)}</span>
          <span class="status">${esc(STATUS_LABEL[e.status])}</span></div>
        <ul class="reasons">${e.reasons.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>
        <dl>
          <dt>Zone ID</dt><dd>${esc(z.id)}</dd>
          <dt>Restriction</dt><dd>${esc(z.restrictionType)}</dd>
          <dt>Altitude</dt><dd>${esc(band)}</dd>
          <dt>Validity</dt><dd>${esc(validity)}</dd>
          <dt>Authorization</dt><dd>${z.authorizationRequired === null ? 'unknown' : z.authorizationRequired ? 'required' : 'not required'}</dd>
          ${z.operationalConditions ? `<dt>Conditions</dt><dd>${esc(z.operationalConditions)}</dd>` : ''}
          ${z.circle ? `<dt>Circle</dt><dd>${z.circle.radiusM} m radius around ${z.circle.center[1].toFixed(5)}, ${z.circle.center[0].toFixed(5)}</dd>` : ''}
          <dt>Source</dt><dd>${esc(z.source ?? 'unknown')} (${esc(SOURCE_LABEL[z.sourceType])})</dd>
          <dt>Source time</dt><dd>${esc(z.sourceTimestamp ?? 'unknown')}</dd>
          ${src ? `<dt>Last update</dt><dd>dataset v${esc(src.datasetVersion)}, loaded ${esc(src.loadedAt.slice(0, 16).replace('T', ' '))} UTC</dd>` : ''}
          <dt>Verification</dt><dd>${esc(z.verificationStatus)}</dd>
        </dl>
      </div>`;
  }

  private syncMarker(role: 'start' | 'destination', loc: SelectedLocation | null): void {
    const map = this.map;
    if (!map) return;
    const existing = this.markers[role];
    if (!loc) {
      existing?.remove();
      delete this.markers[role];
      return;
    }
    const latlng = L.latLng(loc.coordinate.latitude, loc.coordinate.longitude);
    const tooltip = `<b>${role === 'start' ? 'Point A' : 'Point B'}</b><br>${loc.label}`;
    if (existing) {
      existing.setLatLng(latlng).setTooltipContent(tooltip);
    } else {
      this.markers[role] = L.marker(latlng, {
        icon: L.divIcon({
          className: '',
          html: `<div class="route-pin route-pin-${role}"><span>${role === 'start' ? 'A' : 'B'}</span></div>`,
          iconSize: [28, 28],
          iconAnchor: [14, 28],
        }),
        keyboard: false,
        zIndexOffset: 1000,
      })
        .bindTooltip(tooltip, { direction: 'top', offset: [0, -26] })
        .addTo(map);
    }
    // A searched address or entrance: zoom to street level (building matches closer); others pan if off-screen.
    if (loc.source === 'SEARCH' || loc.source === 'ENTRANCE') {
      const zoom = loc.source === 'ENTRANCE' || loc.accuracy === 'ADDRESS' ? 18 : loc.accuracy === 'STREET' ? 16 : 15;
      if (map.getSize().x > 0) map.setView(latlng, Math.max(map.getZoom(), zoom));
    } else if (loc.source !== 'MAP_CLICK' && !map.getBounds().contains(latlng)) {
      map.panTo(latlng);
    }
  }

  /** Updates the drone, its flown trails and the return route in place (no rebuild per frame). */
  private syncSimulation(frame: SimFrame | null): void {
    const map = this.map;
    const group = this.simLayer;
    if (!map || !group) return;
    if (!frame) {
      group.clearLayers();
      this.simTrails = [];
      this.simReturn = undefined;
      this.drone = undefined;
      return;
    }
    if (frame.returnPath && !this.simReturn) {
      this.simReturn = L.polyline(frame.returnPath, {
        renderer: this.routeRenderer, color: COLORS.simReturn, weight: 4, opacity: 0.85, dashArray: '10 6',
        className: 'sim-return', interactive: false,
      }).addTo(group);
    }
    frame.trails.forEach((trail, i) => {
      if (!this.simTrails[i]) {
        this.simTrails[i] = L.polyline(trail, {
          renderer: this.routeRenderer, color: COLORS.simTrail, weight: 6, opacity: 0.95, className: 'sim-trail',
          interactive: false,
        }).addTo(group);
      } else {
        this.simTrails[i].setLatLngs(trail);
      }
    });
    const at = L.latLng(frame.lat, frame.lng);
    if (!this.drone) {
      this.drone = L.marker(at, { icon: droneIcon(), pane: 'dronePane', interactive: false, keyboard: false }).addTo(group);
    } else {
      this.drone.setLatLng(at);
    }
    const body = this.drone.getElement()?.querySelector<HTMLElement>('.drone-body');
    if (body) body.style.transform = `rotate(${frame.heading.toFixed(1)}deg)`;
    if (frame.follow && !map.getBounds().pad(-0.15).contains(at)) map.panTo(at, { animate: false });
  }

  private syncRoute(state: RouteState): void {
    const map = this.map;
    const group = this.routeLayer;
    if (!map || !group) return;
    group.clearLayers();
    const response =
      state.phase === 'ready' || state.phase === 'stale'
        ? state.response
        : state.phase === 'loading'
          ? state.previous
          : undefined;
    if (!response?.geometry) return;

    const stale = state.phase !== 'ready';
    const color = stale
      ? COLORS.routeStale
      : response.mode === 'EMERGENCY'
        ? COLORS.routeEmergency
        : COLORS.routeNormal;
    const latlngs = response.geometry.coordinates.map(([lon, lat]) => L.latLng(lat, lon));
    const line = L.polyline(latlngs, {
      renderer: this.routeRenderer,
      color,
      weight: 5,
      opacity: stale ? 0.6 : 0.95,
      dashArray: stale ? '8 8' : undefined,
      className: `route-line ${stale ? 'route-stale' : 'route-' + response.mode.toLowerCase()}`,
      interactive: false,
    });
    // Halo for contrast on the busy basemap.
    group.addLayer(
      L.polyline(latlngs, { renderer: this.routeRenderer, color: '#fff', weight: 9, opacity: stale ? 0.3 : 0.8, interactive: false }),
    );
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
    link(this.start(), response.routeStart);
    link(this.destination(), response.routeDestination);

    if (state.phase === 'ready' && this.lastFitted !== response) {
      this.lastFitted = response;
      map.fitBounds(line.getBounds(), { padding: [48, 48], maxZoom: 16 });
    }
  }

  ngOnDestroy(): void {
    this.resizeObserver?.disconnect();
    this.map?.remove();
  }

  private render(layers: Layers | undefined): void {
    const map = this.map;
    if (!map || !layers) return;

    for (const layer of this.dataLayers) this.unregister(layer);

    // Thousands of building/park polygons share the canvas with the zones,
    // which sit *below* buildings: canvas hit-testing picks the topmost shape,
    // so building tooltips work inside zones and zone popups in the gaps.
    const onCanvas: L.PathOptions = { renderer: this.canvas };

    const corridors = (type: CorridorProps['corridor_type'], color: string, opacity: number) =>
      L.geoJSON(layers.corridors, {
        ...onCanvas,
        filter: (f) => f.properties.corridor_type === type,
        style: { color, weight: 0, fillColor: color, fillOpacity: opacity },
        onEachFeature: (f, l) => {
          const p = f.properties as CorridorProps;
          if (p.name) l.bindTooltip(p.name, { sticky: true });
        },
      });

    // Citywide overview: buildings >= 50 m are always shown; all footprints come as tiles.
    const tall = L.geoJSON(layers.tallBuildings, { ...onCanvas, style: this.buildingStyle, onEachFeature: this.buildingTooltip });

    const stations = L.geoJSON(layers.stations, {
      pointToLayer: (f, latlng) =>
        L.marker(latlng, { icon: this.stationIcon((f.properties as StationProps).station_type) }),
      onEachFeature: (f, l) => l.bindPopup(this.stationPopup(f.properties as StationProps)),
    });

    const river = corridors('RIVER', COLORS.river, 0.35);
    const parks = corridors('PARK', COLORS.park, 0.3);
    this.corridorLayers = [parks, river];
    const keyed: [LayerKey, L.Layer][] = [['river', river], ['parks', parks], ['tallBuildings', tall], ['legacyStations', stations]];
    this.dataLayers = keyed.map(([key, layer]) => this.register(key, layer));
    this.tallLayer = tall;
    this.enforceOrder();
  }

  // --- layer registry (Layers panel) -------------------------------------------------

  /** Adds a map layer under a Layers-panel key; it is shown only while that key is visible. */
  private register(key: LayerKey, layer: L.Layer): L.Layer {
    const list = this.registry.get(key) ?? [];
    list.push(layer);
    this.registry.set(key, list);
    this.applyVisibility(key, layer, this.layerStore.visible()[key]);
    this.enforceOrder();
    return layer;
  }

  private unregister(layer: L.Layer): void {
    for (const [key, list] of this.registry) this.registry.set(key, list.filter((l) => l !== layer));
    layer.remove();
  }

  private applyVisibility(key: LayerKey, layer: L.Layer, on: boolean): void {
    const map = this.map;
    if (!map) return;
    if (on && !map.hasLayer(layer)) map.addLayer(layer);
    if (!on && map.hasLayer(layer)) map.removeLayer(layer);
  }

  private syncLayerVisibility(visible: Record<LayerKey, boolean>): void {
    for (const [key, list] of this.registry) for (const layer of list) this.applyVisibility(key, layer, visible[key]);
    this.enforceOrder();
    this.syncBuildingTiles();
  }

  /** Visible map layers per key (for tests and diagnostics). */
  visibleLayerKeys(): LayerKey[] {
    const map = this.map;
    return [...this.registry].filter(([, list]) => !!map && list.some((l) => map.hasLayer(l))).map(([k]) => k);
  }

  // --- entrances --------------------------------------------------------------------------

  private syncEntrances(entrances: Entrance[]): void {
    const group = this.entranceLayer;
    if (!group) return;
    group.clearLayers();
    for (const e of entrances) {
      const text = esc(e.ref ?? (e.entrance === 'main' ? 'M' : '•'));
      L.marker([e.latitude, e.longitude], {
        icon: L.divIcon({
          className: '',
          html: `<div class="entrance-pin${e.matchesFlat ? ' flat-match' : ''}" data-entrance-id="${esc(e.id)}">${text}</div>`,
          iconSize: [22, 22],
          iconAnchor: [11, 11],
        }),
        title: `Entrance ${e.ref ?? ''} (${e.entrance ?? 'mapped'})`.replace('  ', ' '),
        zIndexOffset: 900,
      })
        .on('click', () => this.entranceSelected.emit(e))
        .addTo(group);
    }
  }

  private stationIcon(type: StationType): L.DivIcon {
    return L.divIcon({
      className: '',
      html: `<div class="station-icon station-${type.toLowerCase()}"><span class="material-icons">${STATION_ICON[type]}</span></div>`,
      iconSize: [30, 30],
      iconAnchor: [15, 15],
      popupAnchor: [0, -16],
    });
  }

  private stationPopup(p: StationProps): string {
    return `
      <div class="station-popup">
        <div class="title">${p.name}</div>
        <div>${STATION_LABEL[p.station_type]}</div>
        <div>Status: <span class="status status-${p.status.toLowerCase()}">${p.status}</span></div>
        <div>Capacity: ${p.capacity} drone${p.capacity === 1 ? '' : 's'}</div>
        <div class="sample-tag">SYNTHETIC SAMPLE LOCATION</div>
      </div>`;
  }



}
