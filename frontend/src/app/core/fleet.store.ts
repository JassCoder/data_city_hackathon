import { Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import { Subscription } from 'rxjs';
import { describeHttpError } from './api';
import {
  Crossing,
  Drone,
  DronePatch,
  createDrone,
  droneIssues,
  duplicateDrone,
  findCrossings,
  modePatch,
  setRoute,
  shownResponse,
  swapPatch,
  toRouteRequest,
  updateDrone,
} from './fleet';
import { LayersService, StationFeature } from './layers';
import { MapDataService, OUTSIDE_WARSAW } from './map-data';
import { Coordinate, FlightMode, LocationSource, PointRole, SelectedLocation, WeatherMode, isValidCoordinate } from './models';
import { PlannerApi } from './planner-api';
import { MissionId, OptimisationId } from './routing-options';
import { SETTINGS } from './settings';

const STORAGE_KEY = 'skyroute.fleet.v1';

export interface PickTarget {
  droneId: string;
  role: PointRole;
}

type FixturePoint = { stationId: string } | { label: string; coordinate: Coordinate };

/**
 * Explicit demo fleet: the only predefined points in the app, loaded only by the
 * "Load demo fleet" action. Each fixture becomes its own drone.
 */
export const DEMO_FLEET: {
  name: string;
  start: FixturePoint;
  destination: FixturePoint;
  mode: FlightMode;
  mission: MissionId;
  optimisation: OptimisationId;
  altitude?: number;
  profileId?: string;
}[] = [
  {
    name: 'Blood: depot → hospital',
    start: { stationId: 'st-depot' },
    destination: { stationId: 'st-hospital' },
    mode: 'EMERGENCY',
    mission: 'BLOOD_DELIVERY',
    optimisation: 'FASTEST',
    profileId: 'DEMO_DRONE_02',
  },
  {
    name: 'Across the Sejm zone',
    start: { label: 'Demo point west of the Sejm zone', coordinate: { latitude: 52.2255, longitude: 21.0205 } },
    destination: { label: 'Demo point east of the Sejm zone', coordinate: { latitude: 52.225, longitude: 21.037 } },
    mode: 'NORMAL',
    mission: 'GENERAL',
    optimisation: 'BALANCED',
  },
  {
    name: 'Enclosed courtyard at 20 m',
    start: { label: 'Demo point: enclosed courtyard (Praga-Północ)', coordinate: { latitude: 52.25549, longitude: 21.04532 } },
    destination: { stationId: 'st-hospital' },
    mode: 'NORMAL',
    mission: 'GENERAL',
    optimisation: 'SAFEST',
    altitude: 20,
  },
];

let idCounter = 0;
function newId(): string {
  idCounter += 1;
  return `drone-${Date.now().toString(36)}-${idCounter}`;
}

/** Drones as stored in this browser: settings only, routes are recalculated. */
type StoredDrone = Omit<Drone, 'route' | 'notices'>;

@Injectable({ providedIn: 'root' })
export class FleetStore {
  private readonly api = inject(PlannerApi);
  private readonly mapData = inject(MapDataService);
  private readonly layers = inject(LayersService);

  readonly drones = signal<Drone[]>(this.restore());
  readonly selectedId = signal<string | null>(null);
  /** Drone whose form is open in the sidebar. */
  readonly editingId = signal<string | null>(null);
  readonly pickTarget = signal<PickTarget | null>(null);
  readonly weatherMode = signal<WeatherMode>('DEMO');
  /** Last deleted drone, restorable with undo() for SETTINGS.undoMs. */
  readonly lastDeleted = signal<{ drone: Drone; index: number } | null>(null);

  readonly selected = computed(() => this.drones().find((d) => d.id === this.selectedId()) ?? null);
  readonly editing = computed(() => this.drones().find((d) => d.id === this.editingId()) ?? null);
  /** The drone whose flight the airspace evaluation describes: editing, else selected. */
  readonly focusDrone = computed(() => this.editing() ?? this.selected());
  readonly crossings = computed<Map<string, Crossing[]>>(() =>
    findCrossings(this.drones(), SETTINGS.crossingAltitudeBandM),
  );
  readonly calculableCount = computed(() => this.drones().filter((d) => !droneIssues(d).length).length);
  readonly anyCalculating = computed(() => this.drones().some((d) => d.route.phase === 'calculating'));

  private readonly inFlight = new Map<string, Subscription>();
  private readonly requestIds = new Map<string, number>();
  private undoTimer?: ReturnType<typeof setTimeout>;

  constructor() {
    effect(() => this.persist(this.drones()));
  }

  // --- drones -----------------------------------------------------------------------------

  addDrone(): Drone {
    const profiles = this.api.profileList();
    const profileId =
      !profiles || profiles.some((p) => p.id === SETTINGS.defaultProfileId)
        ? SETTINGS.defaultProfileId
        : (profiles[0]?.id ?? SETTINGS.defaultProfileId);
    const drone = createDrone(this.drones(), newId(), { altitude: SETTINGS.altitude.default, profileId });
    this.drones.update((list) => [...list, drone]);
    this.selectedId.set(drone.id);
    this.editingId.set(drone.id);
    return drone;
  }

  duplicate(id: string): Drone | null {
    const source = this.find(id);
    if (!source) return null;
    const copy = duplicateDrone(this.drones(), source, newId());
    this.drones.update((list) => {
      const i = list.findIndex((d) => d.id === id);
      return [...list.slice(0, i + 1), copy, ...list.slice(i + 1)];
    });
    this.selectedId.set(copy.id);
    return copy;
  }

  remove(id: string): void {
    const index = this.drones().findIndex((d) => d.id === id);
    if (index < 0) return;
    this.cancel(id);
    const drone = this.drones()[index];
    this.drones.update((list) => list.filter((d) => d.id !== id));
    if (this.selectedId() === id) this.selectedId.set(null);
    if (this.editingId() === id) this.editingId.set(null);
    if (this.pickTarget()?.droneId === id) this.pickTarget.set(null);
    this.lastDeleted.set({ drone: { ...drone, route: { phase: 'draft' } }, index });
    clearTimeout(this.undoTimer);
    this.undoTimer = setTimeout(() => this.lastDeleted.set(null), SETTINGS.undoMs);
  }

  undoRemove(): void {
    const last = this.lastDeleted();
    if (!last) return;
    clearTimeout(this.undoTimer);
    this.drones.update((list) => [...list.slice(0, last.index), last.drone, ...list.slice(last.index)]);
    this.lastDeleted.set(null);
    this.selectedId.set(last.drone.id);
  }

  select(id: string | null): void {
    this.selectedId.set(id);
  }

  edit(id: string | null): void {
    this.editingId.set(id);
    if (id) this.selectedId.set(id);
    if (!id) this.pickTarget.set(null);
  }

  /** Any change goes through here; route-relevant changes cancel the request and invalidate. */
  update(id: string, patch: DronePatch): void {
    const before = this.find(id);
    if (!before) return;
    this.drones.update((list) => updateDrone(list, id, patch));
    const after = this.find(id)!;
    if (before.route.phase === 'calculating' && after.route.phase !== 'calculating') this.cancel(id);
  }

  rename(id: string, name: string): void {
    this.update(id, { name: name.trim() || this.find(id)?.name });
  }

  setMode(id: string, mode: FlightMode): void {
    this.update(id, modePatch(mode));
  }

  setMission(id: string, missionId: MissionId): void {
    this.update(id, { mission: missionId });
  }

  setOptimisation(id: string, value: OptimisationId): void {
    this.update(id, { optimisation: value });
  }

  setAltitude(id: string, altitude: number): void {
    this.update(id, { altitude });
  }

  setProfile(id: string, profileId: string): void {
    this.update(id, { profileId });
  }

  setPayload(id: string, payloadKg: number | null): void {
    this.update(id, { payloadKg });
  }

  toggleVisible(id: string): void {
    const d = this.find(id);
    if (d) this.update(id, { visible: !d.visible });
  }

  // --- points -----------------------------------------------------------------------------

  /** Sets a point after validating coordinates and the Warsaw polygon; returns false if rejected. */
  setLocation(id: string, role: PointRole, location: SelectedLocation | null): boolean {
    const d = this.find(id);
    if (!d) return false;
    const notices = { ...d.notices };
    if (location) {
      if (!isValidCoordinate(location.coordinate)) {
        this.update(id, { notices: { ...notices, [role]: 'Invalid coordinates: latitude −90…90, longitude −180…180.' } });
        return false;
      }
      // Point-in-polygon on the official Warsaw boundary (the backend checks again).
      if (this.mapData.contains(location.coordinate) === false) {
        this.update(id, { notices: { ...notices, [role]: OUTSIDE_WARSAW } });
        return false;
      }
    }
    delete notices[role];
    this.update(id, { [role]: location, notices } as DronePatch);
    return true;
  }

  swap(id: string): void {
    const d = this.find(id);
    if (d) this.update(id, swapPatch(d));
  }

  clearPoints(id: string): void {
    this.update(id, { start: null, destination: null, notices: {} });
  }

  /** Arms map picking for a drone's point (toggle). */
  pick(id: string, role: PointRole): void {
    const t = this.pickTarget();
    this.pickTarget.set(t?.droneId === id && t.role === role ? null : { droneId: id, role });
  }

  /** Map click: fills the armed point; otherwise the first empty point of the drone being edited. */
  handleMapClick(coordinate: Coordinate): void {
    const target = this.pickTarget() ?? this.implicitTarget();
    if (!target) return;
    const ok = this.setLocation(target.droneId, target.role, this.mapLocation(coordinate, 'MAP_CLICK'));
    if (ok) this.pickTarget.set(null);
  }

  /** Marker dragged on the map; returns false (marker snaps back) if the point is rejected. */
  handleMarkerDrag(id: string, role: PointRole, coordinate: Coordinate): boolean {
    return this.setLocation(id, role, this.mapLocation(coordinate, 'MAP_DRAG'));
  }

  private implicitTarget(): PickTarget | null {
    const d = this.editing();
    if (!d) return null;
    if (!d.start) return { droneId: d.id, role: 'start' };
    if (!d.destination) return { droneId: d.id, role: 'destination' };
    return null;
  }

  private mapLocation(c: Coordinate, source: LocationSource): SelectedLocation {
    return { coordinate: c, label: `Map point ${c.latitude.toFixed(5)}, ${c.longitude.toFixed(5)}`, source };
  }

  // --- routing ----------------------------------------------------------------------------

  /** One request per drone; a newer request or any change drops the older response. */
  calculate(id: string): void {
    const d = this.find(id);
    const request = d ? toRouteRequest(d, this.weatherMode()) : null;
    if (!d || !request) return;
    const reqId = this.cancel(id);
    this.drones.update((list) => setRoute(list, id, { phase: 'calculating', previous: shownResponse(d) }));
    const sub = this.api.calculateRoute(request).subscribe({
      next: (response) => {
        if (this.requestIds.get(id) !== reqId) return;
        this.inFlight.delete(id);
        this.drones.update((list) => setRoute(list, id, { phase: 'ready', response, request }));
      },
      error: (err) => {
        if (this.requestIds.get(id) !== reqId) return;
        this.inFlight.delete(id);
        this.drones.update((list) =>
          setRoute(list, id, { phase: 'error', message: describeHttpError(err, 'Route calculation failed') }),
        );
      },
    });
    if (!sub.closed) this.inFlight.set(id, sub);
  }

  /** Every drone that can be calculated, in parallel; each one succeeds or fails on its own. */
  calculateAll(): void {
    for (const d of this.drones()) if (!droneIssues(d).length) this.calculate(d.id);
  }

  /** A new airspace dataset: routes planned on another version are outdated. */
  onAirspaceVersion(version: string): void {
    for (const d of this.drones()) {
      const r = d.route;
      if (r.phase === 'ready' && r.response.airspace?.datasetVersion !== version) {
        this.drones.update((list) => setRoute(list, d.id, { phase: 'stale', response: r.response, request: r.request }));
      }
    }
  }

  private cancel(id: string): number {
    this.inFlight.get(id)?.unsubscribe();
    this.inFlight.delete(id);
    const next = (this.requestIds.get(id) ?? 0) + 1;
    this.requestIds.set(id, next);
    return next;
  }

  // --- demo fleet -------------------------------------------------------------------------

  /** Explicit action: adds one drone per demo fixture (never replaces the user's drones). */
  loadDemoFleet(): string | null {
    const stations = this.layers.data()?.stations.features ?? [];
    const resolve = (p: FixturePoint): SelectedLocation | null => {
      if ('coordinate' in p) return { coordinate: p.coordinate, label: p.label, source: 'DEMO' };
      const st: StationFeature | undefined = stations.find((x) => x.properties.id === p.stationId);
      return st
        ? {
            coordinate: { latitude: st.geometry.coordinates[1], longitude: st.geometry.coordinates[0] },
            label: `${st.properties.name} (demo station)`,
            source: 'DEMO',
          }
        : null;
    };
    const added: Drone[] = [];
    for (const f of DEMO_FLEET) {
      const start = resolve(f.start);
      const destination = resolve(f.destination);
      if (!start || !destination) return 'Demo stations are not loaded yet. Wait for the map layers and try again.';
      const base = createDrone([...this.drones(), ...added], newId(), {
        altitude: f.altitude ?? SETTINGS.altitude.default,
        profileId: f.profileId ?? SETTINGS.defaultProfileId,
      });
      added.push({ ...base, name: f.name, start, destination, mode: f.mode, mission: f.mission, optimisation: f.optimisation });
    }
    this.drones.update((list) => [...list, ...added]);
    this.editingId.set(null);
    this.selectedId.set(added[0].id);
    untracked(() => added.forEach((d) => this.calculate(d.id)));
    return null;
  }

  // --- persistence (this browser only; routes are not stored) ------------------------------

  private persist(drones: Drone[]): void {
    try {
      const stored: StoredDrone[] = drones.map(({ route: _r, notices: _n, ...rest }) => rest);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
    } catch {
      /* storage unavailable (private mode, blocked): the fleet just is not remembered */
    }
  }

  private restore(): Drone[] {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      const stored = raw ? (JSON.parse(raw) as StoredDrone[]) : [];
      return Array.isArray(stored)
        ? stored.filter((d) => d && typeof d.id === 'string').map((d) => ({ ...d, route: { phase: 'draft' }, notices: {} }))
        : [];
    } catch {
      return [];
    }
  }

  private find(id: string): Drone | undefined {
    return this.drones().find((d) => d.id === id);
  }
}
