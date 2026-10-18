import { Injectable, computed } from '@angular/core';
import { httpResource } from '@angular/common/http';
import type { Feature, FeatureCollection, MultiPolygon, Point, Polygon } from 'geojson';
import { API_BASE_URL, safeValue } from './api';

export type CorridorType = 'RIVER' | 'PARK';
export type HeightSource = 'osm_height' | 'levels_x3' | 'unknown';
export type StationType = 'HOSPITAL' | 'ROOFTOP' | 'PARK' | 'DEPOT';

export interface CorridorProps {
  id: string;
  corridor_type: CorridorType;
  name?: string | null;
}

export interface BuildingProps {
  id: string;
  height_m: number | null; // null = unknown (no OSM height or levels)
  height_source: HeightSource;
}

export interface StationProps {
  id: string;
  name: string;
  station_type: StationType;
  status: 'AVAILABLE' | 'BUSY' | 'OFFLINE';
  capacity: number;
  source: 'SYNTHETIC';
}

type Area = Polygon | MultiPolygon;

export interface BuildingStats {
  buildings: number;
  tallBuildings: number;
  unknownHeights: number;
  parks: number;
  tiles: number;
}

/** Citywide display layers. All building footprints come as tiles (MapComponent). */
export interface Layers {
  corridors: FeatureCollection<Area, CorridorProps>;
  tallBuildings: FeatureCollection<Area, BuildingProps>;
  stations: FeatureCollection<Point, StationProps>;
  buildingStats: Partial<BuildingStats>;
}

export type StationFeature = Feature<Point, StationProps>;

/** Height at or above which a building is drawn as "tall". */
export const TALL_BUILDING_M = 50;

/** Fetches /layers once (static OSM data + stations). Airspace zones: AirspaceService. */
@Injectable({ providedIn: 'root' })
export class LayersService {
  readonly resource = httpResource<Layers>(() => `${API_BASE_URL}/layers`);
  /** Loaded layers, or undefined while loading / on error. */
  readonly data = computed(() => safeValue(this.resource));

  readonly summary = computed(() => {
    const l = this.data();
    if (!l) return undefined;
    const s = l.buildingStats ?? {};
    return {
      parks: l.corridors.features.filter((f) => f.properties.corridor_type === 'PARK').length,
      buildings: s.buildings ?? 0,
      tallBuildings: s.tallBuildings ?? l.tallBuildings.features.length,
      unknownHeights: s.unknownHeights ?? 0,
      stations: l.stations.features.length,
    };
  });
}
