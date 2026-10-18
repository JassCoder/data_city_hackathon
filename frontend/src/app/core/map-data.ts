import { Injectable, computed } from '@angular/core';
import { httpResource } from '@angular/common/http';
import type { Feature, FeatureCollection, MultiPolygon, Polygon } from 'geojson';
import { API_BASE_URL, safeValue } from './api';
import { containsPoint } from './geo';
import { Coordinate } from './models';

type Area = Polygon | MultiPolygon;

export interface DistrictProps {
  teryt: string;
  name: string;
  officialName: string;
  areaKm2: number;
}

export interface BoundaryResponse {
  city: Feature<Area, DistrictProps>;
  districts: FeatureCollection<Area, DistrictProps>;
  bounds: [number, number, number, number]; // minLon, minLat, maxLon, maxLat
  source: { source: string; url: string; retrievedAt: string };
}

export interface CoverageResponse {
  status: 'AVAILABLE' | 'MISSING';
  message: string;
  area: string;
  geometry: Area | null;
  bounds: [number, number, number, number] | null;
  districts: string[];
  source: { source?: string; retrievedAt?: string };
  fallbackView: { center: [number, number]; zoom: number } | null;
  routing: {
    cellSizeM: number;
    gridCells: number;
    maxFineCells: number;
    maxExpansions: number;
    timeLimitS: number;
    /** Buffer added to blocked zones for routing: a configurable modelling assumption, not a legal rule. */
    airspaceSafetyMarginM?: number;
    buildingData: string | null;
    buildingDataFetchedAt: string | null;
  };
  airspace: { label: string; sourceType: string; extent: Area | null; extentLabel: string | null };
}

/** Shown only while the official boundary is unavailable. */
export const FALLBACK_VIEW = { center: [52.2297, 21.0122] as [number, number], zoom: 11 };

/** Official City of Warsaw boundary (GUGiK PRG) and routing coverage. */
@Injectable({ providedIn: 'root' })
export class MapDataService {
  readonly boundary = httpResource<BoundaryResponse>(() => `${API_BASE_URL}/map/warsaw-boundary`);
  readonly coverage = httpResource<CoverageResponse>(() => `${API_BASE_URL}/map/coverage`);

  readonly boundaryData = computed(() => safeValue(this.boundary));
  readonly coverageData = computed(() => safeValue(this.coverage));
  readonly cityGeometry = computed(() => this.boundaryData()?.city.geometry ?? this.coverageData()?.geometry ?? null);
  /** True once we know the boundary is missing (fallback view + routing disabled). */
  readonly boundaryMissing = computed(
    () => !!this.boundary.error() || this.coverageData()?.status === 'MISSING',
  );

  contains(c: Coordinate): boolean | undefined {
    const geom = this.cityGeometry();
    return geom ? containsPoint(geom, c) : undefined; // undefined = not known yet
  }

  districtOf(c: Coordinate): string | null {
    const d = this.boundaryData()?.districts.features.find((f) => containsPoint(f.geometry, c));
    return d?.properties.name ?? null;
  }
}

export const OUTSIDE_WARSAW =
  'Outside the supported area: this location is not inside the official City of Warsaw boundary ' +
  '(GUGiK PRG). Choose a location in one of the 18 districts.';
