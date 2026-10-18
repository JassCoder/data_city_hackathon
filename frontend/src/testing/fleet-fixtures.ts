import { HttpTestingController } from '@angular/common/http/testing';
import { API_BASE_URL } from '../app/core/api';
import { Drone, Facility, FleetSummary, Hospital, Order, Page, Restaurant } from '../app/core/fleet';

/** Mirrors the fleet API (backend/app/fleet). Real-looking places, simulated infrastructure. */

export function facility(over: Partial<Facility> & Pick<Facility, 'id' | 'kind' | 'name' | 'latitude' | 'longitude'>): Facility {
  return {
    refId: null,
    district: 'Śródmieście',
    capacity: 6,
    occupied: 0,
    reserved: 0,
    available: 6,
    verification: 'SIMULATION_ENABLED',
    operationalStatus: 'OPEN',
    dispatchEnabled: true,
    depotType: null,
    landingMethod: null,
    dataSource: 'SkyRoute simulation',
    demandScore: null,
    notes: null,
    assignedDrones: 0,
    availableDrones: 0,
    updatedAt: '2026-10-18T00:00:00Z',
    ...over,
  };
}

export const DEPOTS: Facility[] = [
  facility({ id: 'st-depot', kind: 'DEPOT', name: 'Vistula Boulevard Depot', latitude: 52.2352, longitude: 21.0385,
    occupied: 4, available: 2, depotType: 'STANDARD', assignedDrones: 4, availableDrones: 3,
    dataSource: 'Existing SkyRoute sample station (data/landing_stations.geojson), preserved' }),
  facility({ id: 'depot-05', kind: 'DEPOT', name: 'Proposed depot 05 – Śródmieście', latitude: 52.2280, longitude: 21.0050,
    capacity: 12, occupied: 8, available: 4, depotType: 'HIGH_DEMAND', assignedDrones: 8, availableDrones: 8 }),
];

const station = (id: string, ref: string, lat: number, lon: number, enabled: boolean, over: Partial<Facility> = {}) =>
  facility({ id, kind: 'HOSPITAL_STATION', refId: ref, name: `Proposed drone station – ${id}`, latitude: lat, longitude: lon,
    capacity: 2, available: 2, verification: enabled ? 'SIMULATION_ENABLED' : 'PROPOSED', dispatchEnabled: enabled, ...over });

export const HOSPITALS: Hospital[] = [
  { id: 'osm:way/891309425', osmId: 'way/891309425', name: 'Warszawski Szpital Dla Dzieci', address: 'ul. Kopernika 43, Warszawa',
    district: 'Śródmieście', latitude: 52.2353, longitude: 21.0225, completeness: { hasName: true }, source: 'OpenStreetMap',
    importedAt: '2026-10-18', station: station('hs-way-891309425', 'osm:way/891309425', 52.2353, 21.0225, true) },
  { id: 'osm:way/288525189', osmId: 'way/288525189', name: 'Szpital Bielański', address: null, district: 'Bielany',
    latitude: 52.2905, longitude: 20.9445, completeness: { hasName: true }, source: 'OpenStreetMap', importedAt: '2026-10-18',
    station: station('hs-way-288525189', 'osm:way/288525189', 52.2905, 20.9445, false) },
  { id: 'osm:node/1', osmId: 'node/1', name: null, address: null, district: 'Wawer', latitude: 52.2000, longitude: 21.1700,
    completeness: { hasName: false }, source: 'OpenStreetMap', importedAt: '2026-10-18',
    station: station('hs-node-1', 'osm:node/1', 52.2, 21.17, false) },
];

export const PAD = facility({ id: 'pad-osm-node-10', kind: 'RESTAURANT_PAD', refId: 'osm:node/10', name: 'Proposed pickup pad – Zapiecek',
  latitude: 52.2480, longitude: 21.0140, capacity: 1, available: 1, landingMethod: 'GROUND_PAD_PROPOSED',
  notes: 'DEMO partner (fictional subscription).' });

export const PARTNERS: Restaurant[] = [
  { id: 'osm:node/10', osmId: 'node/10', name: 'Zapiecek', address: 'ul. Piwna 34, Warszawa', district: 'Śródmieście',
    latitude: 52.2480, longitude: 21.0140, source: 'OpenStreetMap', importedAt: '2026-10-18', subscription: 'ACTIVE',
    demoPartner: true, pad: PAD },
];

export const RESTAURANT_PLAIN: Restaurant = {
  id: 'osm:node/11', osmId: 'node/11', name: 'Bar Testowy', address: null, district: 'Wola', latitude: 52.23, longitude: 20.98,
  source: 'OpenStreetMap', importedAt: '2026-10-18', subscription: 'NOT_SUBSCRIBED', demoPartner: false, pad: null,
};

export const DRONES: Drone[] = [
  { id: 'drone-001', name: 'SR-001', droneProfileId: 'DEMO_DRONE_02', status: 'AVAILABLE', homeDepotId: 'st-depot',
    currentFacilityId: 'st-depot', batteryPercent: 100, maximumRangeMeters: 20000, available: true, currentOrderId: null,
    latitude: 52.2352, longitude: 21.0385, lastUpdated: '' },
  { id: 'drone-002', name: 'SR-002', droneProfileId: 'DEMO_DRONE_01', status: 'CHARGING', homeDepotId: 'depot-05',
    currentFacilityId: 'depot-05', batteryPercent: 61, maximumRangeMeters: 12000, available: false, currentOrderId: null,
    latitude: 52.228, longitude: 21.005, lastUpdated: '' },
];

const util = (capacity: number, occupied: number, reserved = 0) =>
  ({ facilities: 1, capacity, occupied, reserved, available: capacity - occupied - reserved, utilization: (occupied + reserved) / capacity });

export const SUMMARY: FleetSummary = {
  district: null, mappedHospitals: 45, hospitalStationsEnabled: 6, hospitalStationsProposed: 45, depots: 10, depotsEnabled: 10,
  depotCapacity: 78, drones: 52, availableDrones: 50, busyDrones: 1, chargingDrones: 1,
  droneStatus: { AVAILABLE: 50, RESERVED: 1, LOADING: 0, IN_FLIGHT: 0, DELIVERING: 0, RETURNING: 0, CHARGING: 1, MAINTENANCE: 0, OFFLINE: 0 },
  mappedRestaurants: 1972, subscribedRestaurants: 6, activePads: 6, occupiedSpaces: 52, reservedSpaces: 1, availableSpaces: 44,
  activeOrders: 1,
  utilization: { DEPOT: util(78, 52), HOSPITAL_STATION: util(12, 0, 1), RESTAURANT_PAD: util(6, 0) },
  notice: 'SIMULATION',
};

export function page<T>(items: T[]): Page<T> {
  return { total: items.length, offset: 0, limit: 500, items, source: 'OpenStreetMap', completenessNote: 'OSM is not guaranteed complete.', notice: 'SIMULATION' };
}

export function orderFixture(over: Partial<Order> = {}): Order {
  return {
    id: 'ord-1', orderType: 'FOOD_DELIVERY', status: 'ASSIGNED',
    pickup: { latitude: 52.248, longitude: 21.014 }, destination: { latitude: 52.2353, longitude: 21.0225 },
    pickupFacilityId: null, destinationFacilityId: null, partnerId: null, droneId: 'drone-001', droneProfileId: 'DEMO_DRONE_02',
    flightAltitudeMeters: 80,
    legs: [
      { leg: 'TO_PICKUP', status: 'OK', distanceM: 1500, etaS: 100, geometry: { type: 'LineString', coordinates: [[21.0385, 52.2352], [21.014, 52.248]] }, message: '' },
      { leg: 'DELIVERY', status: 'OK', distanceM: 1700, etaS: 110, geometry: { type: 'LineString', coordinates: [[21.014, 52.248], [21.0225, 52.2353]] }, message: '' },
      { leg: 'RETURN', status: 'OK', distanceM: 1200, etaS: 80, geometry: { type: 'LineString', coordinates: [[21.0225, 52.2353], [21.0385, 52.2352]] }, message: '' },
    ],
    distanceM: 4400, estimatedDurationS: 210, message: 'Drone SR-001 reserved.', verification: 'UNVERIFIED SIMULATION',
    createdAt: '2026-10-18T00:00:00Z', updatedAt: '2026-10-18T00:00:00Z', notice: 'SIMULATION', ...over,
  };
}

/** Answers every fleet startup request. */
export function flushFleet(http: HttpTestingController, orders: Order[] = []): void {
  for (const r of http.match((q) => q.url.startsWith(`${API_BASE_URL}/hospitals`))) r.flush(page(HOSPITALS));
  for (const r of http.match(`${API_BASE_URL}/depots`)) r.flush(DEPOTS);
  for (const r of http.match(`${API_BASE_URL}/landing-pads`)) r.flush([PAD]);
  for (const r of http.match((q) => q.url.startsWith(`${API_BASE_URL}/restaurants?subscribed=true`))) r.flush(page(PARTNERS));
  for (const r of http.match((q) => q.url.startsWith(`${API_BASE_URL}/restaurants?limit`))) r.flush(page([...PARTNERS, RESTAURANT_PLAIN]));
  for (const r of http.match(`${API_BASE_URL}/drones`)) r.flush(DRONES);
  for (const r of http.match(`${API_BASE_URL}/orders`)) r.flush(orders);
  for (const r of http.match((q) => q.url.startsWith(`${API_BASE_URL}/fleet/summary`))) r.flush(SUMMARY);
}
