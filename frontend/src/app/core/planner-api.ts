import { Injectable, computed, inject } from '@angular/core';
import { HttpClient, httpResource } from '@angular/common/http';
import { Observable } from 'rxjs';
import { API_BASE_URL, safeValue } from './api';
import { DroneProfilesResponse, GeocodingResponse, RouteRequest, RouteResponse } from './models';

@Injectable({ providedIn: 'root' })
export class PlannerApi {
  private readonly http = inject(HttpClient);

  /** Drone profiles come from the backend only (single source of truth). */
  readonly profiles = httpResource<DroneProfilesResponse>(() => `${API_BASE_URL}/drone-profiles`);
  readonly profileList = computed(() => safeValue(this.profiles)?.profiles);

  /** Explicit search only: the public Nominatim policy forbids autocomplete. */
  searchAddress(query: string): Observable<GeocodingResponse> {
    return this.http.get<GeocodingResponse>(`${API_BASE_URL}/geocoding/search`, { params: { query } });
  }

  calculateRoute(request: RouteRequest): Observable<RouteResponse> {
    return this.http.post<RouteResponse>(`${API_BASE_URL}/routes/calculate`, request);
  }
}
