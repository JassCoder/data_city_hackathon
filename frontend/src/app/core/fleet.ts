import { Injectable, computed, inject, signal } from '@angular/core';
import { HttpClient, HttpHeaders, httpResource } from '@angular/common/http';
import { Observable, tap } from 'rxjs';
import { API_BASE_URL, safeValue } from './api';
import { LayerKey, MapLayerStore } from './map-layers';
import { Coordinate } from './models';

/** Wire models for the simulated delivery infrastructure (backend/app/fleet/models.py). */

export type FacilityKind = 'HOSPITAL_STATION' | 'DEPOT' | 'RESTAURANT_PAD';
export type Verification = 'PROPOSED' | 'REVIEW_REQUIRED' | 'SIMULATION_ENABLED' | 'VERIFIED_BY_OPERATOR' | 'DISABLED';
export type SubscriptionStatus = 'NOT_SUBSCRIBED' | 'TRIAL' | 'ACTIVE' | 'SUSPENDED';
export type DroneStatus =
  | 'AVAILABLE' | 'RESERVED' | 'LOADING' | 'IN_FLIGHT' | 'DELIVERING' | 'RETURNING' | 'CHARGING' | 'MAINTENANCE' | 'OFFLINE';
export type OrderType = 'FOOD_DELIVERY' | 'BLOOD_DELIVERY' | 'AED_DELIVERY' | 'MEDICAL_SUPPLIES';
export type OrderStatus =
  | 'CREATED' | 'ASSIGNED' | 'TO_PICKUP' | 'LOADING' | 'IN_DELIVERY' | 'DELIVERED' | 'RETURNING' | 'COMPLETED'
  | 'NO_DRONE_AVAILABLE' | 'FAILED' | 'CANCELLED';

export interface Facility {
  id: string;
  kind: FacilityKind;
  refId: string | null;
  name: string;
  latitude: number;
  longitude: number;
  district: string | null;
  capacity: number;
  occupied: number;
  reserved: number;
  available: number;
  verification: Verification;
  operationalStatus: 'OPEN' | 'CLOSED';
  dispatchEnabled: boolean;
  depotType: 'STANDARD' | 'HIGH_DEMAND' | null;
  landingMethod: string | null;
  dataSource: string;
  demandScore: number | null;
  notes: string | null;
  assignedDrones: number;
  availableDrones: number;
  updatedAt: string;
}

export interface Hospital {
  id: string;
  osmId: string;
  name: string | null;
  address: string | null;
  district: string | null;
  latitude: number;
  longitude: number;
  website?: string | null;
  phone?: string | null;
  completeness: Record<string, boolean>;
  source: string;
  importedAt: string | null;
  station: Facility | null;
}

export interface Restaurant {
  id: string;
  osmId: string;
  name: string | null;
  address: string | null;
  district: string | null;
  latitude: number;
  longitude: number;
  cuisine?: string | null;
  source: string;
  importedAt: string | null;
  subscription: SubscriptionStatus;
  demoPartner: boolean;
  pad: Facility | null;
}

export interface Page<T> {
  total: number;
  offset: number;
  limit: number;
  items: T[];
  source: string | null;
  completenessNote: string | null;
  notice: string;
}

export interface Drone {
  id: string;
  name: string;
  droneProfileId: string;
  status: DroneStatus;
  homeDepotId: string;
  currentFacilityId: string | null;
  batteryPercent: number;
  maximumRangeMeters: number;
  available: boolean;
  currentOrderId: string | null;
  latitude: number | null;
  longitude: number | null;
  lastUpdated: string;
}

export interface RouteLeg {
  leg: 'TO_PICKUP' | 'DELIVERY' | 'RETURN';
  status: string;
  distanceM: number | null;
  etaS: number | null;
  geometry: GeoJSON.LineString | null;
  message: string;
}

export interface Order {
  id: string;
  orderType: OrderType;
  status: OrderStatus;
  pickup: Coordinate;
  destination: Coordinate;
  pickupFacilityId: string | null;
  destinationFacilityId: string | null;
  partnerId: string | null;
  droneId: string | null;
  droneProfileId: string | null;
  flightAltitudeMeters: number;
  legs: RouteLeg[];
  distanceM: number | null;
  estimatedDurationS: number | null;
  message: string | null;
  verification: string | null;
  createdAt: string;
  updatedAt: string;
  notice: string;
}

export interface AssignmentResult {
  order: Order;
  assigned: boolean;
  candidates: { droneId: string; depotId: string; eligible: boolean; reason: string; totalEtaS?: number | null }[];
  message: string;
}

export interface KindUtilization {
  facilities: number;
  capacity: number;
  occupied: number;
  reserved: number;
  available: number;
  utilization: number;
}

export interface FleetSummary {
  district: string | null;
  mappedHospitals: number;
  hospitalStationsEnabled: number;
  hospitalStationsProposed: number;
  depots: number;
  depotsEnabled: number;
  depotCapacity: number;
  drones: number;
  availableDrones: number;
  busyDrones: number;
  chargingDrones: number;
  droneStatus: Record<DroneStatus, number>;
  mappedRestaurants: number;
  subscribedRestaurants: number;
  activePads: number;
  occupiedSpaces: number;
  reservedSpaces: number;
  availableSpaces: number;
  activeOrders: number;
  utilization: Record<FacilityKind, KindUtilization>;
  notice: string;
}

export interface DemandReport {
  scenario: string;
  label: string;
  peakConcurrentDeliveries: number;
  depots: {
    depotId: string;
    name: string;
    district: string | null;
    installedCapacity: number;
    drones: number;
    demandShare: number;
    demandScore: number;
    expectedPeakDrones: number;
    utilizationAtPeak: number | null;
    level: 'LOW' | 'MEDIUM' | 'HIGH';
    recommendation: string;
  }[];
  assumptions: string[];
  notice?: string;
}

/** An address chosen in the fleet order form (independent of the planner's Point A/B). */
export interface OrderPlace {
  coordinate: Coordinate;
  label: string;
}

export interface OrderDraft {
  orderType: OrderType;
  /** Pickup address (food only; medical orders start at the nearest hospital). */
  pickup: OrderPlace | null;
  delivery: OrderPlace | null;
  /** Set by facility popups ("Order food from this restaurant", "Deliver to this station"). */
  pickupFacilityId: string | null;
  destinationFacilityId: string | null;
  partnerId: string | null;
}

export const MEDICAL_ORDER_TYPES: ReadonlySet<OrderType> = new Set(['BLOOD_DELIVERY', 'AED_DELIVERY', 'MEDICAL_SUPPLIES']);

/** Map layers switched on for each order type (the other type's layers are switched off). */
export const ORDER_LAYERS: Record<'FOOD' | 'MEDICAL', { on: LayerKey[]; off: LayerKey[] }> = {
  FOOD: { on: ['partners', 'pads', 'depots', 'drones', 'deliveries'], off: ['hospitals'] },
  MEDICAL: { on: ['hospitals', 'depots', 'drones', 'deliveries'], off: ['partners', 'pads'] },
};

export interface NearestHospital {
  hospital: Hospital;
  distanceM: number;
  pickup: Coordinate;
  pickupFacilityId: string | null;
  note: string;
}

/** Development-only admin token (backend config.ADMIN_TOKEN default). Not production authentication. */
export const DEV_ADMIN_TOKEN = 'dev-admin-token';

export const ACTIVE_ORDER_STATUSES: OrderStatus[] = ['ASSIGNED', 'TO_PICKUP', 'LOADING', 'IN_DELIVERY', 'DELIVERED', 'RETURNING'];

const MY_ORDERS_KEY = 'skyroute.fleet.myOrders.v1';

function restoreIds(): string[] {
  try {
    const v = JSON.parse(sessionStorage.getItem(MY_ORDERS_KEY) ?? '[]');
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

export const EMPTY_DRAFT: OrderDraft = {
  orderType: 'FOOD_DELIVERY',
  pickup: null,
  delivery: null,
  pickupFacilityId: null,
  destinationFacilityId: null,
  partnerId: null,
};

/**
 * Hospitals and restaurants are real OSM records; stations, depots, pads, drones
 * and orders are SIMULATED (backend SQLite). Resources reload after mutations.
 */
@Injectable({ providedIn: 'root' })
export class FleetService {
  private readonly http = inject(HttpClient);
  private readonly adminHeaders = new HttpHeaders({ 'X-Admin-Token': DEV_ADMIN_TOKEN });

  readonly district = signal<string | null>(null);
  private readonly mapLayers = inject(MapLayerStore);
  /** The "All restaurants" layer is loaded only while it is switched on in the Layers panel. */
  readonly showAllRestaurants = computed(() => this.mapLayers.visible().allRestaurants);
  readonly demandScenario = signal<'BASELINE' | 'CENTRAL_PEAK'>('BASELINE');
  readonly demandOpen = signal(false);
  readonly draft = signal<OrderDraft>(EMPTY_DRAFT);
  readonly dashboardOpen = signal(false);
  readonly lastMessage = signal<{ ok: boolean; text: string } | null>(null);

  readonly hospitalsResource = httpResource<Page<Hospital>>(() => `${API_BASE_URL}/hospitals?limit=1000`);
  readonly depotsResource = httpResource<Facility[]>(() => `${API_BASE_URL}/depots`);
  readonly padsResource = httpResource<Facility[]>(() => `${API_BASE_URL}/landing-pads`);
  readonly partnersResource = httpResource<Page<Restaurant>>(() => `${API_BASE_URL}/restaurants?subscribed=true&limit=500`);
  readonly allRestaurantsResource = httpResource<Page<Restaurant>>(() =>
    this.showAllRestaurants() ? `${API_BASE_URL}/restaurants?limit=5000` : undefined,
  );
  readonly dronesResource = httpResource<Drone[]>(() => `${API_BASE_URL}/drones`);
  readonly ordersResource = httpResource<Order[]>(() => `${API_BASE_URL}/orders`);
  readonly summaryResource = httpResource<FleetSummary>(() => {
    const d = this.district();
    return `${API_BASE_URL}/fleet/summary${d ? `?district=${encodeURIComponent(d)}` : ''}`;
  });
  readonly demandResource = httpResource<DemandReport>(() =>
    this.demandOpen() ? `${API_BASE_URL}/fleet/demand?scenario=${this.demandScenario()}` : undefined,
  );

  readonly hospitals = computed(() => safeValue(this.hospitalsResource)?.items ?? []);
  readonly depots = computed(() => safeValue(this.depotsResource) ?? []);
  readonly pads = computed(() => safeValue(this.padsResource) ?? []);
  readonly partners = computed(() => safeValue(this.partnersResource)?.items ?? []);
  readonly allRestaurants = computed(() => safeValue(this.allRestaurantsResource)?.items ?? []);
  readonly drones = computed(() => safeValue(this.dronesResource) ?? []);
  readonly orders = computed(() => safeValue(this.ordersResource) ?? []);
  readonly summary = computed(() => safeValue(this.summaryResource));
  readonly demand = computed(() => safeValue(this.demandResource));
  /** Orders created in this browser session: the only ones listed and drawn. */
  readonly myOrderIds = signal<string[]>(restoreIds());
  readonly myOrders = computed(() => {
    const ids = new Set(this.myOrderIds());
    return this.orders().filter((o) => ids.has(o.id));
  });
  readonly activeOrders = computed(() => this.myOrders().filter((o) => ACTIVE_ORDER_STATUSES.includes(o.status)));
  /** Order-form field waiting for a map click (fleet "Select on map"). */
  readonly pickTarget = signal<'pickup' | 'delivery' | null>(null);
  readonly enabledStations = computed(() =>
    this.hospitals().filter((h) => h.station?.dispatchEnabled).map((h) => ({ hospital: h, station: h.station! })),
  );
  readonly hospitalCompletenessNote = computed(() => safeValue(this.hospitalsResource)?.completenessNote ?? null);

  /** Reloads every resource touched by a simulated state change. */
  refresh(): void {
    for (const r of [this.depotsResource, this.padsResource, this.partnersResource, this.dronesResource,
      this.ordersResource, this.summaryResource, this.hospitalsResource]) r.reload();
    if (this.showAllRestaurants()) this.allRestaurantsResource.reload();
    if (this.demandOpen()) this.demandResource.reload();
  }

  private after<T>(obs: Observable<T>): Observable<T> {
    return obs.pipe(tap({ next: () => this.refresh(), error: () => this.refresh() }));
  }

  /** Shows the layers that matter for an order type (hiding only changes the map, never routing). */
  showLayersFor(type: OrderType): void {
    const preset = ORDER_LAYERS[MEDICAL_ORDER_TYPES.has(type) ? 'MEDICAL' : 'FOOD'];
    for (const k of preset.on) this.mapLayers.set(k, true);
    for (const k of preset.off) this.mapLayers.set(k, false);
  }

  nearestHospital(c: Coordinate): Observable<NearestHospital> {
    return this.http.get<NearestHospital>(`${API_BASE_URL}/hospitals/nearest`,
      { params: { latitude: c.latitude, longitude: c.longitude } });
  }

  createOrder(body: {
    orderType: OrderType;
    /** Omitted for medical orders: the backend uses the nearest hospital. */
    pickup?: Coordinate | null;
    destination: Coordinate;
    pickupFacilityId?: string | null;
    destinationFacilityId?: string | null;
    partnerId?: string | null;
    flightAltitudeMeters?: number;
  }): Observable<Order> {
    return this.after(this.http.post<Order>(`${API_BASE_URL}/orders`, body).pipe(tap((o) => this.remember(o.id))));
  }

  private remember(id: string): void {
    this.myOrderIds.update((ids) => (ids.includes(id) ? ids : [id, ...ids]));
    try {
      sessionStorage.setItem(MY_ORDERS_KEY, JSON.stringify(this.myOrderIds()));
    } catch {
      // storage unavailable: the list lasts for this page only
    }
  }

  /** Fills the armed order-form field from a map click. */
  setPickedPoint(c: Coordinate): void {
    const target = this.pickTarget();
    if (!target) return;
    const place = { coordinate: c, label: `Map point ${c.latitude.toFixed(5)}, ${c.longitude.toFixed(5)}` };
    this.draft.update((d) => target === 'pickup'
      ? { ...d, pickup: place, pickupFacilityId: null, partnerId: null }
      : { ...d, delivery: place, destinationFacilityId: null });
    this.pickTarget.set(null);
  }

  assign(orderId: string): Observable<AssignmentResult> {
    return this.after(this.http.post<AssignmentResult>(`${API_BASE_URL}/orders/${orderId}/assign-drone`, {}));
  }

  advance(orderId: string): Observable<Order> {
    return this.after(this.http.post<Order>(`${API_BASE_URL}/orders/${orderId}/advance`, {}));
  }

  cancel(orderId: string): Observable<Order> {
    return this.after(this.http.post<Order>(`${API_BASE_URL}/orders/${orderId}/cancel`, {}));
  }

  finishCharging(droneId: string): Observable<Drone> {
    return this.after(this.http.post<Drone>(`${API_BASE_URL}/drones/${droneId}/finish-charging`, {}));
  }

  patchFacility(f: Pick<Facility, 'id' | 'kind'>, patch: Partial<{
    capacity: number;
    verification: Verification;
    operationalStatus: 'OPEN' | 'CLOSED';
  }>): Observable<Facility> {
    const path = { DEPOT: 'depots', HOSPITAL_STATION: 'stations', RESTAURANT_PAD: 'landing-pads' }[f.kind];
    return this.after(this.http.patch<Facility>(`${API_BASE_URL}/${path}/${f.id}`, patch, { headers: this.adminHeaders }));
  }

  setSubscription(restaurantId: string, status: SubscriptionStatus): Observable<Restaurant> {
    return this.after(this.http.patch<Restaurant>(`${API_BASE_URL}/restaurants/${restaurantId}/subscription`,
      { status }, { headers: this.adminHeaders }));
  }
}
