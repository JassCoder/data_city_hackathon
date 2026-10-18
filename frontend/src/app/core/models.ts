/** Wire models for the planning API (camelCase, mirrors backend/app/schemas/planning.py). */

import type { AirspaceSource, ZoneConflict } from './airspace';

export type FlightMode = 'NORMAL' | 'EMERGENCY';
export type WeatherMode = 'SAMPLE' | 'LIVE';
/** What the route minimises (hard restrictions always apply). */
export type RouteObjective = 'CORRIDORS' | 'SHORTEST' | 'FASTEST';
/** Routing scenario: configuration only. It never carries or changes Point A/B. */
export type ScenarioId = 'NORMAL' | 'BLOOD_DELIVERY' | 'AED_DELIVERY' | 'AVOID_PROHIBITED_ZONE' | 'EMERGENCY';
export type OptimizationGoal = 'PREFER_SAFE_CORRIDORS' | 'MINIMIZE_DISTANCE' | 'MINIMIZE_ETA';

export interface ScenarioConfig {
  id: ScenarioId;
  displayName: string;
  description: string;
  optimizationGoal: OptimizationGoal;
  routeObjective: RouteObjective;
  mode: FlightMode;
  respectRestrictedZones: boolean;
  useWeather: boolean;
  recommendedProfileId: string | null;
}

export interface ScenariosResponse {
  scenarios: ScenarioConfig[];
  note: string;
}
export type PointRole = 'start' | 'destination';

export interface Coordinate {
  latitude: number;
  longitude: number;
}

/** FACILITY = explicitly chosen from a hospital/restaurant/depot popup or the fleet panel;
 * ENTRANCE = a mapped OSM building entrance chosen after an address search. */
export type LocationSource = 'SEARCH' | 'MAP_CLICK' | 'MANUAL' | 'FIXTURE' | 'FACILITY' | 'ENTRANCE';

/** ADDRESS = building/address matched; STREET / PLACE = approximations. */
export type GeocodeAccuracy = 'ADDRESS' | 'NEARBY_BUILDING' | 'STREET' | 'PLACE' | 'COORDINATES';

/** UI name of the route objective (BALANCED = safe corridors). Hard constraints apply to all. */
export type Optimization = 'FASTEST' | 'SHORTEST' | 'BALANCED';
export const OPTIMIZATION_OF: Record<RouteObjective, Optimization> = {
  FASTEST: 'FASTEST',
  SHORTEST: 'SHORTEST',
  CORRIDORS: 'BALANCED',
};

/** A start/destination chosen by the user. Only in-coverage points are ever selected. */
export interface SelectedLocation {
  coordinate: Coordinate;
  label: string;
  source: LocationSource;
  accuracy?: GeocodeAccuracy | null;
  /** Flat/apartment as entered: kept with the address, never geolocated. */
  flat?: string | null;
}

export interface RouteRequest {
  start: Coordinate;
  destination: Coordinate;
  mode: FlightMode;
  flightAltitudeMeters: number;
  droneProfileId: string;
  weatherMode: WeatherMode;
  /** FASTEST | SHORTEST | BALANCED; the backend maps it to its route objective. */
  optimization: Optimization;
  /** Not set by the planner UI (scenarios were removed from it); kept for API compatibility. */
  scenario?: ScenarioId | null;
}

export type RouteStatus =
  | 'OK'
  | 'NO_ROUTE'
  | 'OUTSIDE_COVERAGE'
  | 'START_BLOCKED'
  | 'DESTINATION_BLOCKED'
  | 'BLOCKED_WEATHER'
  | 'SEARCH_LIMIT'
  | 'COVERAGE_UNAVAILABLE';

export interface WeatherInfo {
  mode: WeatherMode;
  source: 'SAMPLE' | 'OPEN_METEO' | 'CACHED' | 'SAMPLE_FALLBACK';
  liveAvailable: boolean | null;
  windSpeedKmh: number;
  windDirectionDeg: number;
  windGustKmh: number | null;
  observedAt: string | null;
  altitudeM?: number | null;
  samples?: { latitude: number; longitude: number; windSpeedKmh: number; windDirectionDeg: number; windGustKmh: number | null }[];
  message: string;
}

export interface CoverageCheck {
  valid: boolean;
  area: string;
  startDistrict: string | null;
  destinationDistrict: string | null;
  source: string;
  airspaceOutsideExtentM: number;
}

export interface SearchInfo {
  attempts: number;
  resolutionM: number;
  windowKm2: number;
  expansions: number;
  wholeCity: boolean;
  limitedBy: string | null;
  elapsedMs: number;
  cached: boolean;
}

export interface RouteResponse {
  optimization?: Optimization;
  /** Effective calculation time chosen by the backend (Europe/Warsaw). */
  calculatedAt?: string | null;
  status: RouteStatus;
  message: string;
  /** Echo of the submitted endpoints (never replaced by a scenario). */
  start: Coordinate;
  destination: Coordinate;
  scenario: ScenarioId | null;
  scenarioDisplayName: string;
  optimizationGoal: OptimizationGoal | null;
  geometry: { type: 'LineString'; coordinates: [number, number][] } | null;
  distanceM: number | null;
  etaS: number | null;
  mode: FlightMode;
  routeObjective: RouteObjective;
  flightAltitudeMeters: number;
  droneProfileId: string;
  weather: WeatherInfo;
  coverage: CoverageCheck;
  search: SearchInfo | null;
  routeStart: Coordinate | null;
  routeDestination: Coordinate | null;
  zoneConflicts: ZoneConflict[];
  airspace: AirspaceSource;
  planningVerificationStatus: string;
  warnings: string[];
  dataSources: string[];
  computeMs: number;
}

export interface GeocodeResult {
  displayName: string;
  latitude: number;
  longitude: number;
  placeId: string | null;
  category: string | null;
  source: string;
  inCoverage: boolean;
  accuracy?: GeocodeAccuracy | null;
  street?: string | null;
  houseNumber?: string | null;
  postcode?: string | null;
  flat?: string | null;
  flatResolved?: boolean | null;
}

export interface GeocodingResponse {
  query: string;
  results: GeocodeResult[];
  provider: string;
  attribution: string;
  cached: boolean;
  parsed?: { street: string | null; number: string | null; flat: string | null; city: string | null; isCoordinates: boolean } | null;
  note?: string | null;
}

export interface DroneProfile {
  id: string;
  name: string;
  description: string;
  cruiseSpeedMps: number;
  maxWindKmh: number;
  verticalClearanceM: number;
  maxRangeKm: number;
  maxPayloadKg: number;
  source: 'SYNTHETIC';
}

export interface DroneProfilesResponse {
  profiles: DroneProfile[];
  disclaimer: string;
}

export const ALTITUDE = { min: 20, max: 120, step: 5, default: 80 } as const;

export function isValidAltitude(v: number): boolean {
  return (
    Number.isFinite(v) && v >= ALTITUDE.min && v <= ALTITUDE.max && (v - ALTITUDE.min) % ALTITUDE.step === 0
  );
}

export function isValidCoordinate(c: Partial<Coordinate> | null | undefined): c is Coordinate {
  return (
    !!c &&
    typeof c.latitude === 'number' &&
    typeof c.longitude === 'number' &&
    Number.isFinite(c.latitude) &&
    Number.isFinite(c.longitude) &&
    Math.abs(c.latitude) <= 90 &&
    Math.abs(c.longitude) <= 180
  );
}

/** GET /geocoding/entrances: mapped OSM entrances of the building at a point. */
export interface Entrance {
  id: string;
  latitude: number;
  longitude: number;
  entrance: string | null;
  ref: string | null;
  flats: string | null;
  housenumber: string | null;
  street: string | null;
  wheelchair: string | null;
  /** True only when the entrance's addr:flats tag covers the entered flat. */
  matchesFlat: boolean;
}

export interface EntrancesResponse {
  building: { id: string; heightM: number | null; heightSource: string } | null;
  entrances: Entrance[];
  note: string;
  source: string | null;
}
