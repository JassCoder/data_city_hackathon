import { TestBed } from '@angular/core/testing';
import { HttpTestingController } from '@angular/common/http/testing';
import { API_BASE_URL } from '../app/core/api';
import { flushFleet } from './fleet-fixtures';
import { Layers } from '../app/core/layers';
import { BoundaryResponse, CoverageResponse } from '../app/core/map-data';
import { AirspaceDiagnostics, AirspaceSource, AirspaceZone, ZonesResponse } from '../app/core/airspace';
import {
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
  buildingStats: { buildings: 120000, tallBuildings: 200, unknownHeights: 9000, parks: 900, tiles: 400 },
  stations: {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        properties: { id: 'st-depot', name: 'Vistula Boulevard Depot', station_type: 'DEPOT', status: 'AVAILABLE', capacity: 6, source: 'SYNTHETIC' },
        geometry: { type: 'Point', coordinates: [21.0385, 52.2352] },
      },
      {
        type: 'Feature',
        properties: { id: 'st-hospital', name: 'Śródmieście Hospital Pad', station_type: 'HOSPITAL', status: 'AVAILABLE', capacity: 2, source: 'SYNTHETIC' },
        geometry: { type: 'Point', coordinates: [20.993, 52.23] },
      },
    ],
  },
};

export const PROFILES: DroneProfilesResponse = {
  disclaimer: 'sample',
  profiles: [
    { id: 'DEMO_DRONE_01', name: 'Standard Drone', description: 'Synthetic sample profile', cruiseSpeedMps: 15, maxWindKmh: 36, verticalClearanceM: 10, maxRangeKm: 12, maxPayloadKg: 0.5, source: 'SYNTHETIC' },
    { id: 'DEMO_DRONE_02', name: 'Delivery Drone', description: 'Synthetic sample profile', cruiseSpeedMps: 18, maxWindKmh: 45, verticalClearanceM: 15, maxRangeKm: 20, maxPayloadKg: 2.5, source: 'SYNTHETIC' },
  ],
};

export const _WEATHER: WeatherInfo = {
  mode: 'SAMPLE',
  source: 'SAMPLE',
  liveAvailable: null,
  windSpeedKmh: 14,
  windDirectionDeg: 250,
  windGustKmh: 22,
  observedAt: null,
  message: 'SAMPLE weather: fixed sample wind for reproducible results.',
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
  routing: { cellSizeM: 25, gridCells: 1380000, maxFineCells: 300000, maxExpansions: 1200000, timeLimitS: 20, airspaceSafetyMarginM: 20, buildingData: 'OSM', buildingDataFetchedAt: null },
  airspace: { label: 'No airspace data loaded', sourceType: 'NONE', extent: null, extentLabel: 'No airspace data' },
};
export const OUTSIDE_POINT = { latitude: 52.05, longitude: 21.0 }; // south of the stand-in city

export const AIRSPACE_SOURCE: AirspaceSource = {
  provider: 'none',
  sourceType: 'NONE',
  label: 'No airspace data loaded',
  sourceTimestamp: '2026-10-17T00:00:00Z',
  datasetVersion: 'v1',
  loadedAt: '2026-10-17T12:00:00Z',
  disclaimer: 'No airspace zones are loaded. Unknown airspace is not unrestricted airspace.',
};

const square = (lon: number, lat: number, d = 0.002): GeoJSON.Polygon => ({
  type: 'Polygon',
  coordinates: [[[lon, lat], [lon + d, lat], [lon + d, lat + d], [lon, lat + d], [lon, lat]]],
});

function Zone(over: Partial<AirspaceZone> & Pick<AirspaceZone, 'id' | 'name' | 'draCategory' | 'evaluation'>): AirspaceZone {
  return {
    restrictionType: 'PROHIBITED',
    geojsonGeometry: square(21.025, 52.224),
    circle: null,
    source: 'Synthetic test fixture',
    sourceType: 'SYNTHETIC',
    sourceTimestamp: '2026-10-17T00:00:00Z',
    validityStart: null,
    validityEnd: null,
    lowerAltitude: 0,
    upperAltitude: 300,
    altitudeReference: 'AGL',
    authorizationRequired: true,
    operationalConditions: null,
    verificationStatus: 'SYNTHETIC',
    ...over,
  };
}

export const PARTIAL_COMPLETENESS = {
  status: 'PARTIAL' as const,
  cityAreaCoveredPct: 3.3,
  verificationStatus: 'SYNTHETIC: not official zones',
  message: 'PARTIAL AIRSPACE DATA: the loaded dataset covers 3.3% of Warsaw. Elsewhere zones are unknown, not absent.',
};

export const ZONES: ZonesResponse = {
  source: AIRSPACE_SOURCE,
  flightContext: { flightAltitudeMeters: 80, at: '2026-10-17T12:00:00Z' },
  completeness: PARTIAL_COMPLETENESS,
  totalZones: 5,
  bbox: null,
  zones: [
    Zone({
      id: '-P-SEJM', name: ' prohibited area: Sejm / Wiejska', draCategory: 'DRA-P',
      evaluation: { status: 'BLOCKED', displayClass: 'RED', isObstacle: true, reasons: ['Prohibited zone (DRA-P).'] },
    }),
    Zone({
      id: '-RM-PKIN', name: ' restricted area: Palace of Culture', draCategory: 'DRA-RM',
      restrictionType: 'AUTHORIZATION_REQUIRED', geojsonGeometry: square(21.004, 52.23),
      evaluation: { status: 'UNAVAILABLE_AUTHORIZATION', displayClass: 'RED', isObstacle: true, reasons: ['Consent required.'] },
    }),
    Zone({
      id: '-I-VISTULA', name: ' information area: Vistula bridge works', draCategory: 'DRA-I',
      restrictionType: 'INFORMATION', geojsonGeometry: square(21.035, 52.234), authorizationRequired: false,
      operationalConditions: 'Cranes up to 40 m.',
      evaluation: { status: 'INFORMATION', displayClass: 'YELLOW', isObstacle: false, reasons: ['Information zone.'] },
    }),
    Zone({
      id: '-RH-SCHOOL', name: ' restricted circle: school', draCategory: 'DRA-RH',
      restrictionType: 'AUTHORIZATION_REQUIRED', geojsonGeometry: square(21.025, 52.238, 0.001),
      circle: { center: [21.0255, 52.239], radiusM: 100 }, upperAltitude: 60,
      evaluation: { status: 'NOT_APPLICABLE_ALTITUDE', displayClass: 'INACTIVE', isObstacle: false, reasons: ['Above the band.'] },
    }),
    Zone({
      id: '-X-INCOMPLETE', name: ' zone with incomplete metadata', draCategory: 'UNKNOWN',
      restrictionType: 'UNKNOWN', geojsonGeometry: square(20.996, 52.236, 0.001), source: null,
      lowerAltitude: null, upperAltitude: null, altitudeReference: 'UNKNOWN', authorizationRequired: null,
      verificationStatus: 'INSUFFICIENT_DATA',
      evaluation: { status: 'UNVERIFIED', displayClass: 'GRAY', isObstacle: true, reasons: ['No source metadata.'] },
    }),
  ],
};

/** Synthetic zones spread over the whole city (north, south, east, west), incl. a MultiPolygon with a hole. */
export const CITYWIDE_ZONES: AirspaceZone[] = [
  Zone({
    id: 'TEST-P-NORTH', name: 'TEST north (Białołęka)', draCategory: 'DRA-P', geojsonGeometry: square(21.008, 52.305, 0.008),
    evaluation: { status: 'BLOCKED', displayClass: 'RED', isObstacle: true, reasons: ['Prohibited.'] },
  }),
  Zone({
    id: 'TEST-RM-SOUTH', name: 'TEST south (Ursynów)', draCategory: 'DRA-RM', geojsonGeometry: square(21.06, 52.147, 0.008),
    evaluation: { status: 'UNAVAILABLE_AUTHORIZATION', displayClass: 'RED', isObstacle: true, reasons: ['Consent.'] },
  }),
  Zone({
    id: 'TEST-U-EAST', name: 'TEST east (Wesoła)', draCategory: 'DRA-U', geojsonGeometry: square(21.215, 52.238, 0.008),
    evaluation: { status: 'UNAVAILABLE_USPACE', displayClass: 'ORANGE', isObstacle: true, reasons: ['U-space.'] },
  }),
  Zone({
    id: 'TEST-R-WEST', name: 'TEST west (Bemowo), two parts with a hole', draCategory: 'DRA-R',
    geojsonGeometry: {
      type: 'MultiPolygon',
      coordinates: [
        [
          [[20.90, 52.23], [20.92, 52.23], [20.92, 52.24], [20.90, 52.24], [20.90, 52.23]],
          [[20.905, 52.233], [20.915, 52.233], [20.915, 52.237], [20.905, 52.237], [20.905, 52.233]],
        ],
        [[[20.93, 52.22], [20.94, 52.22], [20.94, 52.225], [20.93, 52.225], [20.93, 52.22]]],
      ],
    },
    evaluation: { status: 'UNAVAILABLE_AUTHORIZATION', displayClass: 'RED', isObstacle: true, reasons: ['Consent.'] },
  }),
];

export const DIAGNOSTICS: AirspaceDiagnostics = {
  source: AIRSPACE_SOURCE,
  flightContext: { flightAltitudeMeters: 80, at: '2026-10-17T12:00:00Z' },
  completeness: PARTIAL_COMPLETENESS,
  totals: {
    features: 11, byGroup: { P: 2, R: 5, T: 1, U: 1, I: 1, UNKNOWN: 1, PLANNING: 0 },
    blocked: 2, conditional: 2, technical: 1, information: 1, unverified: 1, inactive: 4, obstacles: 6,
  },
  districts: [
    { name: 'Śródmieście', teryt: '146514_8', areaCoveredPct: 71.9, status: 'PARTIAL', zoneCount: 11, obstacleCount: 6,
      zoneIds: ['-P-SEJM'], note: 'Only partly covered.' },
    { name: 'Ursynów', teryt: '146508_8', areaCoveredPct: 0, status: 'UNAVAILABLE', zoneCount: 0, obstacleCount: 0,
      zoneIds: [], note: 'Not covered: zones here are UNKNOWN (not absent).' },
  ],
  zonesOutsideCity: [],
  duplicatesRemoved: 0,
  failedRequests: [],
  warnings: ['13 of 18 districts are not covered by the airspace dataset: Ursynów, …'],
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
    routeObjective: ({ FASTEST: 'FASTEST', SHORTEST: 'SHORTEST', BALANCED: 'CORRIDORS' } as const)[req.optimization],
    optimization: req.optimization,
    calculatedAt: '2026-10-18T14:05:00+02:00',
    flightAltitudeMeters: req.flightAltitudeMeters,
    droneProfileId: req.droneProfileId,
    weather: _WEATHER,
    routeStart: req.start,
    routeDestination: req.destination,
    coverage: {
      valid: true, area: 'City of Warsaw', startDistrict: 'Śródmieście', destinationDistrict: 'Praga-Południe',
      source: 'GUGiK PRG', airspaceOutsideExtentM: 0,
    },
    search: { attempts: 1, resolutionM: 25, windowKm2: 12.5, expansions: 4200, wholeCity: false, limitedBy: null, elapsedMs: 85, cached: false },
    zoneConflicts: [],
    airspace: AIRSPACE_SOURCE,
    planningVerificationStatus: 'SIMULATION_ONLY:  airspace (synthetic zones). Not a check of real-world flight legality.',
    warnings: [],
    dataSources: ['Airspace zones: SkyRoute  airspace (, version v1)'],
    computeMs: 80,
    ...over,
  };
}

/** Answers the app-wide startup requests that are not under test. */
/** Open Data Warsaw weather as served by GET /city-weather (two real station records). */
export const CITY_WEATHER = {
  status: 'LIVE' as const, message: 'Live data from the Open Data Warsaw API.', fetchedAt: '2026-10-18T08:10:30+00:00', ageS: 30,
  nextRefreshAt: '2026-10-19T08:10:30+00:00', refreshIntervalS: 86400,
  summary: { stations: 2, airTempC: 7.1, minAirTempC: 6.1, maxAirTempC: 8.1, humidityPct: 98, maxWindSpeedMs: 1.9,
    rainingStations: 1, latestMeasurement: '2026-10-18 10:10:00' },
  stations: [
    { name: 'Stacja Bielany', latitude: 52.29241, longitude: 20.97288, measuredAt: '2026-10-18 10:00:00', airTempC: 6.1,
      roadTempC: 10.6, humidityPct: 99.8, windSpeedMs: 0.5, windDirectionDeg: 225, precipitation: 0 },
    { name: 'Stacja Krakowska', latitude: 52.1752, longitude: 20.94439, measuredAt: '2026-10-18 10:10:00', airTempC: 8.1,
      roadTempC: 12.8, humidityPct: 96, windSpeedMs: 1.9, windDirectionDeg: 121, precipitation: 0.4 },
  ],
  source: 'Open Data Warsaw (dane.um.warszawa.pl): weather stations of the City Cleaning Authority (ZOM)',
  license: 'CC BY: Capital City of Warsaw',
  datasetUrl: 'https://dane.um.warszawa.pl/en/catalogue/db8077a8-d0e0-480a-af5d-040fb0ea176f',
};

export function flushStartup(http: HttpTestingController): void {
  for (const req of http.match(`${API_BASE_URL}/city-weather`)) req.flush(CITY_WEATHER);
  for (const req of http.match(`${API_BASE_URL}/layers`)) req.flush(LAYERS);
  for (const req of http.match(`${API_BASE_URL}/drone-profiles`)) req.flush(PROFILES);
  for (const req of http.match(`${API_BASE_URL}/scenarios`)) req.flush(SCENARIOS);
  for (const req of http.match(`${API_BASE_URL}/health`)) {
    req.flush({ status: 'ok', version: '0.3.0', mapCenter: [52.2297, 21.0122], coverageAvailable: true });
  }
  for (const req of http.match((r) => r.url.startsWith(`${API_BASE_URL}/weather`))) req.flush(_WEATHER);
  for (const req of http.match((r) => r.url.startsWith(`${API_BASE_URL}/zones`))) req.flush(ZONES);
  for (const req of http.match(`${API_BASE_URL}/map/warsaw-boundary`)) req.flush(BOUNDARY);
  for (const req of http.match(`${API_BASE_URL}/map/coverage`)) req.flush(COVERAGE);
  flushFleet(http);
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
