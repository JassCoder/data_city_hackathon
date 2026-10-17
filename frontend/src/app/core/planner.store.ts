import { Injectable, computed, inject, signal } from '@angular/core';
import { Subscription } from 'rxjs';
import { coverageMessage, describeHttpError, inBbox } from './api';
import { LayersService, StationFeature } from './layers';
import {
  ALTITUDE,
  Coordinate,
  FlightMode,
  PointRole,
  RouteRequest,
  RouteResponse,
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
};

interface DemoSettings {
  altitude: number;
  mode: FlightMode;
  droneProfileId: string;
  weatherMode: WeatherMode;
}

type DemoPoint = { stationId: string } | { label: string; coordinate: Coordinate };

export interface DemoScenario {
  id: 'blood' | 'avoid' | 'noroute';
  title: string;
  description: string;
  start: DemoPoint;
  destination: DemoPoint;
  settings: DemoSettings;
}

/** Optional example data for the demo buttons only; normal routing uses the user's points. */
export const DEMO_SCENARIOS: DemoScenario[] = [
  {
    id: 'blood',
    title: 'Blood delivery (DEMO DATA)',
    description: 'Vistula depot → Śródmieście hospital pad (synthetic stations).',
    start: { stationId: 'st-depot' },
    destination: { stationId: 'st-hospital' },
    settings: { altitude: 80, mode: 'NORMAL', droneProfileId: 'DEMO_DRONE_02', weatherMode: 'DEMO' },
  },
  {
    id: 'avoid',
    title: 'Avoid a prohibited zone (DEMO)',
    description: 'The straight line crosses the synthetic DRA-P zone at Sejm; A* must route around it.',
    start: { label: 'DEMO point west of the Sejm zone', coordinate: { latitude: 52.2255, longitude: 21.0205 } },
    destination: { label: 'DEMO point east of the Sejm zone', coordinate: { latitude: 52.225, longitude: 21.037 } },
    settings: { altitude: 80, mode: 'NORMAL', droneProfileId: 'DEMO_DRONE_01', weatherMode: 'DEMO' },
  },
  {
    id: 'noroute',
    title: 'No route available (DEMO)',
    description: 'A courtyard enclosed by buildings ≥ 10 m, at 20 m altitude: no valid path exists.',
    start: { label: 'DEMO enclosed courtyard (Śródmieście Południowe)', coordinate: { latitude: 52.22344, longitude: 21.01109 } },
    destination: { stationId: 'st-hospital' },
    settings: { altitude: 20, mode: 'NORMAL', droneProfileId: 'DEMO_DRONE_01', weatherMode: 'DEMO' },
  },
];

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

  readonly start = signal<SelectedLocation | null>(null);
  readonly destination = signal<SelectedLocation | null>(null);
  readonly altitude = signal<number>(PLANNER_DEFAULTS.altitude);
  readonly mode = signal<FlightMode>(PLANNER_DEFAULTS.mode);
  readonly droneProfileId = signal<string | null>(PLANNER_DEFAULTS.droneProfileId);
  readonly weatherMode = signal<WeatherMode>(PLANNER_DEFAULTS.weatherMode);
  /** Which point the next map click sets (null = fill the first empty point). */
  readonly pickTarget = signal<PointRole | null>(null);
  /** Per-point validation messages (e.g. outside coverage). */
  readonly notices = signal<Partial<Record<PointRole, string>>>({});
  readonly route = signal<RouteState>({ phase: 'idle' });
  readonly scenarioLabel = signal<string | null>(null);
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
    };
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
      const bbox = this.layers.data()?.bbox;
      if (bbox && !inBbox(location.coordinate, bbox)) {
        this.setNotice(role, coverageMessage(bbox));
        return false;
      }
    }
    this.setNotice(role, undefined);
    (role === 'start' ? this.start : this.destination).set(location);
    this.scenarioLabel.set(null);
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
    this.pickTarget.set(null);
    this.notices.set({});
    this.scenarioLabel.set(null);
    this.resetCount.update((n) => n + 1);
  }

  /** A new airspace dataset version: routes planned on another version are outdated. */
  onAirspaceVersion(version: string): void {
    const r = this.route();
    if ((r.phase === 'ready' || r.phase === 'stale') && r.response.airspace?.datasetVersion !== version) {
      this.invalidate();
    }
  }

  /** Loads a demo scenario's points + settings and calculates through the normal API. */
  loadDemoScenario(id: DemoScenario['id'] = 'blood'): string | null {
    const scenario = DEMO_SCENARIOS.find((d) => d.id === id)!;
    const stations = this.layers.data()?.stations.features ?? [];
    const resolve = (p: DemoPoint): SelectedLocation | null => {
      if ('coordinate' in p) return { coordinate: p.coordinate, label: p.label, source: 'DEMO' };
      const s: StationFeature | undefined = stations.find((st) => st.properties.id === p.stationId);
      return s
        ? {
            coordinate: { latitude: s.geometry.coordinates[1], longitude: s.geometry.coordinates[0] },
            label: `${s.properties.name} (DEMO station)`,
            source: 'DEMO',
          }
        : null;
    };
    const from = resolve(scenario.start);
    const to = resolve(scenario.destination);
    if (!from || !to) return 'Demo stations are not loaded yet. Wait for the map layers and try again.';
    this.clearRoute();
    this.start.set(from);
    this.destination.set(to);
    const s = scenario.settings;
    this.altitude.set(s.altitude);
    this.mode.set(s.mode);
    this.droneProfileId.set(s.droneProfileId);
    this.weatherMode.set(s.weatherMode);
    this.notices.set({});
    this.pickTarget.set(null);
    this.scenarioLabel.set(scenario.title);
    this.calculate();
    return null;
  }
}
