import { Injectable, computed, effect, inject, linkedSignal, signal, untracked } from '@angular/core';
import { httpResource } from '@angular/common/http';
import { API_BASE_URL, safeValue } from './api';
import { FleetStore } from './fleet.store';
import { shownResponse } from './fleet';
import { ALTITUDE, isValidAltitude } from './models';

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
 * Loads GET /zones evaluated for the altitude of the drone being edited (else the
 * selected one, else the default). Filters only change what the map shows;
 * routing always uses every loaded zone.
 */
@Injectable({ providedIn: 'root' })
export class AirspaceService {
  private readonly fleet = inject(FleetStore);

  /** Last valid altitude; an invalid entry keeps the previous evaluation. */
  readonly altitude = linkedSignal<number | undefined, number>({
    source: () => this.fleet.focusDrone()?.altitude,
    computation: (alt, prev) =>
      alt !== undefined && isValidAltitude(alt) ? alt : (prev?.value ?? ALTITUDE.default),
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

  /** Zones that block the selected drone's failed result (points inside, or the blocked direct line). */
  readonly highlightZoneIds = computed(() => {
    const d = this.fleet.selected();
    const resp = d ? shownResponse(d) : undefined;
    if (!resp || resp.status === 'OK') return [];
    return resp.zoneConflicts
      .filter((c) => c.relation === 'START_INSIDE' || c.relation === 'DESTINATION_INSIDE' || c.relation === 'DIRECT_LINE_BLOCKED')
      .map((c) => c.zoneId);
  });

  constructor() {
    // A new dataset version invalidates routes calculated on the old one.
    effect(() => {
      const v = this.source()?.datasetVersion;
      if (v) untracked(() => this.fleet.onAirspaceVersion(v));
    });
    // A route computed on a newer dataset than the one displayed: refresh the map.
    effect(() => {
      const shown = untracked(() => this.source()?.datasetVersion);
      const newer = this.fleet
        .drones()
        .some((d) => d.route.phase === 'ready' && shown && d.route.response.airspace?.datasetVersion !== shown);
      if (newer) untracked(() => this.resource.reload());
    });
    // A point rejected inside a zone: show that zone.
    effect(() => {
      const d = this.fleet.selected();
      const resp = d?.route.phase === 'ready' ? d.route.response : undefined;
      const inside = resp?.zoneConflicts.find((c) => c.relation === 'START_INSIDE' || c.relation === 'DESTINATION_INSIDE');
      if (inside) untracked(() => this.focusZoneId.set(inside.zoneId));
    });
  }

  toggleFilter(group: CategoryGroup, on: boolean): void {
    this.filters.update((f) => ({ ...f, [group]: on }));
  }
}
