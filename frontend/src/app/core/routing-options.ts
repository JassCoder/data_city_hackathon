/**
 * How the UI's flight mode, mission and route optimisation map onto the backend
 * request. No weights live here: each optimisation names a backend objective whose
 * weights are in data/cost_model.json or backend/app/routing/costs.py.
 */

import { FlightMode, RouteObjective, ScenarioConfig, ScenarioId } from './models';

export type OptimisationId = 'BALANCED' | 'FASTEST' | 'SAFEST' | 'LOWEST_ENERGY';

export interface OptimisationOption {
  id: OptimisationId;
  label: string;
  objective: RouteObjective;
  help: string;
}

export const OPTIMISATIONS: OptimisationOption[] = [
  {
    id: 'BALANCED',
    label: 'Balanced',
    objective: 'CORRIDORS',
    help: 'Prefers the Vistula and parks over built-up areas.',
  },
  {
    id: 'FASTEST',
    label: 'Fastest',
    objective: 'FASTEST',
    help: 'Shortest flight time with the wind at your altitude.',
  },
  {
    id: 'SAFEST',
    label: 'Safest',
    objective: 'SAFEST',
    help: 'Avoids crowds, homes at night, schools and hospitals, and stays near landing space. Crowd data is an OSM estimate.',
  },
  {
    id: 'LOWEST_ENERGY',
    label: 'Lowest energy',
    objective: 'LOWEST_ENERGY',
    help: 'Least battery use for the wind and payload.',
  },
];

export type MissionId = 'GENERAL' | 'AVOID_PROHIBITED_ZONE' | 'GENERAL_EMERGENCY' | 'BLOOD_DELIVERY' | 'AED_DELIVERY';

export interface MissionOption {
  id: MissionId;
  label: string;
  mode: FlightMode;
  /** Backend scenario sent with the request; null = free optimisation choice. */
  scenario: ScenarioId | null;
}

/** Normal flights: general or "avoid prohibited zone"; emergencies: general, blood, AED. */
export const MISSIONS: MissionOption[] = [
  { id: 'GENERAL', label: 'General', mode: 'NORMAL', scenario: null },
  { id: 'AVOID_PROHIBITED_ZONE', label: 'Avoid prohibited zone', mode: 'NORMAL', scenario: 'AVOID_PROHIBITED_ZONE' },
  { id: 'GENERAL_EMERGENCY', label: 'General emergency', mode: 'EMERGENCY', scenario: 'EMERGENCY' },
  { id: 'BLOOD_DELIVERY', label: 'Blood delivery', mode: 'EMERGENCY', scenario: 'BLOOD_DELIVERY' },
  { id: 'AED_DELIVERY', label: 'AED / first aid', mode: 'EMERGENCY', scenario: 'AED_DELIVERY' },
];

export function mission(id: MissionId): MissionOption {
  return MISSIONS.find((m) => m.id === id)!;
}

export function missionsFor(mode: FlightMode): MissionOption[] {
  return MISSIONS.filter((m) => m.mode === mode);
}

export function defaultMission(mode: FlightMode): MissionId {
  return missionsFor(mode)[0].id;
}

export function optimisation(id: OptimisationId): OptimisationOption {
  return OPTIMISATIONS.find((o) => o.id === id)!;
}

export const OBJECTIVE_LABEL: Record<RouteObjective, string> = {
  CORRIDORS: 'Balanced',
  SHORTEST: 'Shortest',
  FASTEST: 'Fastest',
  SAFEST: 'Safest',
  LOWEST_ENERGY: 'Lowest energy',
};

/**
 * The objective a mission's scenario fixes (from GET /scenarios), or null when the
 * mission leaves optimisation to the user or scenarios are not loaded yet.
 */
export function lockedObjective(id: MissionId, scenarios: ScenarioConfig[] | undefined): RouteObjective | null {
  const s = mission(id).scenario;
  if (!s) return null;
  return scenarios?.find((c) => c.id === s)?.routeObjective ?? null;
}

/** What a mode changes in routing (wording from the backend NORMAL / EMERGENCY scenarios). */
export const MODE_HELP: Record<FlightMode, string> = {
  NORMAL: 'Standard route between your points, with the optimisation you choose.',
  EMERGENCY:
    'Minimises travel time for urgent missions. Emergency status grants no airspace permission: every restriction still applies.',
};

/** Backend description of the mission's scenario (shown under the mission selector). */
export function missionHelp(id: MissionId, scenarios: ScenarioConfig[] | undefined): string | null {
  const s = mission(id).scenario;
  return s ? (scenarios?.find((c) => c.id === s)?.description ?? null) : null;
}
