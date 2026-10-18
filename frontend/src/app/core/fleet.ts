import { Injectable, computed, inject, signal } from '@angular/core';
import { HttpClient, HttpHeaders, httpResource } from '@angular/common/http';
import { Observable, tap } from 'rxjs';
import { API_BASE_URL, safeValue } from './api';
import { MapLayerStore } from './map-layers';
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

export interface OrderDraft {
  orderType: OrderType;
  /** Facility whose point was explicitly set as Point A (e.g. "Order food from this restaurant"). */
  pickupFacilityId: string | null;
  pickupFacilityPoint: Coordinate | null;
  destinationFacilityId: string | null;
  destinationFacilityPoint: Coordinate | null;
  partnerId: string | null;
}

/** Development-only admin token (backend config.ADMIN_TOKEN default). Not production authentication. */
export const DEV_ADMIN_TOKEN = 'dev-admin-token';

export const ACTIVE_ORDER_STATUSES: OrderStatus[] = ['ASSIGNED', 'TO_PICKUP', 'LOADING', 'IN_DELIVERY', 'DELIVERED', 'RETURNING'];

export const EMPTY_DRAFT: OrderDraft = {
  orderType: 'FOOD_DELIVERY',
  pickupFacilityId: null,
  pickupFacilityPoint: null,
  destinationFacilityId: null,
  destinationFacilityPoint: null,
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
  readonly activeOrders = computed(() => this.orders().filter((o) => ACTIVE_ORDER_STATUSES.includes(o.status)));
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

  createOrder(body: {
    orderType: OrderType;
    pickup: Coordinate;
    destination: Coordinate;
    pickupFacilityId?: string | null;
    destinationFacilityId?: string | null;
    partnerId?: string | null;
    flightAltitudeMeters?: number;
  }): Observable<Order> {
    return this.after(this.http.post<Order>(`${API_BASE_URL}/orders`, body));
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
