import { Injectable, computed } from '@angular/core';
import { httpResource } from '@angular/common/http';
import { API_BASE_URL, Health, safeValue } from './api';

export type BackendStatus = 'connecting' | 'online' | 'offline';

/** GET /health: backend reachability and whether the Safest risk layers are loaded. */
@Injectable({ providedIn: 'root' })
export class HealthService {
  readonly resource = httpResource<Health>(() => `${API_BASE_URL}/health`);
  readonly info = computed(() => safeValue(this.resource));
  readonly status = computed<BackendStatus>(() => {
    if (this.resource.isLoading()) return 'connecting';
    if (this.resource.error()) return 'offline';
    return this.info()?.status === 'ok' ? 'online' : 'offline';
  });
  /** False only when the backend says so (unknown while loading). */
  readonly riskDataMissing = computed(() => this.info()?.riskDataAvailable === false);
}
