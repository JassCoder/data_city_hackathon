import { CENTRALNA, KOPERNIK } from '../../testing/fixtures';
import { Drone, createDrone } from '../core/fleet';
import { fleetToScenario, plannedDrones } from './fleet-scenario';

const DEFAULTS = { altitude: 80, profileId: 'DEMO_DRONE_01' };

function drone(id: string, over: Partial<Drone> = {}, others: Drone[] = []): Drone {
  return { ...createDrone(others, id, DEFAULTS), start: CENTRALNA, destination: KOPERNIK, ...over };
}

describe('fleetToScenario', () => {
  it('turns each planned drone into a drone at A with one mission to B', () => {
    const a = drone('x-1', { name: 'Blood run', mode: 'EMERGENCY', optimisation: 'SAFEST', altitude: 60 });
    const b = drone('x-2', { name: 'Draft', destination: null }, [a]);
    const result = fleetToScenario([a, b], new Date('2026-10-18T08:00:00Z'), 3)!;
    expect(result.skipped).toEqual(['Draft']);
    expect(result.scenario).toEqual({
      name: 'My planned drones',
      description: '1 drone from the route planner. Synthetic airspace; simulation only.',
      seed: 3,
      startTime: '2026-10-18T08:00:00.000Z',
      drones: [
        {
          id: 'p1',
          name: 'Blood run',
          color: a.color,
          profileId: 'DEMO_DRONE_01',
          position: { latitude: CENTRALNA.coordinate.latitude, longitude: CENTRALNA.coordinate.longitude },
        },
      ],
      missions: [
        {
          id: 'p1-m1',
          droneId: 'p1',
          destination: { latitude: KOPERNIK.coordinate.latitude, longitude: KOPERNIK.coordinate.longitude },
          mode: 'EMERGENCY',
          routeObjective: 'SAFEST',
          flightAltitudeMeters: 60,
        },
      ],
    });
  });

  it('maps the optimisation like the planner request does and needs at least one planned drone', () => {
    const balanced = drone('a', { optimisation: 'BALANCED' });
    const energy = drone('b', { optimisation: 'LOWEST_ENERGY' }, [balanced]);
    const missions = fleetToScenario([balanced, energy], new Date(0))!.scenario['missions'] as { routeObjective: string }[];
    expect(missions.map((m) => m.routeObjective)).toEqual(['CORRIDORS', 'LOWEST_ENERGY']);
    expect(fleetToScenario([drone('c', { start: null })], new Date(0))).toBeNull();
    expect(plannedDrones([])).toEqual([]);
  });
});
