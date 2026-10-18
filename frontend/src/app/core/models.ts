/** Wire models for the planning API (camelCase, mirrors backend/app/schemas/planning.py). */

import type { AirspaceSource, ZoneConflict } from './airspace';
import { SETTINGS } from './settings';

export type FlightMode = 'NORMAL' | 'EMERGENCY';
export type WeatherMode = 'DEMO' | 'LIVE';
/** What the route minimises (hard restrictions always apply). */
export type RouteObjective = 'CORRIDORS' | 'SHORTEST' | 'FASTEST' | 'SAFEST' | 'LOWEST_ENERGY';
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
  /** Modes a request may choose explicitly with this scenario (first = default). */
  allowedModes?: FlightMode[];
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

export type LocationSource = 'SEARCH' | 'MAP_CLICK' | 'MAP_DRAG' | 'MANUAL' | 'SUGGESTION' | 'DEMO';

/** A start/destination chosen by the user. Only in-coverage points are ever selected. */
export interface SelectedLocation {
  coordinate: Coordinate;
  label: string;
  source: LocationSource;
}

export interface RouteRequest {
  start: Coordinate;
  destination: Coordinate;
  mode: FlightMode;
  flightAltitudeMeters: number;
  droneProfileId: string;
  weatherMode: WeatherMode;
  /** Omitted when a scenario sets it (an explicit contradiction is a 422). */
  routeObjective?: RouteObjective;
  scenario?: ScenarioId | null;
  payloadKg?: number;
}

export type RouteStatus =
  | 'OK'
  | 'NO_ROUTE'
  | 'OUTSIDE_COVERAGE'
  | 'START_BLOCKED'
  | 'DESTINATION_BLOCKED'
  | 'BLOCKED_WEATHER'
  | 'SEARCH_LIMIT'
  | 'COVERAGE_UNAVAILABLE'
  | 'INSUFFICIENT_BATTERY'
  | 'RISK_DATA_UNAVAILABLE';

export interface WeatherInfo {
  mode: WeatherMode;
  source: 'DEMO' | 'OPEN_METEO' | 'DEMO_FALLBACK';
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

export type CostTerm =
  | 'population'
  | 'obstacle_proximity'
  | 'noise'
  | 'emergency_landing'
  | 'sensitive_areas'
  | 'energy'
  | 'time';

/** Multi-criteria cost of a route (reported for every objective; SAFEST minimises it). */
export interface CostBreakdown {
  totalCost: number;
  lengthM: number;
  terms: { term: CostTerm; weight: number; mean: number; cost: number }[];
  /** Whole flight: cruise + take-off climb + landing descent. */
  energyWh: number;
  verticalEnergyWh?: number;
  batteryUsableWh: number;
  payloadKg: number;
  flightTimeS: number;
  /** Integral of the estimated density along the route: people/ha x km. */
  populationExposure: number;
  maxDensityPerHa: number;
  localHour: number;
  note: string;
}

export interface RouteResponse {
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
  costBreakdown: CostBreakdown | null;
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
}

export interface GeocodingResponse {
  query: string;
  results: GeocodeResult[];
  provider: string;
  attribution: string;
  cached: boolean;
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
  cruisePowerW: number;
  payloadPowerWPerKg: number;
  batteryWh: number;
  source: 'DEMO';
}

export interface DroneProfilesResponse {
  profiles: DroneProfile[];
  disclaimer: string;
}

export const ALTITUDE = SETTINGS.altitude;

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
