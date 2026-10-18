/** Small geometry helpers for the simulation view (pure). */

import { DronePose } from './interpolation';
import { SimState, SimStation } from './sim-models';

/** Approximate ground distance in metres (equirectangular; fine at city scale). */
export function metres(lon1: number, lat1: number, lon2: number, lat2: number): number {
  const k = Math.cos((((lat1 + lat2) / 2) * Math.PI) / 180);
  const dx = (lon2 - lon1) * 111_320 * k;
  const dy = (lat2 - lat1) * 110_540;
  return Math.hypot(dx, dy);
}

export type StationActivity = 'landing' | 'charging';

const ACTIVITY: Partial<Record<SimState, StationActivity>> = {
  LANDING: 'landing',
  EMERGENCY_LANDING: 'landing',
  CHARGING: 'charging',
};

export interface BusyStation {
  activity: StationActivity;
  /** Indexes (into the poses) of the drones landing or charging there. */
  drones: number[];
}

/**
 * Stations where a drone is landing or charging right now (within the engine's position
 * tolerance). Landing wins over charging when both happen at one station.
 */
export function busyStations(poses: readonly DronePose[], stations: readonly SimStation[], toleranceM: number): Map<string, BusyStation> {
  const out = new Map<string, BusyStation>();
  poses.forEach((p, i) => {
    const activity = ACTIVITY[p.state];
    if (!activity) return;
    for (const s of stations) {
      if (metres(p.longitude, p.latitude, s.longitude, s.latitude) > toleranceM) continue;
      const busy = out.get(s.id);
      if (!busy) out.set(s.id, { activity, drones: [i] });
      else {
        busy.drones.push(i);
        if (activity === 'landing') busy.activity = 'landing';
      }
      break;
    }
  });
  return out;
}
