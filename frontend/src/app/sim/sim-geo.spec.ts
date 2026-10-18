import { STATES, code, row, sessionInfo } from '../../testing/sim-fixtures';
import { poseOf } from './interpolation';
import { busyStations, metres } from './sim-geo';

const PAD = sessionInfo().stations[0]; // East pad at 21.02, 52.24
const at = (state: Parameters<typeof code>[0], dLon = 0) =>
  poseOf(row({ longitude: PAD.longitude + dLon, latitude: PAD.latitude, state: code(state) }), STATES);

describe('sim geometry', () => {
  it('measures short distances in metres', () => {
    expect(metres(21.0, 52.23, 21.0, 52.24)).toBeCloseTo(1105, -1);
    expect(metres(21.0, 52.23, 21.01, 52.23)).toBeCloseTo(682, -1);
    expect(metres(21, 52, 21, 52)).toBe(0);
  });

  it('highlights stations where drones land or charge, within the tolerance', () => {
    const busy = busyStations([at('CHARGING'), at('CRUISE'), at('LANDING', 0.0002)], [PAD], 50);
    expect(busy.get('st-east')).toEqual({ activity: 'landing', drones: [0, 2] });
    expect(busyStations([at('CHARGING')], [PAD], 50).get('st-east')?.activity).toBe('charging');
    expect(busyStations([at('LANDING', 0.002)], [PAD], 50).size).toBe(0); // ~136 m away
    expect(busyStations([at('IDLE'), at('HOLDING')], [PAD], 50).size).toBe(0);
    expect(busyStations([at('EMERGENCY_LANDING')], [PAD], 50).get('st-east')?.activity).toBe('landing');
  });
});
