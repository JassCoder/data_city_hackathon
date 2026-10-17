import { Injectable, computed } from '@angular/core';
import { httpResource } from '@angular/common/http';
import type { Feature, FeatureCollection, MultiPolygon, Point, Polygon } from 'geojson';
import { API_BASE_URL, DemoBbox, safeValue } from './api';

export type CorridorType = 'RIVER' | 'PARK';
export type HeightSource = 'osm_height' | 'levels_x3' | 'default_15m';
export type StationType = 'HOSPITAL' | 'ROOFTOP' | 'PARK' | 'DEPOT';

export interface CorridorProps {
  id: string;
  corridor_type: CorridorType;
  name?: string | null;
}

export interface BuildingProps {
  id: string;
  height_m: number;
  height_source: HeightSource;
}

export interface StationProps {
  id: string;
  name: string;
  station_type: StationType;
  status: 'AVAILABLE' | 'BUSY' | 'OFFLINE';
  capacity: number;
  source: 'DEMO';
}

type Area = Polygon | MultiPolygon;

export interface Layers {
  bbox: DemoBbox;
  corridors: FeatureCollection<Area, CorridorProps>;
  buildings: FeatureCollection<Area, BuildingProps>;
  stations: FeatureCollection<Point, StationProps>;
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
    const count = <T>(items: T[], pred: (t: T) => boolean) => items.filter(pred).length;
    const corridors = l.corridors.features.map((f) => f.properties);
    const buildings = l.buildings.features.map((f) => f.properties);
    return {
      parks: count(corridors, (c) => c.corridor_type === 'PARK'),
      buildings: buildings.length,
      tallBuildings: count(buildings, (b) => b.height_m >= TALL_BUILDING_M),
      estimatedHeights: count(buildings, (b) => b.height_source === 'default_15m'),
      stations: l.stations.features.length,
    };
  });
}
