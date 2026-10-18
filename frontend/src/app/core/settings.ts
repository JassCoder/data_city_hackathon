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
  /** The one drone profile every drone uses (Standard); not shown in the UI. */
  defaultProfileId: 'DEMO_DRONE_01',
  /** Below this width the sidebar becomes a bottom sheet and the drawer a full-height sheet. */
  mobileMaxWidthPx: 767,
  /** Simulation view playback (engine limits come from the session API, not from here). */
  sim: {
    /** Simulated seconds per real second. */
    speeds: [1, 5, 20, 60],
    defaultSpeed: 20,
    /** Each step request covers this much playback time. */
    chunkWallS: 0.5,
    /** Keep this much playback time buffered ahead of the playhead. */
    leadWallS: 1.2,
    /** Frames requested per real second of playback (a coarser stride at high speed). */
    framesPerWallSecond: 12,
    /** History loaded around the playhead when replaying. */
    replayAheadWallS: 8,
    /** Simulated seconds of trail behind each drone. */
    trailS: 90,
    /** Panels (telemetry, clock, feed) refresh this often; the map moves every animation frame. */
    uiRefreshMs: 250,
    /** Routes and trails are redrawn this often. */
    lineRefreshMs: 100,
    /** Selected drone details are reloaded this often while the simulation advances. */
    detailRefreshMs: 2000,
    /** Retry delays after a failed request; after the last one the view says "disconnected". */
    retryDelaysMs: [1000, 2000, 4000, 8000],
    /** Battery bars and state badges are hidden below this zoom. */
    detailZoom: 13,
    /** Events listed in the feed at most (newest first). */
    feedLimit: 200,
    /** Defaults for a drawn zone. */
    zoneDefaults: { upperM: 120, durationMin: 15 },
  },
} as const;
