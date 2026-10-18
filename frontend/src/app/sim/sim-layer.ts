import { ChangeDetectionStrategy, Component, OnDestroy, ViewEncapsulation, effect, inject, input, output, untracked } from '@angular/core';
import * as L from 'leaflet';

import { SETTINGS } from '../core/settings';
import { esc } from '../map/map';
import { zonePathStyle, zoneTickStyle } from '../map/map-style';
import { STATE_LABEL } from './event-feed';
import { DronePose, splitRoute } from './interpolation';
import { busyStations } from './sim-geo';
import { F, SessionInfo, SimDroneInfo, SimState, SimZone } from './sim-models';
import { FocusRequest, PlaybackFrame, SimSession } from './sim-session';

const CFG = SETTINGS.sim;
const ZONE_KIND = 'conditional'; // scenario and drawn zones are DRA-R: authorization required, routes go around
const GROUND = new Set<SimState>(['IDLE', 'LOADING', 'CHARGING', 'FAILED']);
const GLYPH: Partial<Record<SimState, string>> = {
  HOLDING: 'M9 7v10M15 7v10',
  EMERGENCY_LANDING: 'M12 4l9 16H3zM12 10v4M12 17h.01',
  FAILED: 'M7 7l10 10M17 7L7 17',
  CHARGING: 'M13 3L6 14h5l-1 7 7-11h-5z',
};
const toLatLngs = (pts: [number, number][]) => pts.map(([lon, lat]) => L.latLng(lat, lon));

function prefersReducedMotion(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** One drone on the map: a heading arrow in its colour, a state glyph and a name tag. */
class DroneMarker {
  readonly marker: L.Marker;
  private root?: HTMLElement;
  private arrow?: SVGElement;
  private glyph?: HTMLElement;
  private stateEl?: HTMLElement;
  private bar?: HTMLElement;
  private barBox?: HTMLElement;
  private state?: SimState;
  private battery = -1;
  private heading = NaN;
  private selected = false;

  constructor(
    private readonly info: SimDroneInfo,
    pose: DronePose,
    onClick: () => void,
  ) {
    const html = `
      <div class="sim-drone" style="--drone:${esc(info.color)}">
        <div class="sd-icon"><span class="sd-ring"></span>
          <svg class="sd-arrow" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.5l7.5 18-7.5-4.5-7.5 4.5z"/></svg>
          <span class="sd-glyph" aria-hidden="true"></span></div>
        <div class="sd-tag"><span class="sd-name">${esc(info.name)}</span><span class="sd-state"></span>
          <span class="sd-bat" aria-hidden="true"><i></i></span></div>
      </div>`;
    const icon = L.divIcon({ className: 'sim-drone-icon', html, iconSize: [28, 28], iconAnchor: [14, 14] });
    this.marker = L.marker([pose.latitude, pose.longitude], { icon, pane: 'simDronePane', keyboard: true, riseOnHover: true });
    this.marker.on('click', onClick);
    this.marker.on('add', () => this.bind(pose));
  }

  private bind(pose: DronePose): void {
    const el = this.marker.getElement();
    if (!el) return;
    this.root = el.querySelector<HTMLElement>('.sim-drone')!;
    this.arrow = el.querySelector<SVGElement>('.sd-arrow')!;
    this.glyph = el.querySelector<HTMLElement>('.sd-glyph')!;
    this.stateEl = el.querySelector<HTMLElement>('.sd-state')!;
    this.barBox = el.querySelector<HTMLElement>('.sd-bat')!;
    this.bar = el.querySelector<HTMLElement>('.sd-bat i')!;
    el.setAttribute('role', 'button');
    this.state = undefined;
    this.battery = -1;
    this.heading = NaN;
    this.update(pose);
    this.setSelected(this.selected);
  }

  /** Called every animation frame: touches the DOM only where something changed. */
  update(p: DronePose): void {
    this.marker.setLatLng([p.latitude, p.longitude]);
    if (!this.root) return;
    if (!(Math.abs(p.headingDeg - this.heading) < 0.5)) {
      this.heading = p.headingDeg;
      this.arrow!.style.transform = `rotate(${p.headingDeg.toFixed(1)}deg)`;
    }
    const battery = Math.round(p.batteryPct);
    if (p.state !== this.state) {
      this.state = p.state;
      this.root.dataset['state'] = p.state;
      this.root.classList.toggle('ground', GROUND.has(p.state));
      this.stateEl!.textContent = STATE_LABEL[p.state];
      const g = GLYPH[p.state];
      this.glyph!.innerHTML = g ? `<svg viewBox="0 0 24 24"><path d="${g}"/></svg>` : '';
      this.battery = -1; // refresh the label
    }
    if (battery !== this.battery) {
      this.battery = battery;
      this.bar!.style.width = `${Math.max(0, Math.min(100, battery))}%`;
      this.barBox!.dataset['level'] = battery <= this.info.minReservePct ? 'critical' : battery <= 2 * this.info.minReservePct ? 'low' : 'ok';
      this.marker.getElement()?.setAttribute('aria-label', `${this.info.name}: ${STATE_LABEL[p.state]}, battery ${battery} %`);
    }
  }

  setSelected(on: boolean): void {
    this.selected = on;
    this.root?.classList.toggle('selected', on);
    this.marker.setZIndexOffset(on ? 1000 : 0);
  }
}

interface DroneLines {
  trail: L.Polyline;
  flown: L.Polyline;
  ahead: L.Polyline;
}

/**
 * Draws the running simulation on the shared Leaflet map: drone markers (moved every
 * animation frame, outside change detection), flown/remaining routes and trails (canvas,
 * redrawn every `lineRefreshMs`), active temporary zones and busy landing stations.
 */
@Component({
  selector: 'app-sim-layer',
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.None, // styles the Leaflet DOM
  styleUrl: './sim-layer.scss',
  template: '',
})
export class SimLayerComponent implements OnDestroy {
  readonly map = input<L.Map | undefined>();
  readonly droneClick = output<string>();

  private readonly sim = inject(SimSession);
  private attached?: L.Map;
  private session?: SessionInfo;
  private markers: DroneMarker[] = [];
  private lines: DroneLines[] = [];
  private lineRenderer?: L.Renderer;
  private zoneRenderer?: L.Renderer;
  private readonly lineGroup = L.layerGroup();
  private readonly markerGroup = L.layerGroup();
  private readonly zoneGroup = L.layerGroup();
  private readonly stationGroup = L.layerGroup();
  private readonly stationMarkers = new Map<string, { marker: L.Marker; key: string }>();
  private unsubscribe?: () => void;
  private lastFrame?: PlaybackFrame;
  private lastLines = -Infinity;
  private lineTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingFocus: FocusRequest | null = null;
  private readonly reducedMotion = prefersReducedMotion();
  private readonly onZoom = () => this.syncZoomClass();
  private readonly onDrag = () => this.sim.follow.set(false);

  constructor() {
    effect(() => {
      const map = this.map();
      const info = this.sim.info();
      untracked(() => this.setup(map, info ?? undefined));
    });
    effect(() => {
      const zones = this.sim.zones();
      const active = this.sim.activeZoneIds();
      untracked(() => this.drawZones(zones, active));
    });
    effect(() => {
      const id = this.sim.selectedId();
      untracked(() => this.markSelected(id));
    });
    effect(() => {
      const f = this.sim.focus();
      untracked(() => this.applyFocus(f));
    });
  }

  // --- setup -------------------------------------------------------------------------------

  private setup(map: L.Map | undefined, info: SessionInfo | undefined): void {
    if (map && map !== this.attached) this.attach(map);
    if (!this.attached || info === this.session) return;
    this.session = info;
    this.markerGroup.clearLayers();
    this.lineGroup.clearLayers();
    this.markers = [];
    this.lines = [];
    this.lastFrame = undefined;
    this.clearStations();
    if (!info) return;
    const poses = this.sim.posesAt(this.sim.clockT);
    info.drones.forEach((d, i) => {
      const pose = poses?.[i];
      const lines: DroneLines = {
        trail: L.polyline([], { renderer: this.lineRenderer, color: d.color, weight: 6, opacity: 0.28, lineCap: 'round', interactive: false }),
        flown: L.polyline([], { renderer: this.lineRenderer, color: d.color, weight: 2.5, opacity: 0.55, interactive: false }),
        ahead: L.polyline([], { renderer: this.lineRenderer, color: d.color, weight: 3, opacity: 0.9, dashArray: '7 6', interactive: false }),
      };
      this.lineGroup.addLayer(lines.trail).addLayer(lines.flown).addLayer(lines.ahead);
      this.lines.push(lines);
    });
    if (poses) this.ensureMarkers(poses);
    this.markSelected(this.sim.selectedId());
    this.drawZones(this.sim.zones(), this.sim.activeZoneIds());
  }

  private attach(map: L.Map): void {
    this.detach();
    this.attached = map;
    const pane = (name: string, z: number) => map.getPane(name) ?? Object.assign(map.createPane(name).style, { zIndex: String(z) });
    pane('simLinePane', 455); // above planned routes (450), below markers (600)
    pane('simStationPane', 590); // rings under the station icons
    pane('simDronePane', 630);
    this.lineRenderer = L.canvas({ pane: 'simLinePane', padding: 0.3 });
    this.zoneRenderer = L.svg({ pane: 'zonePane' });
    this.zoneGroup.addTo(map);
    this.lineGroup.addTo(map);
    this.stationGroup.addTo(map);
    this.markerGroup.addTo(map);
    map.on('zoomend', this.onZoom);
    map.on('dragstart', this.onDrag);
    this.syncZoomClass();
    this.unsubscribe = this.sim.onFrame((f) => this.onFrame(f));
  }

  private detach(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    if (this.lineTimer) clearTimeout(this.lineTimer);
    this.lineTimer = null;
    const map = this.attached;
    if (!map) return;
    map.off('zoomend', this.onZoom);
    map.off('dragstart', this.onDrag);
    for (const g of [this.zoneGroup, this.lineGroup, this.stationGroup, this.markerGroup]) g.remove();
    map.getContainer().classList.remove('sim-zoom-low');
    this.attached = undefined;
    this.session = undefined;
  }

  ngOnDestroy(): void {
    this.detach();
  }

  // --- per frame ---------------------------------------------------------------------------

  private ensureMarkers(poses: DronePose[]): void {
    const info = this.session;
    if (!info || this.markers.length) return;
    info.drones.forEach((d, i) => {
      const m = new DroneMarker(d, poses[i], () => this.droneClick.emit(d.id));
      this.markers.push(m);
      this.markerGroup.addLayer(m.marker);
    });
    this.markSelected(this.sim.selectedId());
  }

  private onFrame(f: PlaybackFrame): void {
    this.lastFrame = f;
    this.ensureMarkers(f.poses);
    const n = Math.min(this.markers.length, f.poses.length);
    for (let i = 0; i < n; i++) this.markers[i].update(f.poses[i]);
    const now = performance.now();
    if (now - this.lastLines >= CFG.lineRefreshMs) this.flushLines();
    else if (!this.lineTimer) this.lineTimer = setTimeout(() => this.flushLines(), CFG.lineRefreshMs);
    if (this.pendingFocus) this.applyFocus(this.pendingFocus);
  }

  /** Routes, trails, stations and the camera: about 10 times a second. */
  private flushLines(): void {
    if (this.lineTimer) clearTimeout(this.lineTimer);
    this.lineTimer = null;
    this.lastLines = performance.now();
    const f = this.lastFrame;
    const info = this.session;
    if (!f || !info) return;
    const trailFrames = this.sim.buffer.between(f.t - CFG.trailS, f.t);
    f.poses.forEach((p, i) => {
      const lines = this.lines[i];
      if (!lines) return;
      const route = p.route >= 0 && p.state !== 'FAILED' ? this.sim.routes[p.route] : undefined;
      if (route) {
        const { flown, ahead } = splitRoute(route, p.progressM);
        lines.flown.setLatLngs(toLatLngs(flown));
        lines.ahead.setLatLngs(toLatLngs(ahead));
      } else {
        lines.flown.setLatLngs([]);
        lines.ahead.setLatLngs([]);
      }
      const trail = trailFrames.map((fr) => L.latLng(fr.d[i][F.latitude], fr.d[i][F.longitude]));
      trail.push(L.latLng(p.latitude, p.longitude));
      lines.trail.setLatLngs(p.state === 'IDLE' || p.state === 'CHARGING' ? [] : trail);
    });
    this.syncStations(f.poses, info);
    this.followSelected(f);
  }

  private markSelected(id: string | null): void {
    const info = this.session;
    if (!info) return;
    info.drones.forEach((d, i) => {
      const on = d.id === id;
      this.markers[i]?.setSelected(on);
      const lines = this.lines[i];
      if (!lines) return;
      lines.ahead.setStyle({ weight: on ? 4.5 : 3 });
      lines.flown.setStyle({ weight: on ? 3.5 : 2.5 });
      if (on) {
        lines.trail.bringToFront();
        lines.flown.bringToFront();
        lines.ahead.bringToFront();
      }
    });
  }

  private followSelected(f: PlaybackFrame): void {
    const map = this.attached;
    const info = this.session;
    if (!map || !info || !this.sim.follow()) return;
    const i = info.drones.findIndex((d) => d.id === this.sim.selectedId());
    const p = f.poses[i];
    if (!p) return;
    const target = L.latLng(p.latitude, p.longitude);
    const offset = map.latLngToContainerPoint(target).distanceTo(map.getSize().divideBy(2));
    if (offset < 2) return;
    if (this.reducedMotion) map.panTo(target, { animate: false });
    else map.panTo(target, { animate: true, duration: (CFG.lineRefreshMs / 1000) * 1.2, easeLinearity: 1, noMoveStart: true });
  }

  private applyFocus(f: FocusRequest | null): void {
    const map = this.attached;
    const info = this.session;
    if (!f || !map || !info) return;
    this.pendingFocus = null;
    const zoom = Math.max(map.getZoom(), 15);
    if (f.place) {
      map.setView([f.place[1], f.place[0]], zoom, { animate: !this.reducedMotion });
      return;
    }
    const i = info.drones.findIndex((d) => d.id === f.droneId);
    const br = this.sim.buffer.bracket(this.sim.clockT);
    if (i < 0) return;
    if (!br || !this.sim.buffer.covers(this.sim.clockT)) {
      this.pendingFocus = f; // the frames for that time are still loading
      return;
    }
    const p = this.sim.posesAt(this.sim.clockT)?.[i];
    if (p) map.setView([p.latitude, p.longitude], zoom, { animate: !this.reducedMotion });
  }

  private syncZoomClass(): void {
    const map = this.attached;
    if (map) map.getContainer().classList.toggle('sim-zoom-low', map.getZoom() < CFG.detailZoom);
  }

  // --- zones and stations ----------------------------------------------------------------

  private drawZones(zones: SimZone[], active: Set<string>): void {
    this.zoneGroup.clearLayers();
    if (!this.attached) return;
    for (const z of zones) {
      if (!active.has(z.id)) continue;
      const shape = L.geoJSON(z.geometry, {
        ...({ renderer: this.zoneRenderer } as L.PathOptions),
        style: () => zonePathStyle(ZONE_KIND),
        bubblingMouseEvents: true,
      });
      shape.bindTooltip(
        `<b>${esc(z.name)}</b><br>Temporary ${z.drawn ? 'drawn' : 'scenario'} zone, ${z.lowerM}–${z.upperM} m above ground.<br>` +
          '<span class="muted">Simulated, DEMO only.</span>',
        { sticky: true, className: 'zone-tooltip' },
      );
      this.zoneGroup.addLayer(shape);
      shape.eachLayer((l) => {
        const poly = l as L.Polygon;
        this.zoneGroup.addLayer(L.polygon(poly.getLatLngs() as L.LatLngExpression[][], { renderer: this.zoneRenderer, ...zoneTickStyle(ZONE_KIND) }));
      });
    }
  }

  private syncStations(poses: DronePose[], info: SessionInfo): void {
    const busy = busyStations(poses, info.stations, info.positionToleranceM);
    for (const [id, entry] of this.stationMarkers) {
      if (!busy.has(id)) {
        this.stationGroup.removeLayer(entry.marker);
        this.stationMarkers.delete(id);
      }
    }
    for (const [id, b] of busy) {
      const st = info.stations.find((s) => s.id === id)!;
      const names = b.drones.map((i) => info.drones[i].name).join(', ');
      const key = `${b.activity}|${names}`;
      const existing = this.stationMarkers.get(id);
      if (existing?.key === key) continue;
      const verb = b.activity === 'charging' ? 'charging' : 'landing';
      const icon = L.divIcon({
        className: 'sim-station-icon',
        html: `<div class="sim-station sim-station-${b.activity}"><span class="ss-badge">${b.activity === 'charging' ? `<svg viewBox="0 0 24 24"><path d="${GLYPH.CHARGING}"/></svg>` : ''}</span></div>`,
        iconSize: [46, 46],
        iconAnchor: [23, 23],
      });
      const tooltip = `<b>${esc(st.name)}</b><br>${esc(names)} ${verb}`;
      if (existing) {
        existing.marker.setIcon(icon).setTooltipContent(tooltip);
        existing.key = key;
      } else {
        const marker = L.marker([st.latitude, st.longitude], { icon, pane: 'simStationPane', keyboard: false, interactive: true })
          .bindTooltip(tooltip, { direction: 'top', offset: [0, -20] });
        this.stationGroup.addLayer(marker);
        this.stationMarkers.set(id, { marker, key });
      }
    }
  }

  private clearStations(): void {
    this.stationGroup.clearLayers();
    this.stationMarkers.clear();
  }
}
