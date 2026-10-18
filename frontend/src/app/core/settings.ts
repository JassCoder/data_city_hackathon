import { environment } from '../../environments/environment';

/**
 * Frontend configuration in one place: endpoints come from the environment file,
 * UI thresholds are listed here. Routing weights never live in the frontend
 * (data/cost_model.json and backend/app/routing/costs.py).
 */
export const SETTINGS = {
  apiBaseUrl: environment.apiBaseUrl,
  tileUrl: environment.tileUrl,
  tileAttribution: environment.tileAttribution,
  /** Mirrors the backend request contract (20–120 m AGL in 5 m steps; cost_model.json legalCeilingM = 120). */
  altitude: { min: 20, max: 120, step: 5, default: 80 },
  /** Two crossing routes are flagged when their altitudes differ by at most this much. */
  crossingAltitudeBandM: 10,
  /** Recently picked places offered as instant suggestions (kept in this browser only). */
  maxRecentPlaces: 8,
  /** How long "Undo" stays available after deleting a drone. */
  undoMs: 6000,
  /** Profile for new drones (profiles themselves come from GET /drone-profiles). */
  defaultProfileId: 'DEMO_DRONE_01',
  /** Below this width the sidebar becomes a bottom sheet and the drawer a full-height sheet. */
  mobileMaxWidthPx: 767,
} as const;
