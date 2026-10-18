/**
 * How the UI's flight mode and route optimisation map onto the backend request.
 * No weights live here: each optimisation names a backend objective whose weights
 * are in data/cost_model.json or backend/app/routing/costs.py. Prohibited and
 * restricted zones are avoided by every request (backend hard constraint), so the
 * UI offers no option for it.
 */

import { CostTerm, FlightMode, RouteObjective } from './models';

export type OptimisationId = 'BALANCED' | 'FASTEST' | 'SAFEST' | 'LOWEST_ENERGY';

export interface OptimisationOption {
  id: OptimisationId;
  label: string;
  objective: RouteObjective;
}

export const OPTIMISATIONS: OptimisationOption[] = [
  {
    id: 'BALANCED',
    label: 'Balanced',
    objective: 'CORRIDORS',
  },
  {
    id: 'FASTEST',
    label: 'Fastest',
    objective: 'FASTEST',
  },
  {
    id: 'SAFEST',
    label: 'Safest',
    objective: 'SAFEST',
  },
  {
    id: 'LOWEST_ENERGY',
    label: 'Lowest energy',
    objective: 'LOWEST_ENERGY',
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

/** Plain names of the multi-criteria cost terms (data/cost_model.json). */
export const TERM_LABEL: Record<CostTerm, string> = {
  population: 'Crowds (estimated)',
  obstacle_proximity: 'Near tall structures',
  noise: 'Noise over homes',
  emergency_landing: 'Far from landing space',
  sensitive_areas: 'Schools, hospitals, stadiums',
  energy: 'Energy (wind)',
  time: 'Flight time',
};
