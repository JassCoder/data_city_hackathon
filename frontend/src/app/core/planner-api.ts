import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { API_BASE_URL } from './api';
import { GeocodingResponse, RouteRequest, RouteResponse } from './models';

@Injectable({ providedIn: 'root' })
export class PlannerApi {
  private readonly http = inject(HttpClient);

  /** Explicit search only: the public Nominatim policy forbids autocomplete. */
  searchAddress(query: string): Observable<GeocodingResponse> {
    return this.http.get<GeocodingResponse>(`${API_BASE_URL}/geocoding/search`, { params: { query } });
  }

  calculateRoute(request: RouteRequest): Observable<RouteResponse> {
    return this.http.post<RouteResponse>(`${API_BASE_URL}/routes/calculate`, request);
  }
}
