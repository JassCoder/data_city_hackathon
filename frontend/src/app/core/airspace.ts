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
  | 'UNKNOWN'
  /** Not a DRA type: SkyRoute planning constraint (OSM airport / military / government area). */
  | 'PLANNING';
export type DisplayClass = 'RED' | 'ORANGE' | 'YELLOW' | 'GRAY' | 'INACTIVE';
export type SourceType = 'OFFICIAL' | 'PERMITTED_SNAPSHOT' | 'SYNTHETIC' | 'NONE' | 'PLANNING_CONSTRAINT';
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

export type Completeness = 'COMPLETE' | 'PARTIAL' | 'NONE' | 'UNKNOWN';

/** How much of Warsaw the loaded zone dataset covers (its declared extent). */
export interface AirspaceCompleteness {
  status: Completeness;
  cityAreaCoveredPct: number | null;
  verificationStatus: string;
  message: string;
}

/** Official-airspace verification status (backend app/airspace/status.py). Synthetic zones never count. */
export interface AirspaceStatus {
  sourceState: 'OFFICIAL' | 'OFFICIAL_SNAPSHOT' | 'SYNTHETIC' | 'UNAVAILABLE' | 'STALE' | string;
  officialDataAvailable: boolean;
  officialCoveragePct: number | null;
  coverageBasis: string;
  ageDays: number | null;
  staleAfterDays: number;
  provider: string;
  label: string;
  message: string;
}

export interface ZonesResponse {
  source: AirspaceSource;
  flightContext: { flightAltitudeMeters: number; at: string };
  airspaceStatus?: AirspaceStatus | null;
  completeness?: AirspaceCompleteness | null;
  totalZones?: number | null;
  bbox?: number[] | null;
  zones: AirspaceZone[];
}

export type DistrictStatus = 'OFFICIAL_SNAPSHOT' | 'OFFICIAL' | 'SYNTHETIC' | 'PARTIAL' | 'UNAVAILABLE';

export interface DistrictCoverage {
  name: string;
  teryt: string;
  areaCoveredPct: number;
  status: DistrictStatus;
  zoneCount: number;
  obstacleCount: number;
  zoneIds: string[];
  note: string;
}

/** GET /zones/diagnostics */
export interface AirspaceDiagnostics {
  source: AirspaceSource;
  flightContext: { flightAltitudeMeters: number; at: string };
  completeness: AirspaceCompleteness;
  totals: {
    features: number;
    byGroup: Record<CategoryGroup, number>;
    blocked: number;
    conditional: number;
    technical: number;
    information: number;
    unverified: number;
    inactive: number;
    obstacles: number;
  };
  districts: DistrictCoverage[];
  zonesOutsideCity: string[];
  duplicatesRemoved: number;
  failedRequests: string[];
  warnings: string[];
}

/** Official aeronautical data follows the 28-day AIRAC cycle: older source data is flagged. */
export const STALE_AFTER_DAYS = 28;

export function dataAgeDays(timestamp: string | null | undefined, now = Date.now()): number | null {
  if (!timestamp) return null;
  const t = Date.parse(timestamp);
  return Number.isNaN(t) ? null : Math.max(0, Math.floor((now - t) / 86_400_000));
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
export type CategoryGroup = 'P' | 'R' | 'T' | 'U' | 'I' | 'UNKNOWN' | 'PLANNING';
export const CATEGORY_GROUPS: { key: CategoryGroup; label: string }[] = [
  { key: 'P', label: 'DRA-P prohibited' },
  { key: 'R', label: 'DRA-R / RH / RM / RL restricted' },
  { key: 'T', label: 'DRA-T technical' },
  { key: 'U', label: 'DRA-U U-space' },
  { key: 'I', label: 'DRA-I information' },
  { key: 'UNKNOWN', label: 'Unknown category' },
  { key: 'PLANNING', label: 'Planning constraints: airports, military, government (OSM, not official)' },
];

export function categoryGroup(c: DraCategory): CategoryGroup {
  if (c === 'DRA-P') return 'P';
  if (c.startsWith('DRA-R')) return 'R';
  if (c === 'DRA-T') return 'T';
  if (c === 'DRA-U') return 'U';
  if (c === 'DRA-I') return 'I';
  if (c === 'PLANNING') return 'PLANNING';
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
  OFFICIAL: 'Official',
  PERMITTED_SNAPSHOT: 'Official snapshot (permitted file)',
  SYNTHETIC: 'Synthetic zones, not official',
  NONE: 'No airspace data loaded',
  PLANNING_CONSTRAINT: 'SkyRoute planning constraint (OSM), not official',
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

  /** The whole city is loaded at once (never per viewport), evaluated for altitude and planned time. */
  /** Evaluated for "now": the backend picks the time (Europe/Warsaw), as for routes. */
  private readonly query = computed(() => `altitudeM=${this.altitude()}`);

  readonly resource = httpResource<ZonesResponse>(() => `${API_BASE_URL}/zones?${this.query()}`);
  readonly loading = computed(() => this.resource.isLoading());
  /** Failed zone requests in this session (shown in the diagnostics). */
  readonly failedRequests = signal(0);

  /** Coverage diagnostics are only fetched while the debug panel is open. */
  readonly diagnosticsOpen = signal(false);
  readonly diagnostics = httpResource<AirspaceDiagnostics>(() =>
    this.diagnosticsOpen() ? `${API_BASE_URL}/zones/diagnostics?${this.query()}` : undefined,
  );
  readonly diagnosticsData = computed(() => safeValue(this.diagnostics));

  readonly filters = signal<Record<CategoryGroup, boolean>>({ P: true, R: true, T: true, U: true, I: true, UNKNOWN: true, PLANNING: true });
  /** Zone to focus on the map (fit + popup). */
  readonly focusZoneId = signal<string | null>(null);

  /** Latest evaluation; the previous one stays visible while a new altitude loads. */
  readonly response = linkedSignal<ZonesResponse | undefined, ZonesResponse | undefined>({
    source: () => safeValue(this.resource),
    computation: (value, prev) => value ?? (this.resource.isLoading() ? prev?.value : undefined),
  });
  readonly source = computed(() => this.response()?.source);
  readonly completeness = computed(() => this.response()?.completeness ?? null);
  readonly evaluatedFor = computed(() => this.response()?.flightContext);
  readonly airspaceStatus = computed(() => this.response()?.airspaceStatus ?? null);
  /** Age of the source data; unknown or older than one AIRAC cycle counts as stale. */
  readonly freshness = computed(() => {
    const src = this.source();
    if (!src) return null;
    const ageDays = dataAgeDays(src.sourceTimestamp);
    return { ageDays, stale: ageDays === null || ageDays > STALE_AFTER_DAYS };
  });
  readonly zones = computed(() => this.response()?.zones ?? []);
  readonly visibleZones = computed(() => {
    const f = this.filters();
    return this.zones().filter((z) => f[categoryGroup(z.draCategory)]);
  });
  readonly counts = computed(() => {
    const out: Record<CategoryGroup, number> = { P: 0, R: 0, T: 0, U: 0, I: 0, UNKNOWN: 0, PLANNING: 0 };
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
    effect(() => {
      if (this.resource.error()) untracked(() => this.failedRequests.update((n) => n + 1));
    });
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
