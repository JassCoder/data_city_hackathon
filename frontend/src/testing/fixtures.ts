import { HttpTestingController } from '@angular/common/http/testing';
import { API_BASE_URL } from '../app/core/api';
import { Layers } from '../app/core/layers';
import { AirspaceSource, AirspaceZone, ZonesResponse } from '../app/core/airspace';
import {
  DroneProfilesResponse,
  GeocodingResponse,
  RouteRequest,
  RouteResponse,
  SelectedLocation,
  WeatherInfo,
} from '../app/core/models';

const empty = { type: 'FeatureCollection' as const, features: [] };

/** Stations only: zones, buildings and corridors use Leaflet's canvas renderer, which jsdom can't draw. */
export const LAYERS: Layers = {
  bbox: { minLon: 20.985, minLat: 52.215, maxLon: 21.05, maxLat: 52.25 },
  corridors: empty,
  buildings: empty,
  stations: {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        properties: { id: 'st-depot', name: 'Vistula Boulevard Depot', station_type: 'DEPOT', status: 'AVAILABLE', capacity: 6, source: 'DEMO' },
        geometry: { type: 'Point', coordinates: [21.0385, 52.2352] },
      },
      {
        type: 'Feature',
        properties: { id: 'st-hospital', name: 'Śródmieście Hospital Pad', station_type: 'HOSPITAL', status: 'AVAILABLE', capacity: 2, source: 'DEMO' },
        geometry: { type: 'Point', coordinates: [20.993, 52.23] },
      },
    ],
  },
};

export const PROFILES: DroneProfilesResponse = {
  disclaimer: 'sample',
  profiles: [
    { id: 'DEMO_DRONE_01', name: 'Standard Drone', description: '', cruiseSpeedMps: 15, maxWindKmh: 36, verticalClearanceM: 10, maxRangeKm: 12, maxPayloadKg: 0.5, source: 'DEMO' },
    { id: 'DEMO_DRONE_02', name: 'Delivery Drone', description: '', cruiseSpeedMps: 18, maxWindKmh: 45, verticalClearanceM: 15, maxRangeKm: 20, maxPayloadKg: 2.5, source: 'DEMO' },
  ],
};

export const DEMO_WEATHER: WeatherInfo = {
  mode: 'DEMO',
  source: 'DEMO',
  liveAvailable: null,
  windSpeedKmh: 14,
  windDirectionDeg: 250,
  windGustKmh: 22,
  observedAt: null,
  message: 'DEMO weather: fixed sample wind for reproducible results.',
};

export const CENTRALNA: SelectedLocation = {
  coordinate: { latitude: 52.22882, longitude: 21.00316 },
  label: 'Warszawa Centralna',
  source: 'SEARCH',
};
export const KOPERNIK: SelectedLocation = {
  coordinate: { latitude: 52.24178, longitude: 21.0286 },
  label: 'Centrum Nauki Kopernik',
  source: 'SEARCH',
};

export const GEOCODE_KOPERNIK: GeocodingResponse = {
  query: 'Kopernik',
  provider: 'nominatim',
  attribution: 'Geocoding: © OpenStreetMap contributors (ODbL), via Nominatim',
  cached: false,
  results: [
    { displayName: 'Centrum Nauki Kopernik, Powiśle, Warszawa', latitude: 52.24178, longitude: 21.0286, placeId: 'nominatim:1', category: 'tourism/museum', source: 'nominatim', inCoverage: true },
    { displayName: 'Lotnisko Chopina, Okęcie, Warszawa', latitude: 52.16307, longitude: 20.97081, placeId: 'nominatim:2', category: 'aeroway/aerodrome', source: 'nominatim', inCoverage: false },
  ],
};

export const AIRSPACE_SOURCE: AirspaceSource = {
  provider: 'skyroute-demo',
  sourceType: 'DEMO',
  label: 'SkyRoute DEMO airspace (synthetic, non-authoritative)',
  sourceTimestamp: '2026-10-17T00:00:00Z',
  datasetVersion: 'v1',
  loadedAt: '2026-10-17T12:00:00Z',
  disclaimer: 'SYNTHETIC DEMO DATA. NOT official PAŻP geographical zones.',
};

const square = (lon: number, lat: number, d = 0.002): GeoJSON.Polygon => ({
  type: 'Polygon',
  coordinates: [[[lon, lat], [lon + d, lat], [lon + d, lat + d], [lon, lat + d], [lon, lat]]],
});

function demoZone(over: Partial<AirspaceZone> & Pick<AirspaceZone, 'id' | 'name' | 'draCategory' | 'evaluation'>): AirspaceZone {
  return {
    restrictionType: 'PROHIBITED',
    geojsonGeometry: square(21.025, 52.224),
    circle: null,
    source: 'SkyRoute DEMO dataset (synthetic)',
    sourceType: 'DEMO',
    sourceTimestamp: '2026-10-17T00:00:00Z',
    validityStart: null,
    validityEnd: null,
    lowerAltitude: 0,
    upperAltitude: 300,
    altitudeReference: 'AGL',
    authorizationRequired: true,
    operationalConditions: null,
    verificationStatus: 'SYNTHETIC_DEMO',
    ...over,
  };
}

export const ZONES: ZonesResponse = {
  source: AIRSPACE_SOURCE,
  flightContext: { flightAltitudeMeters: 80, at: '2026-10-17T12:00:00Z' },
  zones: [
    demoZone({
      id: 'DEMO-P-SEJM', name: 'DEMO prohibited area: Sejm / Wiejska', draCategory: 'DRA-P',
      evaluation: { status: 'BLOCKED', displayClass: 'RED', isObstacle: true, reasons: ['Prohibited zone (DRA-P).'] },
    }),
    demoZone({
      id: 'DEMO-RM-PKIN', name: 'DEMO restricted area: Palace of Culture', draCategory: 'DRA-RM',
      restrictionType: 'AUTHORIZATION_REQUIRED', geojsonGeometry: square(21.004, 52.23),
      evaluation: { status: 'UNAVAILABLE_AUTHORIZATION', displayClass: 'ORANGE', isObstacle: true, reasons: ['Consent required.'] },
    }),
    demoZone({
      id: 'DEMO-I-VISTULA', name: 'DEMO information area: Vistula bridge works', draCategory: 'DRA-I',
      restrictionType: 'INFORMATION', geojsonGeometry: square(21.035, 52.234), authorizationRequired: false,
      operationalConditions: 'Cranes up to 40 m.',
      evaluation: { status: 'INFORMATION', displayClass: 'YELLOW', isObstacle: false, reasons: ['Information zone.'] },
    }),
    demoZone({
      id: 'DEMO-RH-SCHOOL', name: 'DEMO restricted circle: school', draCategory: 'DRA-RH',
      restrictionType: 'AUTHORIZATION_REQUIRED', geojsonGeometry: square(21.025, 52.238, 0.001),
      circle: { center: [21.0255, 52.239], radiusM: 100 }, upperAltitude: 60,
      evaluation: { status: 'NOT_APPLICABLE_ALTITUDE', displayClass: 'INACTIVE', isObstacle: false, reasons: ['Above the band.'] },
    }),
    demoZone({
      id: 'DEMO-X-INCOMPLETE', name: 'DEMO zone with incomplete metadata', draCategory: 'UNKNOWN',
      restrictionType: 'UNKNOWN', geojsonGeometry: square(20.996, 52.236, 0.001), source: null,
      lowerAltitude: null, upperAltitude: null, altitudeReference: 'UNKNOWN', authorizationRequired: null,
      verificationStatus: 'INSUFFICIENT_DATA',
      evaluation: { status: 'UNVERIFIED', displayClass: 'GRAY', isObstacle: true, reasons: ['No source metadata.'] },
    }),
  ],
};

export function routeResponse(req: RouteRequest, over: Partial<RouteResponse> = {}): RouteResponse {
  return {
    status: 'OK',
    message: 'Route calculated',
    geometry: {
      type: 'LineString',
      coordinates: [
        [req.start.longitude, req.start.latitude],
        [21.015, 52.235],
        [req.destination.longitude, req.destination.latitude],
      ],
    },
    distanceM: 3035.2,
    etaS: 175.6,
    mode: req.mode,
    flightAltitudeMeters: req.flightAltitudeMeters,
    droneProfileId: req.droneProfileId,
    weather: DEMO_WEATHER,
    routeStart: req.start,
    routeDestination: req.destination,
    zoneConflicts: [],
    airspace: AIRSPACE_SOURCE,
    planningVerificationStatus: 'SIMULATION_ONLY: DEMO airspace (synthetic zones). Not a check of real-world flight legality.',
    warnings: [],
    dataSources: ['Airspace zones: SkyRoute DEMO airspace (DEMO, version v1)'],
    computeMs: 80,
    ...over,
  };
}

/** Answers the app-wide startup requests that are not under test. */
export function flushStartup(http: HttpTestingController): void {
  for (const req of http.match(`${API_BASE_URL}/layers`)) req.flush(LAYERS);
  for (const req of http.match(`${API_BASE_URL}/drone-profiles`)) req.flush(PROFILES);
  for (const req of http.match(`${API_BASE_URL}/health`)) {
    req.flush({ status: 'ok', version: '0.3.0', mapCenter: [52.2297, 21.0122], demoBbox: LAYERS.bbox });
  }
  for (const req of http.match((r) => r.url.startsWith(`${API_BASE_URL}/weather`))) req.flush(DEMO_WEATHER);
  for (const req of http.match((r) => r.url.startsWith(`${API_BASE_URL}/zones`))) req.flush(ZONES);
}
