/** Wire models for the planning API (camelCase, mirrors backend/app/schemas/planning.py). */

import type { AirspaceSource, ZoneConflict } from './airspace';

export type FlightMode = 'NORMAL' | 'EMERGENCY';
export type WeatherMode = 'DEMO' | 'LIVE';
export type PointRole = 'start' | 'destination';

export interface Coordinate {
  latitude: number;
  longitude: number;
}

export type LocationSource = 'SEARCH' | 'MAP_CLICK' | 'MANUAL' | 'DEMO';

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
}

export type RouteStatus =
  | 'OK'
  | 'NO_ROUTE'
  | 'OUTSIDE_COVERAGE'
  | 'START_BLOCKED'
  | 'DESTINATION_BLOCKED'
  | 'BLOCKED_WEATHER';

export interface WeatherInfo {
  mode: WeatherMode;
  source: 'DEMO' | 'OPEN_METEO' | 'DEMO_FALLBACK';
  liveAvailable: boolean | null;
  windSpeedKmh: number;
  windDirectionDeg: number;
  windGustKmh: number | null;
  observedAt: string | null;
  message: string;
}

export interface RouteResponse {
  status: RouteStatus;
  message: string;
  geometry: { type: 'LineString'; coordinates: [number, number][] } | null;
  distanceM: number | null;
  etaS: number | null;
  mode: FlightMode;
  flightAltitudeMeters: number;
  droneProfileId: string;
  weather: WeatherInfo;
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
  source: 'DEMO';
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
