import { CENTRALNA, KOPERNIK, routeResponse } from '../../testing/fixtures';
import {
  DRONE_COLORS,
  Drone,
  createDrone,
  droneIssues,
  droneStatus,
  duplicateDrone,
  findCrossings,
  modePatch,
  playbackPoints,
  segmentIntersection,
  shortLabel,
  swapPatch,
  toRouteRequest,
  updateDrone,
} from './fleet';
import { RouteRequest } from './models';
import { MISSIONS, OPTIMISATIONS } from './routing-options';
import { ZONE_KINDS } from '../map/map-style';

const DEFAULTS = { altitude: 80, profileId: 'DEMO_DRONE_01' };

function drone(over: Partial<Drone> = {}, others: Drone[] = []): Drone {
  return { ...createDrone(others, over.id ?? 'd1', DEFAULTS), start: CENTRALNA, destination: KOPERNIK, ...over };
}

function ready(d: Drone, over: Parameters<typeof routeResponse>[1] = {}): Drone {
  const request = toRouteRequest(d, 'DEMO')!;
  return { ...d, route: { phase: 'ready', response: routeResponse(request, over), request } };
}

describe('fleet: creating and copying drones', () => {
  it('names drones uniquely and gives each a distinct colour', () => {
    const list: Drone[] = [];
    for (let i = 0; i < 4; i++) list.push(createDrone(list, `d${i}`, DEFAULTS));
    expect(list.map((d) => d.name)).toEqual(['Drone 1', 'Drone 2', 'Drone 3', 'Drone 4']);
    expect(new Set(list.map((d) => d.color)).size).toBe(4);
    // A gap left by a deleted drone is not reused as a duplicate name.
    const next = createDrone([list[0], list[2]], 'x', DEFAULTS);
    expect(['Drone 1', 'Drone 3']).not.toContain(next.name);
  });

  it('never uses the airspace colours for drones', () => {
    const zoneColors = Object.values(ZONE_KINDS).map((k) => k.color.toLowerCase());
    for (const c of DRONE_COLORS) expect(zoneColors).not.toContain(c);
  });

  it('starts as a draft with normal mode, balanced optimisation and the default altitude', () => {
    const d = createDrone([], 'd1', DEFAULTS);
    expect(d).toMatchObject({ mode: 'NORMAL', mission: 'GENERAL', optimisation: 'BALANCED', altitude: 80, visible: true });
    expect(d.route).toEqual({ phase: 'draft' });
  });

  it('duplicates settings with a new id, name and colour, and a fresh route', () => {
    const a = ready(drone({ altitude: 100, optimisation: 'SAFEST' }));
    const copy = duplicateDrone([a], a, 'd2');
    expect(copy).toMatchObject({ id: 'd2', name: 'Drone 1 copy', altitude: 100, optimisation: 'SAFEST', start: CENTRALNA });
    expect(copy.color).not.toBe(a.color);
    expect(copy.route).toEqual({ phase: 'draft' });
    expect(duplicateDrone([a, copy], a, 'd3').name).toBe('Drone 1 copy 2');
  });
});

describe('fleet: changes invalidate routes', () => {
  it('turns a ready route into an outdated one when a routing input changes', () => {
    const list = [ready(drone())];
    for (const patch of [{ altitude: 100 }, { optimisation: 'FASTEST' as const }, { destination: CENTRALNA }, { payloadKg: 0.3 }]) {
      expect(updateDrone(list, 'd1', patch)[0].route.phase).toBe('stale');
    }
  });

  it('keeps the route for display-only changes and no-op changes', () => {
    const list = [ready(drone())];
    expect(updateDrone(list, 'd1', { name: 'Courier' })[0].route.phase).toBe('ready');
    expect(updateDrone(list, 'd1', { visible: false })[0].route.phase).toBe('ready');
    expect(updateDrone(list, 'd1', { altitude: 80 })[0].route.phase).toBe('ready');
  });

  it('drops calculating and failed states back to draft', () => {
    const calc = { ...drone(), route: { phase: 'calculating' as const } };
    const err = { ...drone({ id: 'd2' }), route: { phase: 'error' as const, message: 'x' } };
    const out = updateDrone(updateDrone([calc, err], 'd1', { altitude: 60 }), 'd2', { altitude: 60 });
    expect(out.map((d) => d.route.phase)).toEqual(['draft', 'draft']);
  });

  it('only touches the drone it is given', () => {
    const list = [ready(drone()), ready(drone({ id: 'd2' }))];
    const out = updateDrone(list, 'd1', { altitude: 100 });
    expect(out[1]).toBe(list[1]);
  });

  it('switching mode picks that mode’s default mission', () => {
    expect(modePatch('EMERGENCY')).toEqual({ mode: 'EMERGENCY', mission: 'GENERAL_EMERGENCY' });
    expect(modePatch('NORMAL')).toEqual({ mode: 'NORMAL', mission: 'GENERAL' });
  });

  it('swaps A and B', () => {
    expect(swapPatch(drone())).toMatchObject({ start: KOPERNIK, destination: CENTRALNA });
  });
});

describe('fleet: validation', () => {
  it('lists what is missing in plain language', () => {
    expect(droneIssues(drone({ start: null, destination: null }))).toEqual(['Set Point A.', 'Set Point B.']);
    expect(droneIssues(drone({ destination: CENTRALNA }))).toContain('Point A and Point B must be different.');
    expect(droneIssues(drone({ altitude: 82 }))[0]).toMatch(/Altitude must be 20–120 m in 5 m steps/);
    expect(droneIssues(drone({ altitude: 125 })).length).toBe(1);
    expect(droneIssues(drone({ notices: { start: 'Outside the supported area' } }))).toContain('Outside the supported area');
    expect(droneIssues(drone())).toEqual([]);
  });
});

describe('fleet: mapping modes, missions and optimisations to the API request', () => {
  it('general flights send mode + the objective of the chosen optimisation, no scenario', () => {
    const expected = { BALANCED: 'CORRIDORS', FASTEST: 'FASTEST', SAFEST: 'SAFEST', LOWEST_ENERGY: 'LOWEST_ENERGY' };
    for (const o of OPTIMISATIONS) {
      const req = toRouteRequest(drone({ optimisation: o.id }), 'LIVE')!;
      expect(req.routeObjective).toBe(expected[o.id]);
      expect(req.scenario).toBeUndefined();
      expect(req).toMatchObject({ mode: 'NORMAL', flightAltitudeMeters: 80, droneProfileId: 'DEMO_DRONE_01', weatherMode: 'LIVE' });
    }
  });

  it('missions send their scenario with the mode, and let the scenario set the objective', () => {
    const cases: [Drone['mission'], string, string][] = [
      ['AVOID_PROHIBITED_ZONE', 'AVOID_PROHIBITED_ZONE', 'NORMAL'],
      ['GENERAL_EMERGENCY', 'EMERGENCY', 'EMERGENCY'],
      ['BLOOD_DELIVERY', 'BLOOD_DELIVERY', 'EMERGENCY'],
      ['AED_DELIVERY', 'AED_DELIVERY', 'EMERGENCY'],
    ];
    for (const [mission, scenario, mode] of cases) {
      const req = toRouteRequest(drone({ mission, optimisation: 'SAFEST' }), 'DEMO') as RouteRequest;
      expect(req.scenario).toBe(scenario);
      expect(req.mode).toBe(mode);
      expect(req.routeObjective).toBeUndefined(); // an explicit, contradicting objective would be a 422
    }
    // Every backend scenario except the plain NORMAL one is reachable from the UI.
    expect(MISSIONS.map((m) => m.scenario).filter(Boolean).sort()).toEqual(
      ['AED_DELIVERY', 'AVOID_PROHIBITED_ZONE', 'BLOOD_DELIVERY', 'EMERGENCY'],
    );
  });

  it('sends the payload only when set and never sends an invalid request', () => {
    expect(toRouteRequest(drone(), 'DEMO')!.payloadKg).toBeUndefined();
    expect(toRouteRequest(drone({ payloadKg: 0.4 }), 'DEMO')!.payloadKg).toBe(0.4);
    expect(toRouteRequest(drone({ start: null }), 'DEMO')).toBeNull();
    expect(toRouteRequest(drone({ altitude: 130 }), 'DEMO')).toBeNull();
  });
});

describe('fleet: status', () => {
  it('maps route states to list statuses', () => {
    expect(droneStatus(drone())).toBe('draft');
    expect(droneStatus({ ...drone(), route: { phase: 'calculating' } })).toBe('calculating');
    expect(droneStatus(ready(drone()))).toBe('ready');
    expect(droneStatus(ready(drone(), { status: 'NO_ROUTE', geometry: null }))).toBe('no-route');
    expect(droneStatus(updateDrone([ready(drone())], 'd1', { altitude: 100 })[0])).toBe('outdated');
    expect(droneStatus({ ...drone(), route: { phase: 'error', message: 'x' } })).toBe('error');
  });

  it('shortens long place names for the list', () => {
    expect(shortLabel({ ...CENTRALNA, label: 'Warszawa Centralna, Śródmieście, Warszawa, Polska' })).toBe('Warszawa Centralna');
    expect(shortLabel(null)).toBe('—');
  });
});

describe('fleet: crossing routes', () => {
  it('finds the intersection of two segments and ignores parallel or separate ones', () => {
    expect(segmentIntersection([0, 0], [2, 2], [0, 2], [2, 0])).toEqual([1, 1]);
    expect(segmentIntersection([0, 0], [1, 0], [0, 1], [1, 1])).toBeNull();
    expect(segmentIntersection([0, 0], [1, 1], [2, 0], [3, -1])).toBeNull();
  });

  function withLine(id: string, coords: [number, number][], altitude = 80, over: Partial<Drone> = {}): Drone {
    const d = ready(drone({ id, altitude, ...over }));
    const r = d.route as { response: ReturnType<typeof routeResponse> };
    r.response = { ...r.response, geometry: { type: 'LineString', coordinates: coords }, flightAltitudeMeters: altitude };
    return d;
  }

  it('flags visible ready routes that cross at about the same altitude, for both drones', () => {
    const a = withLine('a', [[21.0, 52.2], [21.1, 52.3]]);
    const b = withLine('b', [[21.0, 52.3], [21.1, 52.2]], 85);
    const c = withLine('c', [[21.0, 52.3], [21.1, 52.2]], 120); // 40 m above: no warning
    const map = findCrossings([a, b, c], 10);
    expect(map.get('a')?.map((x) => x.otherId)).toEqual(['b']);
    expect(map.get('b')?.[0].point.latitude).toBeCloseTo(52.25);
    expect(map.has('c')).toBe(false);
  });

  it('ignores hidden drones and routes that are not ready', () => {
    const a = withLine('a', [[21.0, 52.2], [21.1, 52.3]]);
    const hidden = withLine('b', [[21.0, 52.3], [21.1, 52.2]], 80, { visible: false });
    expect(findCrossings([a, hidden], 10).size).toBe(0);
    const stale = updateDrone([withLine('b', [[21.0, 52.3], [21.1, 52.2]])], 'b', { altitude: 85 })[0];
    expect(findCrossings([a, stale], 10).size).toBe(0);
  });
});

describe('fleet: playback points (for a future animation)', () => {
  it('spreads the ETA over the route by distance', () => {
    const d = ready(drone());
    const r = (d.route as { response: ReturnType<typeof routeResponse> }).response;
    const pts = playbackPoints(r);
    expect(pts.length).toBe(r.geometry!.coordinates.length);
    expect(pts[0].tS).toBe(0);
    expect(pts[pts.length - 1].tS).toBeCloseTo(r.etaS!);
    expect(pts.every((p, i) => i === 0 || p.tS >= pts[i - 1].tS)).toBe(true);
    expect(playbackPoints({ ...r, geometry: null })).toEqual([]);
  });
});
