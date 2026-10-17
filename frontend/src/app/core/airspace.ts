import { Injectable, computed, effect, inject, linkedSignal, signal, untracked } from '@angular/core';
import { httpResource } from '@angular/common/http';
import { API_BASE_URL, safeValue } from './api';
import { ALTITUDE } from './models';
import { PlannerStore } from './planner.store';

/** Wire models for GET /zones (mirrors backend/app/airspace/models.py). */

export type DraCategory =
  | 'DRA-P'
  | 'DRA-R'
  | 'DRA-RH'
  | 'DRA-RM'
  | 'DRA-RL'
  | 'DRA-T'
  | 'DRA-U'
  | 'DRA-I'
  | 'UNKNOWN';
export type DisplayClass = 'RED' | 'ORANGE' | 'YELLOW' | 'GRAY' | 'INACTIVE';
export type SourceType = 'OFFICIAL' | 'PERMITTED_SNAPSHOT' | 'DEMO';
export type EvaluationStatus =
  | 'BLOCKED'
  | 'UNAVAILABLE_AUTHORIZATION'
  | 'UNAVAILABLE_TECHNICAL'
  | 'UNAVAILABLE_USPACE'
  | 'UNVERIFIED'
  | 'INFORMATION'
  | 'NOT_ACTIVE_TIME'
  | 'NOT_APPLICABLE_ALTITUDE';

export interface ZoneEvaluation {
  status: EvaluationStatus;
  displayClass: DisplayClass;
  isObstacle: boolean;
  reasons: string[];
}

export interface AirspaceZone {
  id: string;
  name: string;
  draCategory: DraCategory;
  restrictionType: string;
  geojsonGeometry: GeoJSON.Polygon | GeoJSON.MultiPolygon;
  circle: { center: [number, number]; radiusM: number } | null;
  source: string | null;
  sourceType: SourceType;
  sourceTimestamp: string | null;
  validityStart: string | null;
  validityEnd: string | null;
  lowerAltitude: number | null;
  upperAltitude: number | null;
  altitudeReference: 'AGL' | 'AMSL' | 'UNKNOWN';
  authorizationRequired: boolean | null;
  operationalConditions: string | null;
  verificationStatus: string;
  evaluation: ZoneEvaluation;
}

export interface AirspaceSource {
  provider: string;
  sourceType: SourceType;
  label: string;
  sourceTimestamp: string | null;
  datasetVersion: string;
  loadedAt: string;
  disclaimer: string;
  /** Area the zone dataset covers (null = whole routing area). */
  extent?: GeoJSON.Polygon | GeoJSON.MultiPolygon | null;
  extentLabel?: string | null;
}

export interface ZonesResponse {
  source: AirspaceSource;
  flightContext: { flightAltitudeMeters: number; at: string };
  zones: AirspaceZone[];
}

export interface ZoneConflict {
  zoneId: string;
  name: string;
  draCategory: DraCategory;
  displayClass: DisplayClass;
  evaluationStatus: EvaluationStatus;
  relation: 'START_INSIDE' | 'DESTINATION_INSIDE' | 'DIRECT_LINE_BLOCKED' | 'ROUTE_CROSSES_INFO' | 'NEAR_ROUTE';
  message: string;
}

/** Filter groups for the DRA category checkboxes. */
export type CategoryGroup = 'P' | 'R' | 'T' | 'U' | 'I' | 'UNKNOWN';
export const CATEGORY_GROUPS: { key: CategoryGroup; label: string }[] = [
  { key: 'P', label: 'DRA-P prohibited' },
  { key: 'R', label: 'DRA-R / RH / RM / RL restricted' },
  { key: 'T', label: 'DRA-T technical' },
  { key: 'U', label: 'DRA-U U-space' },
  { key: 'I', label: 'DRA-I information' },
  { key: 'UNKNOWN', label: 'Unknown category' },
];

export function categoryGroup(c: DraCategory): CategoryGroup {
  if (c === 'DRA-P') return 'P';
  if (c.startsWith('DRA-R')) return 'R';
  if (c === 'DRA-T') return 'T';
  if (c === 'DRA-U') return 'U';
  if (c === 'DRA-I') return 'I';
  return 'UNKNOWN';
}

export const STATUS_LABEL: Record<EvaluationStatus, string> = {
  BLOCKED: 'Blocked: prohibited for the planned operation',
  UNAVAILABLE_AUTHORIZATION: 'Unavailable for this route: authorization required',
  UNAVAILABLE_TECHNICAL: 'Unavailable for this route: technical requirements not verified',
  UNAVAILABLE_USPACE: 'Unavailable for this route: U-space services not verified',
  UNVERIFIED: 'Unavailable: insufficient verification',
  INFORMATION: 'Information: warning only',
  NOT_ACTIVE_TIME: 'Not active now (outside validity period)',
  NOT_APPLICABLE_ALTITUDE: 'Not applicable at the selected altitude',
};

export const SOURCE_LABEL: Record<SourceType, string> = {
  DEMO: 'DEMO: synthetic, not official',
  PERMITTED_SNAPSHOT: 'Official snapshot (permitted file)',
  OFFICIAL: 'Official',
};

/**
 * Loads GET /zones evaluated for the planner's current altitude. Filters only
 * change what the map shows; routing always uses every loaded zone.
 */
@Injectable({ providedIn: 'root' })
export class AirspaceService {
  private readonly store = inject(PlannerStore);

  /** Last valid altitude; an invalid entry keeps the previous evaluation. */
  private readonly altitude = linkedSignal<{ value: number; valid: boolean }, number>({
    source: () => ({ value: this.store.altitude(), valid: this.store.altitudeValid() }),
    computation: (src, prev) => (src.valid ? src.value : (prev?.value ?? ALTITUDE.default)),
  });

  readonly resource = httpResource<ZonesResponse>(() => `${API_BASE_URL}/zones?altitudeM=${this.altitude()}`);

  readonly filters = signal<Record<CategoryGroup, boolean>>({ P: true, R: true, T: true, U: true, I: true, UNKNOWN: true });
  /** Zone to focus on the map (fit + popup). */
  readonly focusZoneId = signal<string | null>(null);

  /** Latest evaluation; the previous one stays visible while a new altitude loads. */
  readonly response = linkedSignal<ZonesResponse | undefined, ZonesResponse | undefined>({
    source: () => safeValue(this.resource),
    computation: (value, prev) => value ?? (this.resource.isLoading() ? prev?.value : undefined),
  });
  readonly source = computed(() => this.response()?.source);
  readonly zones = computed(() => this.response()?.zones ?? []);
  readonly visibleZones = computed(() => {
    const f = this.filters();
    return this.zones().filter((z) => f[categoryGroup(z.draCategory)]);
  });
  readonly counts = computed(() => {
    const out: Record<CategoryGroup, number> = { P: 0, R: 0, T: 0, U: 0, I: 0, UNKNOWN: 0 };
    for (const z of this.zones()) out[categoryGroup(z.draCategory)]++;
    return out;
  });

  /** Zones containing a rejected start/destination: highlighted on the map. */
  readonly highlightZoneIds = computed(() => {
    const r = this.store.route();
    const resp = r.phase === 'ready' || r.phase === 'stale' ? r.response : undefined;
    return (resp?.zoneConflicts ?? [])
      .filter((c) => c.relation === 'START_INSIDE' || c.relation === 'DESTINATION_INSIDE')
      .map((c) => c.zoneId);
  });

  constructor() {
    // A new dataset version invalidates routes calculated on the old one.
    effect(() => {
      const v = this.source()?.datasetVersion;
      if (v) untracked(() => this.store.onAirspaceVersion(v));
    });
    // A route computed on a newer dataset than the one displayed: refresh the map.
    effect(() => {
      const r = this.store.route();
      const routeVersion = r.phase === 'ready' ? r.response.airspace?.datasetVersion : undefined;
      const shown = untracked(() => this.source()?.datasetVersion);
      if (routeVersion && shown && routeVersion !== shown) untracked(() => this.resource.reload());
    });
    // Focus the conflicting zone when a point is rejected.
    effect(() => {
      const ids = this.highlightZoneIds();
      if (ids.length) untracked(() => this.focusZoneId.set(ids[0]));
    });
  }

  toggleFilter(group: CategoryGroup, on: boolean): void {
    this.filters.update((f) => ({ ...f, [group]: on }));
  }
}
