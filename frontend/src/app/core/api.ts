import { Resource } from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { Coordinate } from './models';

export const API_BASE_URL = 'http://localhost:8000/api/v1';

export interface DemoBbox {
  minLon: number;
  minLat: number;
  maxLon: number;
  maxLat: number;
}

export interface Health {
  status: string;
  version: string;
  mapCenter: [number, number]; // [lat, lon]
  demoBbox: DemoBbox;
}

/** A resource's value, or undefined while loading or in error (`value()` throws on error). */
export function safeValue<T>(r: Resource<T | undefined>): T | undefined {
  return r.hasValue() ? r.value() : undefined;
}

export function inBbox(c: Coordinate, b: DemoBbox): boolean {
  return c.latitude >= b.minLat && c.latitude <= b.maxLat && c.longitude >= b.minLon && c.longitude <= b.maxLon;
}

export function coverageMessage(b: DemoBbox): string {
  return (
    `Outside the supported routing area (Śródmieście, Powiśle and the Vistula: ` +
    `lat ${b.minLat.toFixed(3)}–${b.maxLat.toFixed(3)}, lon ${b.minLon.toFixed(3)}–${b.maxLon.toFixed(3)}). ` +
    `Choose a location inside the dashed demo area.`
  );
}

/** Human-readable message for an HTTP failure; prefers the backend's `detail`. */
export function describeHttpError(err: unknown, fallback: string): string {
  if (err instanceof HttpErrorResponse) {
    if (err.status === 0) return 'Backend unreachable. Is the API server running on port 8000?';
    const detail = err.error?.detail;
    if (typeof detail === 'string') return detail;
    if (Array.isArray(detail) && detail.length) {
      return 'Invalid request: ' + detail.map((d: { msg?: string }) => d.msg).join('; ');
    }
    return `${fallback} (HTTP ${err.status}).`;
  }
  return fallback;
}
