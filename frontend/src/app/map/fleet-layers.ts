import * as L from 'leaflet';
import { Drone, Facility, Hospital, Order, Restaurant } from '../core/fleet';
import { ClusterLayer } from './cluster';
import { LayerKey } from '../core/map-layers';

/** Actions offered in facility popups (explicit user choices only). */
export type FacilityAction =
  | { action: 'setStart' | 'setDestination'; latitude: number; longitude: number; label: string }
  | { action: 'orderFrom'; restaurantId: string; padId: string; latitude: number; longitude: number; label: string }
  | { action: 'deliverTo'; stationId: string; latitude: number; longitude: number; label: string }
  | { action: 'viewFleet'; facilityId: string };

export const FLEET_COLORS = {
  depot: '#1565c0',
  restaurant: '#ef6c00',
  restaurantPlain: '#8d6e63',
  pad: '#6a1b9a',
  droneAvailable: '#2e7d32',
  droneBusy: '#757575',
  delivery: '#00897b',
} as const;

function esc(v: unknown): string {
  return String(v ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function icon(cls: string, glyph: string, size = 28): L.DivIcon {
  return L.divIcon({
    className: '',
    html: `<div class="station-icon ${cls}"><span class="material-icons">${glyph}</span></div>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
    popupAnchor: [0, -size / 2],
  });
}

function button(action: string, label: string, data: Record<string, string | number>): string {
  const attrs = Object.entries(data).map(([k, v]) => `data-${k}="${esc(v)}"`).join(' ');
  return `<button type="button" class="popup-action" data-action="${action}" ${attrs}>${label}</button>`;
}

function point(label: string, lat: number, lng: number): Record<string, string | number> {
  return { label, lat, lng };
}

function capacityLine(f: Facility): string {
  return `<dt>Capacity</dt><dd data-capacity>${f.available} available / ${f.capacity} spaces
    (${f.occupied} occupied, ${f.reserved} reserved)</dd>`;
}

const SIM_TAG = '<div class="sim-tag">SIMULATED – not approved for real drone operations</div>';

export function hospitalPopup(h: Hospital): string {
  const s = h.station;
  const name = h.name ?? 'Unnamed hospital (name not mapped in OSM)';
  return `<div class="facility-popup" data-hospital-id="${esc(h.id)}">
    <div class="title">${esc(name)}</div>
    <div class="sub">Real hospital location (OpenStreetMap)</div>
    <dl>
      <dt>Address</dt><dd>${esc(h.address ?? 'not mapped')}</dd>
      <dt>District</dt><dd>${esc(h.district ?? 'unknown')}</dd>
      ${s ? `<dt>Drone station</dt><dd data-station-status>${esc(s.verification)}${s.dispatchEnabled ? ' (simulation enabled)' : ' (not used for dispatch)'}</dd>
      ${capacityLine(s)}
      <dt>Active drones</dt><dd>${s.occupied + s.reserved}</dd>` : '<dt>Drone station</dt><dd>none</dd>'}
    </dl>
    ${SIM_TAG}
    <div class="sub">The hospital has not agreed to host drones; no landing infrastructure is assumed.</div>
    <div class="actions">
      ${button('setStart', 'Set as Point A', point(name, h.latitude, h.longitude))}
      ${button('setDestination', 'Set as Point B', point(name, h.latitude, h.longitude))}
      ${s?.dispatchEnabled ? button('deliverTo', 'Deliver to this station', { station: s.id, ...point(name, s.latitude, s.longitude) }) : ''}
      ${s ? button('viewFleet', 'Station details', { facility: s.id }) : ''}
    </div>
  </div>`;
}

export function depotPopup(d: Facility): string {
  return `<div class="facility-popup" data-depot-id="${esc(d.id)}">
    <div class="title">${esc(d.name)}</div>
    <div class="sub">${esc(d.depotType === 'HIGH_DEMAND' ? 'High-demand depot' : 'Standard depot')} · ${esc(d.district ?? '')}</div>
    <dl>
      ${capacityLine(d)}
      <dt>Drones</dt><dd>${d.availableDrones} available of ${d.assignedDrones} assigned</dd>
      <dt>Status</dt><dd>${esc(d.verification)} · ${esc(d.operationalStatus)}</dd>
      <dt>Source</dt><dd>${esc(d.dataSource)}</dd>
    </dl>
    ${SIM_TAG}
    <div class="actions">
      ${button('setStart', 'Set as Point A', point(d.name, d.latitude, d.longitude))}
      ${button('viewFleet', 'View fleet', { facility: d.id })}
    </div>
  </div>`;
}

export function restaurantPopup(r: Restaurant): string {
  const name = r.name ?? 'Unnamed restaurant';
  const pad = r.pad;
  const canOrder = !!pad?.dispatchEnabled && (r.subscription === 'ACTIVE' || r.subscription === 'TRIAL');
  return `<div class="facility-popup" data-restaurant-id="${esc(r.id)}">
    <div class="title">${esc(name)}</div>
    <div class="sub">Real restaurant location (OpenStreetMap)${r.cuisine ? ` · ${esc(r.cuisine)}` : ''}</div>
    <dl>
      <dt>Address</dt><dd>${esc(r.address ?? 'not mapped')}</dd>
      <dt>Subscription</dt><dd data-subscription>${esc(r.subscription)}${r.demoPartner ? ' (DEMO partner, fictional)' : ''}</dd>
      ${pad ? `<dt>Pickup pad</dt><dd>${esc(pad.verification)} · ${pad.available}/${pad.capacity} free</dd>` : ''}
    </dl>
    ${pad ? SIM_TAG : ''}
    <div class="actions">
      ${canOrder ? button('orderFrom', 'Order food delivery', { restaurant: r.id, pad: pad!.id, ...point(name, pad!.latitude, pad!.longitude) }) : ''}
      ${button('setStart', 'Set as Point A', point(name, r.latitude, r.longitude))}
      ${button('setDestination', 'Set as Point B', point(name, r.latitude, r.longitude))}
    </div>
  </div>`;
}

export function padPopup(p: Facility): string {
  return `<div class="facility-popup" data-pad-id="${esc(p.id)}">
    <div class="title">${esc(p.name)}</div>
    <div class="sub">PROPOSED drone pickup pad (not an authorized landing site)</div>
    <dl>
      ${capacityLine(p)}
      <dt>Verification</dt><dd>${esc(p.verification)}</dd>
      <dt>Landing method</dt><dd>${esc(p.landingMethod ?? 'unknown')}</dd>
    </dl>
    ${SIM_TAG}
    <div class="sub">${esc(p.notes ?? '')}</div>
  </div>`;
}

/** Owns the fleet overlays; MapComponent forwards data and popup actions. */
export class FleetLayers {
  readonly hospitals = new ClusterLayer<Hospital>((h) => this.hospitalMarker(h), { className: 'cluster-hospital' });
  readonly allRestaurants = new ClusterLayer<Restaurant>((r) => this.restaurantMarker(r, false),
    { className: 'cluster-restaurant', maxClusterZoom: 16 });
  readonly depots = L.layerGroup();
  readonly partners = L.layerGroup();
  readonly pads = L.layerGroup();
  readonly drones = L.layerGroup();
  readonly deliveries: L.LayerGroup;

  constructor(
    private readonly map: L.Map,
    register: (key: LayerKey, layer: L.Layer) => void,
    private readonly emit: (a: FacilityAction) => void,
    deliveryRenderer?: L.Renderer,
  ) {
    this.deliveries = L.layerGroup();
    const keyed: [LayerKey, L.Layer][] = [
      ['hospitals', this.hospitals], ['depots', this.depots], ['partners', this.partners],
      ['allRestaurants', this.allRestaurants], ['pads', this.pads], ['drones', this.drones], ['deliveries', this.deliveries],
    ];
    this.deliveryRenderer = deliveryRenderer;
    for (const [key, layer] of keyed) register(key, layer);
    map.on('popupopen', (e: L.PopupEvent) => this.wireActions(e.popup));
  }

  private readonly deliveryRenderer?: L.Renderer;

  /** Popup buttons → explicit user actions. */
  private wireActions(popup: L.Popup): void {
    const el = popup.getElement();
    el?.querySelectorAll<HTMLButtonElement>('button[data-action]').forEach((b) => {
      b.onclick = () => {
        const d = b.dataset;
        const lat = Number(d['lat']);
        const lng = Number(d['lng']);
        const label = d['label'] ?? '';
        switch (d['action']) {
          case 'setStart':
          case 'setDestination':
            this.emit({ action: d['action'], latitude: lat, longitude: lng, label });
            break;
          case 'orderFrom':
            this.emit({ action: 'orderFrom', restaurantId: d['restaurant']!, padId: d['pad']!, latitude: lat, longitude: lng, label });
            break;
          case 'deliverTo':
            this.emit({ action: 'deliverTo', stationId: d['station']!, latitude: lat, longitude: lng, label });
            break;
          case 'viewFleet':
            this.emit({ action: 'viewFleet', facilityId: d['facility']! });
            break;
        }
        this.map.closePopup();
      };
    });
  }

  private hospitalMarker(h: Hospital): L.Marker {
    const enabled = !!h.station?.dispatchEnabled;
    return L.marker([h.latitude, h.longitude], {
      icon: icon(`station-hospital${enabled ? ' enabled' : ''}`, 'local_hospital'),
      title: h.name ?? 'Unnamed hospital',
    }).bindPopup(hospitalPopup(h), { maxWidth: 300 });
  }

  private restaurantMarker(r: Restaurant, partner: boolean): L.Marker {
    return L.marker([r.latitude, r.longitude], {
      icon: partner ? icon('station-restaurant', 'restaurant') : icon('station-restaurant-plain', 'restaurant', 18),
      title: r.name ?? 'Unnamed restaurant',
    }).bindPopup(restaurantPopup(r), { maxWidth: 300 });
  }

  setHospitals(items: Hospital[]): void {
    this.hospitals.setPoints(items.map((h) => ({ lat: h.latitude, lng: h.longitude, data: h })));
  }

  setAllRestaurants(items: Restaurant[]): void {
    this.allRestaurants.setPoints(items.map((r) => ({ lat: r.latitude, lng: r.longitude, data: r })));
  }

  setPartners(items: Restaurant[]): void {
    this.partners.clearLayers();
    for (const r of items) this.partners.addLayer(this.restaurantMarker(r, true));
  }

  setDepots(items: Facility[]): void {
    this.depots.clearLayers();
    for (const d of items) {
      const cls = `station-depot${d.depotType === 'HIGH_DEMAND' ? ' high-demand' : ''}${d.dispatchEnabled ? '' : ' disabled'}`;
      this.depots.addLayer(L.marker([d.latitude, d.longitude], { icon: icon(cls, 'warehouse', 32), title: d.name })
        .bindPopup(depotPopup(d), { maxWidth: 300 }));
    }
  }

  setPads(items: Facility[]): void {
    this.pads.clearLayers();
    for (const p of items) {
      const cls = `station-pad${p.dispatchEnabled ? '' : ' disabled'}`;
      // Offset slightly so the pad does not hide the restaurant marker at the same point.
      this.pads.addLayer(L.marker([p.latitude, p.longitude], { icon: icon(cls, 'flight_land', 22), title: p.name, zIndexOffset: -100 })
        .bindPopup(padPopup(p), { maxWidth: 300 }));
    }
  }

  /** One badge per facility: green if a drone is available there, gray otherwise. */
  setDrones(drones: Drone[]): void {
    this.drones.clearLayers();
    const at = new Map<string, { lat: number; lng: number; total: number; available: number }>();
    for (const d of drones) {
      if (d.latitude === null || d.longitude === null || !d.currentFacilityId) continue;
      const e = at.get(d.currentFacilityId) ?? { lat: d.latitude, lng: d.longitude, total: 0, available: 0 };
      e.total++;
      if (d.available) e.available++;
      at.set(d.currentFacilityId, e);
    }
    for (const [fid, e] of at) {
      const cls = e.available ? 'drone-badge available' : 'drone-badge busy';
      this.drones.addLayer(L.marker([e.lat, e.lng], {
        icon: L.divIcon({
          className: '',
          html: `<div class="${cls}" data-facility="${esc(fid)}"><span class="material-icons">flight</span>${e.available}/${e.total}</div>`,
          iconSize: [54, 20],
          iconAnchor: [-14, 26],
        }),
        interactive: false,
        keyboard: false,
      }));
    }
  }

  setOrders(orders: Order[]): void {
    this.deliveries.clearLayers();
    for (const o of orders) {
      for (const leg of o.legs) {
        if (!leg.geometry) continue;
        const delivery = leg.leg === 'DELIVERY';
        L.polyline(leg.geometry.coordinates.map(([lng, lat]) => [lat, lng] as [number, number]), {
          color: FLEET_COLORS.delivery,
          weight: delivery ? 4 : 2.5,
          dashArray: delivery ? undefined : '6 6',
          opacity: 0.9,
          className: `delivery-${leg.leg.toLowerCase()}`,
          ...(this.deliveryRenderer ? { renderer: this.deliveryRenderer } : {}),
        }).bindTooltip(`Order ${o.id} · ${leg.leg} · ${o.status}`, { sticky: true }).addTo(this.deliveries);
      }
    }
  }
}
