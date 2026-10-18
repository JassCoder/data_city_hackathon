import { TestBed } from '@angular/core/testing';
import { HttpTestingController } from '@angular/common/http/testing';
import { API_BASE_URL } from '../app/core/api';
import { Layers } from '../app/core/layers';
import { BoundaryResponse, CoverageResponse } from '../app/core/map-data';
import { AirspaceSource, AirspaceZone, ZonesResponse } from '../app/core/airspace';
import {
  CostBreakdown,
  DroneProfilesResponse,
  GeocodingResponse,
  RouteRequest,
  RouteResponse,
  ScenariosResponse,
  SelectedLocation,
  WeatherInfo,
} from '../app/core/models';

const empty = { type: 'FeatureCollection' as const, features: [] };

/** Stations only: zones, buildings and corridors use Leaflet's canvas renderer, which jsdom can't draw. */
export const LAYERS: Layers = {
  corridors: empty,
  tallBuildings: empty,
  buildingStats: { buildings: 120000, tallBuildings: 200, estimatedHeights: 9000, parks: 900, tiles: 400 },
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
    { id: 'DEMO_DRONE_01', name: 'Standard Drone', description: '', cruiseSpeedMps: 15, maxWindKmh: 36, verticalClearanceM: 10, maxRangeKm: 12, maxPayloadKg: 0.5, cruisePowerW: 250, payloadPowerWPerKg: 60, batteryWh: 100, source: 'DEMO' },
    { id: 'DEMO_DRONE_02', name: 'Delivery Drone', description: '', cruiseSpeedMps: 18, maxWindKmh: 45, verticalClearanceM: 15, maxRangeKm: 20, maxPayloadKg: 2.5, cruisePowerW: 600, payloadPowerWPerKg: 80, batteryWh: 400, source: 'DEMO' },
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

// Simplified Warsaw stand-in: two "districts" splitting a box at lon 21.05.
const ring = (w: number, s: number, e: number, n: number): GeoJSON.Polygon => ({
  type: 'Polygon',
  coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]],
});
const CITY_GEOM = ring(20.85, 52.1, 21.27, 52.37);
export const BOUNDARY: BoundaryResponse = {
  city: { type: 'Feature', properties: { teryt: '1465', name: 'Warszawa', officialName: 'powiat Warszawa', areaKm2: 517 }, geometry: CITY_GEOM },
  districts: {
    type: 'FeatureCollection',
    features: [
      { type: 'Feature', properties: { teryt: '146510_8', name: 'Śródmieście', officialName: 'Śródmieście - dzielnica', areaKm2: 15.6 }, geometry: ring(20.85, 52.1, 21.05, 52.37) },
      { type: 'Feature', properties: { teryt: '146507_8', name: 'Praga-Południe', officialName: 'Praga-Południe - dzielnica', areaKm2: 22.4 }, geometry: ring(21.05, 52.1, 21.27, 52.37) },
    ],
  },
  bounds: [20.85, 52.1, 21.27, 52.37],
  source: { source: 'GUGiK – Państwowy Rejestr Granic (PRG), OGC API Features', url: 'https://example', retrievedAt: '2026-10-17' },
};
export const COVERAGE: CoverageResponse = {
  status: 'AVAILABLE',
  message: 'ok',
  area: 'City of Warsaw (GUGiK PRG boundary, TERYT 1465)',
  geometry: CITY_GEOM,
  bounds: [20.85, 52.1, 21.27, 52.37],
  districts: ['Śródmieście', 'Praga-Południe'],
  source: { source: 'GUGiK' },
  fallbackView: null,
  routing: { cellSizeM: 25, gridCells: 1380000, maxFineCells: 300000, maxExpansions: 1200000, timeLimitS: 20, buildingData: 'OSM', buildingDataFetchedAt: null },
  airspace: { label: 'DEMO', sourceType: 'DEMO', extent: ring(20.985, 52.215, 21.05, 52.25), extentLabel: 'DEMO zones: central Warsaw only' },
};
export const OUTSIDE_POINT = { latitude: 52.05, longitude: 21.0 }; // south of the stand-in city

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

/** Mirrors GET /api/v1/scenarios (configuration only, no coordinates). */
export const SCENARIOS: ScenariosResponse = {
  note: 'Scenarios configure the optimisation only. Start and destination always come from the request.',
  scenarios: [
    { id: 'NORMAL', displayName: 'Normal Flight', description: 'Standard route.', optimizationGoal: 'PREFER_SAFE_CORRIDORS', routeObjective: 'CORRIDORS', mode: 'NORMAL', respectRestrictedZones: true, useWeather: true, recommendedProfileId: null },
    { id: 'BLOOD_DELIVERY', displayName: 'Blood Delivery', description: 'Minimises delivery time.', optimizationGoal: 'MINIMIZE_ETA', routeObjective: 'FASTEST', mode: 'NORMAL', respectRestrictedZones: true, useWeather: true, recommendedProfileId: 'DEMO_DRONE_02' },
    { id: 'AED_DELIVERY', displayName: 'AED / First Aid Delivery', description: 'Minimises response time.', optimizationGoal: 'MINIMIZE_ETA', routeObjective: 'FASTEST', mode: 'NORMAL', respectRestrictedZones: true, useWeather: true, recommendedProfileId: null },
    { id: 'AVOID_PROHIBITED_ZONE', displayName: 'Avoid Prohibited Zone', description: 'Shortest path around blocked zones.', optimizationGoal: 'MINIMIZE_DISTANCE', routeObjective: 'SHORTEST', mode: 'NORMAL', respectRestrictedZones: true, useWeather: true, recommendedProfileId: null },
    { id: 'EMERGENCY', displayName: 'Emergency Flight', description: 'Minimises travel time.', optimizationGoal: 'MINIMIZE_ETA', routeObjective: 'FASTEST', mode: 'EMERGENCY', respectRestrictedZones: true, useWeather: true, recommendedProfileId: null },
  ],
};

export const COST_BREAKDOWN: CostBreakdown = {
  totalCost: 4210.5,
  lengthM: 3035.2,
  terms: [
    { term: 'population', weight: 4, mean: 0.06, cost: 728.4 },
    { term: 'obstacle_proximity', weight: 0.3, mean: 0.02, cost: 18.2 },
    { term: 'noise', weight: 0.5, mean: 0.1, cost: 151.8 },
    { term: 'emergency_landing', weight: 0.5, mean: 0.05, cost: 75.9 },
    { term: 'sensitive_areas', weight: 1, mean: 0.0, cost: 0 },
    { term: 'energy', weight: 1, mean: 0.4, cost: 1214.1 },
    { term: 'time', weight: 0, mean: 0.6, cost: 0 },
  ],
  energyWh: 14.1,
  batteryUsableWh: 80,
  payloadKg: 0,
  flightTimeS: 175.6,
  populationExposure: 412.3,
  maxDensityPerHa: 640,
  localHour: 12,
  note: 'Cost model: data/cost_model.json (DEMO weights). Population density is an estimate from OSM floor area and stops, not census data.',
};

export function routeResponse(req: RouteRequest, over: Partial<RouteResponse> = {}): RouteResponse {
  return {
    status: 'OK',
    message: 'Route calculated',
    start: req.start,
    destination: req.destination,
    scenario: req.scenario ?? null,
    scenarioDisplayName: SCENARIOS.scenarios.find((s) => s.id === req.scenario)?.displayName ?? 'Custom settings',
    optimizationGoal: SCENARIOS.scenarios.find((s) => s.id === req.scenario)?.optimizationGoal ?? null,
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
    routeObjective: req.routeObjective,
    flightAltitudeMeters: req.flightAltitudeMeters,
    droneProfileId: req.droneProfileId,
    weather: DEMO_WEATHER,
    routeStart: req.start,
    routeDestination: req.destination,
    coverage: {
      valid: true, area: 'City of Warsaw', startDistrict: 'Śródmieście', destinationDistrict: 'Praga-Południe',
      source: 'GUGiK PRG', airspaceOutsideExtentM: 0,
    },
    search: { attempts: 1, resolutionM: 25, windowKm2: 12.5, expansions: 4200, wholeCity: false, limitedBy: null, elapsedMs: 85, cached: false },
    zoneConflicts: [],
    costBreakdown: COST_BREAKDOWN,
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
  for (const req of http.match(`${API_BASE_URL}/scenarios`)) req.flush(SCENARIOS);
  for (const req of http.match(`${API_BASE_URL}/health`)) {
    req.flush({ status: 'ok', version: '0.3.0', mapCenter: [52.2297, 21.0122], coverageAvailable: true });
  }
  for (const req of http.match((r) => r.url.startsWith(`${API_BASE_URL}/weather`))) req.flush(DEMO_WEATHER);
  for (const req of http.match((r) => r.url.startsWith(`${API_BASE_URL}/zones`))) req.flush(ZONES);
  for (const req of http.match(`${API_BASE_URL}/map/warsaw-boundary`)) req.flush(BOUNDARY);
  for (const req of http.match(`${API_BASE_URL}/map/coverage`)) req.flush(COVERAGE);
}

/**
 * Answers startup requests until none are left: services such as the boundary
 * resource only issue their request on the next change-detection tick.
 */
export async function settle(http: HttpTestingController, fixture?: { whenStable(): Promise<unknown> }): Promise<void> {
  for (let i = 0; i < 4; i++) {
    TestBed.tick();
    flushStartup(http);
  }
  if (fixture) await fixture.whenStable();
}
