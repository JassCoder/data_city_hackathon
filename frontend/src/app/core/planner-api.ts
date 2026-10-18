import { Injectable, computed, inject } from '@angular/core';
import { HttpClient, httpResource } from '@angular/common/http';
import { Observable } from 'rxjs';
import { API_BASE_URL, safeValue } from './api';
import { DroneProfilesResponse, GeocodingResponse, RouteRequest, RouteResponse, ScenariosResponse, EntrancesResponse } from './models';

@Injectable({ providedIn: 'root' })
export class PlannerApi {
  private readonly http = inject(HttpClient);

  /** Drone profiles come from the backend only (single source of truth). */
  readonly profiles = httpResource<DroneProfilesResponse>(() => `${API_BASE_URL}/drone-profiles`);
  readonly profileList = computed(() => safeValue(this.profiles)?.profiles);

  /** Scenario configurations (no coordinates), defined once in the backend. */
  readonly scenarios = httpResource<ScenariosResponse>(() => `${API_BASE_URL}/scenarios`);
  readonly scenarioList = computed(() => safeValue(this.scenarios)?.scenarios);

  /** Explicit search only: the public Nominatim policy forbids autocomplete. */
  searchAddress(query: string): Observable<GeocodingResponse> {
    return this.http.get<GeocodingResponse>(`${API_BASE_URL}/geocoding/search`, { params: { query } });
  }

  entrances(latitude: number, longitude: number, flat?: string | null): Observable<EntrancesResponse> {
    const params: Record<string, string> = { latitude: String(latitude), longitude: String(longitude) };
    if (flat) params['flat'] = flat;
    return this.http.get<EntrancesResponse>(`${API_BASE_URL}/geocoding/entrances`, { params });
  }

  calculateRoute(request: RouteRequest): Observable<RouteResponse> {
    return this.http.post<RouteResponse>(`${API_BASE_URL}/routes/calculate`, request);
  }
}
