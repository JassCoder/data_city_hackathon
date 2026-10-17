import { Injectable, computed, inject, signal } from '@angular/core';
import { Subscription } from 'rxjs';
import { describeHttpError } from './api';
import { MapDataService, OUTSIDE_WARSAW } from './map-data';
import { LayersService, StationFeature } from './layers';
import {
  ALTITUDE,
  Coordinate,
  FlightMode,
  PointRole,
  RouteObjective,
  RouteRequest,
  RouteResponse,
  ScenarioId,
  SelectedLocation,
  WeatherMode,
  isValidAltitude,
  isValidCoordinate,
} from './models';
import { PlannerApi } from './planner-api';

export const PLANNER_DEFAULTS = {
  altitude: ALTITUDE.default,
  mode: 'NORMAL' as FlightMode,
  droneProfileId: 'DEMO_DRONE_01',
  weatherMode: 'DEMO' as WeatherMode,
  routeObjective: 'CORRIDORS' as RouteObjective,
  scenario: 'NORMAL' as ScenarioId,
};

type FixturePoint = { stationId: string } | { label: string; coordinate: Coordinate };

/**
 * Explicit demo fixtures. They are the ONLY place with predefined points and
 * run only when the user presses a "Load demo fixture" button. They replace
 * Point A/B (and set an altitude where the fixture needs one) and never change
 * the selected scenario, mode, drone profile or weather.
 */
export interface DemoFixture {
  id: 'depot-hospital' | 'sejm' | 'courtyard';
  title: string;
  description: string;
  start: FixturePoint;
  destination: FixturePoint;
  altitude?: number;
}

export const DEMO_FIXTURES: DemoFixture[] = [
  {
    id: 'depot-hospital',
    title: 'Depot → hospital pad',
    description: 'Synthetic Vistula depot to the synthetic Śródmieście hospital pad.',
    start: { stationId: 'st-depot' },
    destination: { stationId: 'st-hospital' },
  },
  {
    id: 'sejm',
    title: 'Across the Sejm zone',
    description: 'Points on both sides of the synthetic DRA-P zone at Sejm: the straight line would cross it.',
    start: { label: 'DEMO fixture west of the Sejm zone', coordinate: { latitude: 52.2255, longitude: 21.0205 } },
    destination: { label: 'DEMO fixture east of the Sejm zone', coordinate: { latitude: 52.225, longitude: 21.037 } },
  },
  {
    id: 'courtyard',
    title: 'Enclosed courtyard (no route at 20 m)',
    description: 'A courtyard enclosed by buildings ≥ 10 m in Praga-Północ; sets 20 m altitude.',
    start: { label: 'DEMO fixture: enclosed courtyard (Praga-Północ)', coordinate: { latitude: 52.25549, longitude: 21.04532 } },
    destination: { stationId: 'st-hospital' },
    altitude: 20,
  },
];

export const MISSING_POINTS_MESSAGE =
  'Please select both the starting point and destination before calculating a route.';

export type RouteState =
  | { phase: 'idle' }
  | { phase: 'loading'; previous?: RouteResponse }
  | { phase: 'ready'; response: RouteResponse; request: RouteRequest }
  | { phase: 'stale'; response: RouteResponse; request: RouteRequest }
  | { phase: 'error'; message: string };

@Injectable({ providedIn: 'root' })
export class PlannerStore {
  private readonly api = inject(PlannerApi);
  private readonly layers = inject(LayersService);
  private readonly mapData = inject(MapDataService);

  readonly start = signal<SelectedLocation | null>(null);
  readonly destination = signal<SelectedLocation | null>(null);
  readonly altitude = signal<number>(PLANNER_DEFAULTS.altitude);
  readonly mode = signal<FlightMode>(PLANNER_DEFAULTS.mode);
  readonly droneProfileId = signal<string | null>(PLANNER_DEFAULTS.droneProfileId);
  readonly weatherMode = signal<WeatherMode>(PLANNER_DEFAULTS.weatherMode);
  readonly routeObjective = signal<RouteObjective>(PLANNER_DEFAULTS.routeObjective);
  /** Which point the next map click sets (null = fill the first empty point). */
  readonly pickTarget = signal<PointRole | null>(null);
  /** Per-point validation messages (e.g. outside coverage). */
  readonly notices = signal<Partial<Record<PointRole, string>>>({});
  readonly route = signal<RouteState>({ phase: 'idle' });
  /** Active routing scenario (null = custom mode/objective). Never affects Point A/B. */
  readonly selectedScenario = signal<ScenarioId | null>(PLANNER_DEFAULTS.scenario);
  /** Message shown when a scenario is chosen before both points are set. */
  readonly scenarioNotice = signal<string | null>(null);
  /** Title of the demo fixture that set the current points (cleared when a point changes). */
  readonly fixtureLabel = signal<string | null>(null);
  /** Incremented by reset(); inputs clear their local query/results on change. */
  readonly resetCount = signal(0);

  readonly altitudeValid = computed(() => isValidAltitude(this.altitude()));
  readonly profileValid = computed(() => {
    const id = this.droneProfileId();
    const profiles = this.api.profileList();
    return !!id && (!profiles || profiles.some((p) => p.id === id));
  });

  /** The request built purely from current state, or null while anything is invalid. */
  readonly request = computed<RouteRequest | null>(() => {
    const start = this.start()?.coordinate;
    const destination = this.destination()?.coordinate;
    const droneProfileId = this.droneProfileId();
    if (!isValidCoordinate(start) || !isValidCoordinate(destination)) return null;
    if (start.latitude === destination.latitude && start.longitude === destination.longitude) return null;
    if (!this.altitudeValid() || !this.profileValid() || !droneProfileId) return null;
    return {
      start: { latitude: start.latitude, longitude: start.longitude },
      destination: { latitude: destination.latitude, longitude: destination.longitude },
      mode: this.mode(),
      flightAltitudeMeters: this.altitude(),
      droneProfileId,
      weatherMode: this.weatherMode(),
      routeObjective: this.routeObjective(),
      ...(this.selectedScenario() ? { scenario: this.selectedScenario() } : {}),
    };
  });

  readonly selectedScenarioConfig = computed(() => {
    const id = this.selectedScenario();
    return id ? (this.api.scenarioList()?.find((c) => c.id === id) ?? null) : null;
  });

  readonly canCalculate = computed(() => this.request() !== null && this.route().phase !== 'loading');

  /** Bumped on every invalidation; responses for an older id are dropped. */
  private requestId = 0;
  private inFlight?: Subscription;

  // --- locations ------------------------------------------------------------

  /** Sets a point after validating coordinates and coverage; returns false if rejected. */
  setLocation(role: PointRole, location: SelectedLocation | null): boolean {
    if (location) {
      if (!isValidCoordinate(location.coordinate)) {
        this.setNotice(role, 'Invalid coordinates: latitude must be −90…90 and longitude −180…180.');
        return false;
      }
      // Point-in-polygon on the official Warsaw boundary (the backend checks again).
      if (this.mapData.contains(location.coordinate) === false) {
        this.setNotice(role, OUTSIDE_WARSAW);
        return false;
      }
    }
    this.setNotice(role, undefined);
    (role === 'start' ? this.start : this.destination).set(location);
    this.fixtureLabel.set(null);
    this.scenarioNotice.set(null);
    this.invalidate();
    return true;
  }

  /** Map click: fills the armed point, else the first empty one. */
  handleMapClick(coordinate: Coordinate): void {
    const role = this.pickTarget() ?? (!this.start() ? 'start' : !this.destination() ? 'destination' : null);
    if (!role) return;
    const label = `Map point ${coordinate.latitude.toFixed(5)}, ${coordinate.longitude.toFixed(5)}`;
    if (this.setLocation(role, { coordinate, label, source: 'MAP_CLICK' })) this.pickTarget.set(null);
  }

  setNotice(role: PointRole, message: string | undefined): void {
    this.notices.update((n) => ({ ...n, [role]: message }));
  }

  // --- settings (each change invalidates the current route) -------------------

  setAltitude(value: number): void {
    this.altitude.set(value);
    this.invalidate();
  }

  setMode(mode: FlightMode): void {
    this.mode.set(mode);
    this.leaveScenarioIfChanged();
    this.invalidate();
  }

  setDroneProfile(id: string | null): void {
    this.droneProfileId.set(id);
    this.invalidate();
  }

  setWeatherMode(mode: WeatherMode): void {
    this.weatherMode.set(mode);
    this.invalidate();
  }

  setRouteObjective(objective: RouteObjective): void {
    this.routeObjective.set(objective);
    this.leaveScenarioIfChanged();
    this.invalidate();
  }

  /** Manual mode/objective changes that no longer match the scenario make it "custom". */
  private leaveScenarioIfChanged(): void {
    const cfg = this.selectedScenarioConfig();
    if (cfg && (cfg.mode !== this.mode() || cfg.routeObjective !== this.routeObjective())) {
      this.selectedScenario.set(null);
    }
  }

  // --- scenarios ------------------------------------------------------------

  /**
   * Switches the routing configuration. Point A, Point B, their labels, altitude,
   * drone profile and weather are left untouched; only mode/objective follow the
   * scenario's configuration. Recalculates with the same points when both are set.
   * Returns false (with a notice) when a point is missing.
   */
  selectScenario(id: ScenarioId): boolean {
    const cfg = this.api.scenarioList()?.find((c) => c.id === id);
    if (!cfg) {
      this.scenarioNotice.set('Scenarios are not loaded yet. Check the backend connection.');
      return false;
    }
    this.selectedScenario.set(id);
    this.mode.set(cfg.mode);
    this.routeObjective.set(cfg.routeObjective);
    this.invalidate();
    if (!this.start() || !this.destination()) {
      this.scenarioNotice.set(MISSING_POINTS_MESSAGE);
      return false;
    }
    this.scenarioNotice.set(null);
    this.calculate();
    return true;
  }

  // --- routing --------------------------------------------------------------

  calculate(): void {
    const request = this.request();
    if (!request) return;
    const id = this.cancelInFlight();
    const current = this.route();
    const previous = current.phase === 'ready' || current.phase === 'stale' ? current.response : undefined;
    this.route.set({ phase: 'loading', previous });
    this.inFlight = this.api.calculateRoute(request).subscribe({
      next: (response) => {
        if (id === this.requestId) this.route.set({ phase: 'ready', response, request });
      },
      error: (err) => {
        if (id === this.requestId) {
          this.route.set({ phase: 'error', message: describeHttpError(err, 'Route calculation failed') });
        }
      },
    });
  }

  /** Route results no longer match the inputs: keep showing them as stale. */
  private invalidate(): void {
    this.cancelInFlight();
    const r = this.route();
    if (r.phase === 'ready') this.route.set({ phase: 'stale', response: r.response, request: r.request });
    else if (r.phase === 'loading' || r.phase === 'error') this.route.set({ phase: 'idle' });
  }

  private cancelInFlight(): number {
    this.inFlight?.unsubscribe();
    this.inFlight = undefined;
    return ++this.requestId;
  }

  clearRoute(): void {
    this.cancelInFlight();
    this.route.set({ phase: 'idle' });
  }

  reset(): void {
    this.clearRoute();
    this.start.set(null);
    this.destination.set(null);
    this.altitude.set(PLANNER_DEFAULTS.altitude);
    this.mode.set(PLANNER_DEFAULTS.mode);
    this.droneProfileId.set(PLANNER_DEFAULTS.droneProfileId);
    this.weatherMode.set(PLANNER_DEFAULTS.weatherMode);
    this.routeObjective.set(PLANNER_DEFAULTS.routeObjective);
    this.selectedScenario.set(PLANNER_DEFAULTS.scenario);
    this.scenarioNotice.set(null);
    this.pickTarget.set(null);
    this.notices.set({});
    this.fixtureLabel.set(null);
    this.resetCount.update((n) => n + 1);
  }

  /** A new airspace dataset version: routes planned on another version are outdated. */
  onAirspaceVersion(version: string): void {
    const r = this.route();
    if ((r.phase === 'ready' || r.phase === 'stale') && r.response.airspace?.datasetVersion !== version) {
      this.invalidate();
    }
  }

  /**
   * Explicit "Load demo fixture" action: replaces Point A/B with a fixture's
   * points (plus its altitude, if any) and calculates with the CURRENT scenario,
   * mode, profile and weather. Never called by scenario selection.
   */
  loadDemoFixture(id: DemoFixture['id']): string | null {
    const fixture = DEMO_FIXTURES.find((d) => d.id === id)!;
    const stations = this.layers.data()?.stations.features ?? [];
    const resolve = (p: FixturePoint): SelectedLocation | null => {
      if ('coordinate' in p) return { coordinate: p.coordinate, label: p.label, source: 'DEMO' };
      const st: StationFeature | undefined = stations.find((x) => x.properties.id === p.stationId);
      return st
        ? {
            coordinate: { latitude: st.geometry.coordinates[1], longitude: st.geometry.coordinates[0] },
            label: `${st.properties.name} (DEMO station)`,
            source: 'DEMO',
          }
        : null;
    };
    const from = resolve(fixture.start);
    const to = resolve(fixture.destination);
    if (!from || !to) return 'Demo stations are not loaded yet. Wait for the map layers and try again.';
    this.clearRoute();
    this.start.set(from);
    this.destination.set(to);
    if (fixture.altitude !== undefined) this.altitude.set(fixture.altitude);
    this.notices.set({});
    this.scenarioNotice.set(null);
    this.pickTarget.set(null);
    this.fixtureLabel.set(fixture.title);
    this.calculate();
    return null;
  }
}
