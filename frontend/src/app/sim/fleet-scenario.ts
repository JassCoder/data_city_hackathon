/**
 * "Simulate my planned drones" (pure): the planner's fleet as an inline simulation scenario.
 * Each drone with Point A and B becomes one drone starting at A with one mission to B, using
 * the same mode, optimisation and altitude the planner sends. Everything else (wind, durations,
 * where drones go after delivering) comes from the backend defaults.
 */

import { Drone } from '../core/fleet';
import { optimisation } from '../core/routing-options';

export interface FleetScenario {
  scenario: Record<string, unknown>;
  /** Names of drones left out because Point A or B is missing. */
  skipped: string[];
}

export function plannedDrones(drones: readonly Drone[]): Drone[] {
  return drones.filter((d) => d.start && d.destination);
}

export function fleetToScenario(drones: readonly Drone[], startTime: Date, seed = 1): FleetScenario | null {
  const ready = plannedDrones(drones);
  if (!ready.length) return null;
  const id = (i: number) => `p${i + 1}`;
  return {
    skipped: drones.filter((d) => !ready.includes(d)).map((d) => d.name),
    scenario: {
      name: 'My planned drones',
      description: `${ready.length} drone${ready.length === 1 ? '' : 's'} from the route planner. Synthetic airspace; simulation only.`,
      seed,
      startTime: startTime.toISOString(),
      drones: ready.map((d, i) => ({
        id: id(i),
        name: d.name,
        color: d.color,
        profileId: d.profileId,
        position: { latitude: d.start!.coordinate.latitude, longitude: d.start!.coordinate.longitude },
      })),
      missions: ready.map((d, i) => ({
        id: `${id(i)}-m1`,
        droneId: id(i),
        destination: { latitude: d.destination!.coordinate.latitude, longitude: d.destination!.coordinate.longitude },
        mode: d.mode,
        routeObjective: optimisation(d.optimisation).objective,
        flightAltitudeMeters: d.altitude,
      })),
    },
  };
}
