/**
 * How the UI's flight mode and route optimisation map onto the backend request.
 * No weights live here: each optimisation names a backend objective whose weights
 * are in data/cost_model.json or backend/app/routing/costs.py. Prohibited and
 * restricted zones are avoided by every request (backend hard constraint).
 */

import { FlightMode, RouteObjective } from './models';

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
    help: 'Least battery use for the wind at your altitude.',
  },
];

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

export const MODE_LABEL: Record<FlightMode, string> = { NORMAL: 'Normal', EMERGENCY: 'Emergency' };

/** What a mode changes in routing (backend: EMERGENCY only changes the Balanced corridor weights). */
export const MODE_HELP: Record<FlightMode, string> = {
  NORMAL: 'Standard flight with the route optimisation you choose.',
  EMERGENCY:
    'Urgent flight: Balanced routes become more direct. Emergency status grants no airspace permission: every restriction still applies.',
};

/** Shown in the form: avoidance is a fixed rule, not an option. */
export const ZONE_RULE =
  'Prohibited and restricted zones are always avoided, with a safety margin, in both modes.';
