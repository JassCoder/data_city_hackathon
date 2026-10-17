import {
  Component,
  ElementRef,
  OnDestroy,
  ViewEncapsulation,
  afterNextRender,
  effect,
  input,
  output,
  viewChild,
} from '@angular/core';
import * as L from 'leaflet';
import { DemoBbox } from '../core/api';
import { AirspaceSource, AirspaceZone, DisplayClass, SOURCE_LABEL, STATUS_LABEL } from '../core/airspace';
import { BuildingProps, CorridorProps, Layers, StationProps, StationType, TALL_BUILDING_M } from '../core/layers';
import { Coordinate, SelectedLocation } from '../core/models';
import { RouteState } from '../core/planner.store';

const WARSAW_CENTER: L.LatLngTuple = [52.2297, 21.0122];

export const COLORS = {
  river: '#1e88e5',
  park: '#43a047',
  building: '#9e9e9e',
  tallBuilding: '#37474f',
  bbox: '#455a64',
  routeNormal: '#1565c0',
  routeEmergency: '#2e7d32',
  routeStale: '#757575',
} as const;

/** Airspace legend colours (fill = evaluation class for the planned flight). */
export const ZONE_COLORS: Record<DisplayClass, string> = {
  RED: '#d32f2f',
  ORANGE: '#f57c00',
  YELLOW: '#f9a825',
  GRAY: '#757575',
  INACTIVE: '#9e9e9e',
};
const OBSTACLE_OUTLINE = '#c62828';

function esc(v: unknown): string {
  return String(v ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** Leaflet path style for a zone: fill by class, solid red outline when it is a routing obstacle. */
export function zoneStyle(z: AirspaceZone, highlighted = false): L.PathOptions {
  const e = z.evaluation;
  const fill = ZONE_COLORS[e.displayClass];
  if (e.displayClass === 'INACTIVE') {
    return { color: '#757575', weight: highlighted ? 4 : 1.5, dashArray: '4 6', fillColor: fill, fillOpacity: 0.06 };
  }
  return {
    color: e.isObstacle ? OBSTACLE_OUTLINE : fill,
    weight: highlighted ? 5 : e.isObstacle ? 2.5 : 1.5,
    dashArray: e.isObstacle ? undefined : '6 4',
    fillColor: fill,
    fillOpacity: e.displayClass === 'RED' ? 0.4 : 0.3,
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
  default_15m: 'unknown, default 15 m (estimated)',
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
  styleUrl: './map.scss',
  // Leaflet builds its own DOM (legend, icons, popups), so styles must be global.
  encapsulation: ViewEncapsulation.None,
})
export class MapComponent implements OnDestroy {
  readonly layers = input<Layers | undefined>();
  readonly start = input<SelectedLocation | null>(null);
  readonly destination = input<SelectedLocation | null>(null);
  readonly route = input<RouteState>({ phase: 'idle' });
  /** True while a "Pick on map" target is armed (crosshair cursor). */
  readonly picking = input(false);
  /** Evaluated airspace zones to draw (already filtered for display). */
  readonly zones = input<AirspaceZone[]>([]);
  readonly airspaceSource = input<AirspaceSource | undefined>();
  readonly highlightZoneIds = input<string[]>([]);
  readonly focusZoneId = input<string | null>(null);
  readonly mapClick = output<Coordinate>();
  readonly focusDone = output<void>();

  private readonly mapEl = viewChild.required<ElementRef<HTMLDivElement>>('mapEl');
  private map?: L.Map;
  private layerControl?: L.Control.Layers;
  private dataLayers: L.Layer[] = [];
  private buildingsLayer?: L.GeoJSON;
  private corridorLayers: L.GeoJSON[] = [];
  private zoneLayer?: L.GeoJSON;
  private canvas?: L.Renderer;
  private banner?: HTMLElement;
  private legendSource?: HTMLElement;
  private readonly markers: Partial<Record<'start' | 'destination', L.Marker>> = {};
  private routeLayer?: L.LayerGroup;
  private routeRenderer?: L.Renderer;
  private lastFitted?: unknown;

  constructor() {
    afterNextRender(() => {
      this.map = L.map(this.mapEl().nativeElement).setView(WARSAW_CENTER, 14);
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        attribution: '&copy; OpenStreetMap contributors',
      }).addTo(this.map);
      this.layerControl = L.control.layers(undefined, undefined, { collapsed: false }).addTo(this.map);
      this.legend().addTo(this.map);
      this.airspaceBanner().addTo(this.map);
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
      }).addTo(this.map);
      this.layerControl.addOverlay(this.zoneLayer, this.swatch(ZONE_COLORS.RED, 'Airspace zones'));
      // Re-enabled overlays are drawn last on the shared canvas: restore the order.
      this.map.on('overlayadd', () => this.enforceOrder());
      this.map.on('click', (e: L.LeafletMouseEvent) =>
        this.mapClick.emit({ latitude: e.latlng.lat, longitude: e.latlng.lng }),
      );
      // Route above all data layers (canvas + SVG in overlayPane), below markers.
      this.map.createPane('routePane').style.zIndex = '450';
      this.routeRenderer = L.svg({ pane: 'routePane' });
      this.routeLayer = L.layerGroup().addTo(this.map);
      this.render(this.layers());
      this.syncMarker('start', this.start());
      this.syncMarker('destination', this.destination());
      this.syncRoute(this.route());
      this.syncZones(this.zones(), this.highlightZoneIds());
      this.syncSource(this.airspaceSource());
    });

    effect(() => this.render(this.layers()));
    effect(() => this.syncMarker('start', this.start()));
    effect(() => this.syncMarker('destination', this.destination()));
    effect(() => this.syncRoute(this.route()));
    effect(() => this.mapEl().nativeElement.classList.toggle('picking', this.picking()));
    effect(() => this.syncZones(this.zones(), this.highlightZoneIds()));
    effect(() => this.syncSource(this.airspaceSource()));
    effect(() => this.focus(this.focusZoneId()));
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
    this.buildingsLayer?.bringToFront();
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
    if (!this.banner || !this.legendSource) return;
    if (!src) {
      this.banner.hidden = true;
      this.legendSource.textContent = 'Airspace data: not loaded';
      return;
    }
    this.banner.hidden = false;
    this.banner.className = `airspace-banner source-${src.sourceType.toLowerCase()}`;
    this.banner.innerHTML =
      src.sourceType === 'DEMO'
        ? '<b>DEMO airspace</b>: synthetic zones, <u>not</u> official PAŻP boundaries'
        : `<b>${esc(SOURCE_LABEL[src.sourceType])}</b>: ${esc(src.label)}. Not a legality check.`;
    this.legendSource.textContent = `Airspace data: ${SOURCE_LABEL[src.sourceType]} (v${src.datasetVersion})`;
  }

  private zonePopup(z: AirspaceZone): string {
    const e = z.evaluation;
    const alt = (v: number | null, unknown: string) => (v === null ? unknown : `${v} m`);
    const band = `${alt(z.lowerAltitude, 'unknown floor')} – ${alt(z.upperAltitude, 'unknown ceiling')} ${z.altitudeReference}`;
    const validity =
      z.validityStart || z.validityEnd
        ? `${z.validityStart ? new Date(z.validityStart).toISOString().slice(0, 16).replace('T', ' ') : '…'} → ${
            z.validityEnd ? new Date(z.validityEnd).toISOString().slice(0, 16).replace('T', ' ') : '…'
          } UTC`
        : 'Permanent / not specified';
    const demo =
      z.sourceType === 'DEMO'
        ? '<div class="zone-demo">DEMO: synthetic boundary, NOT an official geographical zone</div>'
        : '';
    return `
      <div class="zone-popup" data-zone-id="${esc(z.id)}">
        ${demo}
        <div class="title">${esc(z.name)}</div>
        <div class="row"><span class="chip chip-${e.displayClass.toLowerCase()}">${esc(z.draCategory)}</span>
          <span class="status">${esc(STATUS_LABEL[e.status])}</span></div>
        <ul class="reasons">${e.reasons.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>
        <dl>
          <dt>Restriction</dt><dd>${esc(z.restrictionType)}</dd>
          <dt>Altitude</dt><dd>${esc(band)}</dd>
          <dt>Validity</dt><dd>${esc(validity)}</dd>
          <dt>Authorization</dt><dd>${z.authorizationRequired === null ? 'unknown' : z.authorizationRequired ? 'required' : 'not required'}</dd>
          ${z.operationalConditions ? `<dt>Conditions</dt><dd>${esc(z.operationalConditions)}</dd>` : ''}
          ${z.circle ? `<dt>Circle</dt><dd>${z.circle.radiusM} m radius around ${z.circle.center[1].toFixed(5)}, ${z.circle.center[0].toFixed(5)}</dd>` : ''}
          <dt>Source</dt><dd>${esc(z.source ?? 'unknown')} (${esc(SOURCE_LABEL[z.sourceType])})</dd>
          <dt>Source time</dt><dd>${esc(z.sourceTimestamp ?? 'unknown')}</dd>
          <dt>Verification</dt><dd>${esc(z.verificationStatus)}</dd>
        </dl>
      </div>`;
  }

  private airspaceBanner(): L.Control {
    const c = new L.Control({ position: 'topleft' });
    c.onAdd = () => {
      this.banner = L.DomUtil.create('div', 'airspace-banner');
      this.banner.hidden = true;
      L.DomEvent.disableClickPropagation(this.banner);
      return this.banner;
    };
    return c;
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
    // Typed or searched points may be off-screen: pan there, keeping the zoom.
    if (loc.source !== 'MAP_CLICK' && loc.source !== 'DEMO' && !map.getBounds().contains(latlng)) {
      map.panTo(latlng);
    }
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
    this.map?.remove();
  }

  private render(layers: Layers | undefined): void {
    const map = this.map;
    const control = this.layerControl;
    if (!map || !control || !layers) return;

    for (const layer of this.dataLayers) {
      control.removeLayer(layer);
      layer.remove();
    }

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

    const buildings = L.geoJSON(layers.buildings, {
      ...onCanvas,
      style: (f) => {
        const tall = (f?.properties as BuildingProps).height_m >= TALL_BUILDING_M;
        const color = tall ? COLORS.tallBuilding : COLORS.building;
        return { color, weight: tall ? 1 : 0.5, fillColor: color, fillOpacity: tall ? 0.85 : 0.45 };
      },
      onEachFeature: (f, l) => {
        const p = f.properties as BuildingProps;
        l.bindTooltip(`<b>${p.height_m} m</b><br>${HEIGHT_SOURCE_LABEL[p.height_source]}`, {
          sticky: true,
        });
      },
    });

    const stations = L.geoJSON(layers.stations, {
      pointToLayer: (f, latlng) =>
        L.marker(latlng, { icon: this.stationIcon((f.properties as StationProps).station_type) }),
      onEachFeature: (f, l) => l.bindPopup(this.stationPopup(f.properties as StationProps)),
    });

    const river = corridors('RIVER', COLORS.river, 0.35);
    const parks = corridors('PARK', COLORS.park, 0.3);
    this.corridorLayers = [parks, river];
    const overlays: [string, L.Layer][] = [
      [this.swatch(COLORS.bbox, 'Demo area', true), this.bboxLayer(layers.bbox)],
      [this.swatch(COLORS.river, 'River'), river],
      [this.swatch(COLORS.park, 'Parks / green'), parks],
      [this.swatch(COLORS.tallBuilding, 'Buildings'), buildings],
      [this.swatch('#1565c0', 'Landing stations'), stations],
    ];
    this.dataLayers = overlays.map(([name, layer]) => {
      layer.addTo(map);
      control.addOverlay(layer, name);
      return layer;
    });
    this.buildingsLayer = buildings;
    this.enforceOrder();
  }

  private bboxLayer(bbox: DemoBbox): L.Layer {
    return L.rectangle(
      [
        [bbox.minLat, bbox.minLon],
        [bbox.maxLat, bbox.maxLon],
      ],
      { color: COLORS.bbox, weight: 2, dashArray: '6 6', fill: false, interactive: false },
    );
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
        <div class="demo-tag">DEMO DATA</div>
      </div>`;
  }

  private swatch(color: string, label: string, dashed = false): string {
    const style = dashed ? `border:2px dashed ${color}` : `background:${color}`;
    return `<span class="swatch" style="${style}"></span>${label}`;
  }

  private legend(): L.Control {
    const legend = new L.Control({ position: 'bottomright' });
    legend.onAdd = () => {
      const el = L.DomUtil.create('div', 'map-legend');
      el.innerHTML = `
        <div class="legend-title">Airspace (for the planned flight)</div>
        ${this.swatch(ZONE_COLORS.RED, 'RED: blocked / prohibited')}<br>
        ${this.swatch(ZONE_COLORS.ORANGE, 'ORANGE: conditional / authorization required')}<br>
        ${this.swatch(ZONE_COLORS.YELLOW, 'YELLOW: technical or informational')}<br>
        ${this.swatch(ZONE_COLORS.GRAY, 'GRAY: insufficient verification')}<br>
        <span class="swatch" style="border:2.5px solid ${OBSTACLE_OUTLINE}"></span>Red outline: routing obstacle<br>
        <span class="swatch" style="border:2px dashed #757575"></span>Dashed: not active (time / altitude)<br>
        <div class="legend-source" data-testid="legend-source">Airspace data: not loaded</div>
        <div class="legend-title">Map</div>
        ${this.swatch(COLORS.routeNormal, 'Route NORMAL')} ${this.swatch(COLORS.routeEmergency, 'EMERGENCY')}<br>
        ${this.swatch(COLORS.river, 'River corridor')}<br>
        ${this.swatch(COLORS.park, 'Park / green corridor')}<br>
        ${this.swatch(COLORS.building, 'Building')}<br>
        ${this.swatch(COLORS.tallBuilding, `Building ≥ ${TALL_BUILDING_M} m`)}<br>
        ${this.swatch(COLORS.bbox, 'Demo area', true)}<br>
        <span class="legend-icon station-icon station-hospital"><span class="material-icons">local_hospital</span></span>Landing station
        <div class="legend-note">Avoiding the loaded zones does not confirm real-world flight legality.</div>`;
      this.legendSource = el.querySelector<HTMLElement>('.legend-source')!;
      return el;
    };
    return legend;
  }
}
