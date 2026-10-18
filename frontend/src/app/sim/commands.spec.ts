import { sessionInfo } from '../../testing/sim-fixtures';
import { Coordinate } from '../core/models';
import { canFail, failCommand, outlineCrossesItself, stepPlan, windCommand, zoneCommand } from './commands';

const LIMITS = sessionInfo().limits;
const OPTS = { chunkWallS: 0.5, framesPerWallSecond: 12, maxTicks: 600 };
const c = (latitude: number, longitude: number): Coordinate => ({ latitude, longitude });
const SQUARE = [c(52.23, 21.0), c(52.23, 21.01), c(52.24, 21.01), c(52.24, 21.0)];

describe('commands', () => {
  it('steps enough ticks for half a second of playback at each speed', () => {
    expect([1, 5, 20, 60].map((s) => stepPlan(s, 1, OPTS))).toEqual([
      { ticks: 1, stride: 1 },
      { ticks: 3, stride: 1 },
      { ticks: 10, stride: 1 },
      { ticks: 30, stride: 5 },
    ]);
    expect(stepPlan(60, 2, OPTS)).toEqual({ ticks: 15, stride: 2 });
    expect(stepPlan(60, 1, { ...OPTS, maxTicks: 4 })).toEqual({ ticks: 4, stride: 4 }); // never beyond the API limit
  });

  it('builds a zone command with [lon, lat] corners, from the ground to the cap', () => {
    const r = zoneCommand([...SQUARE, SQUARE[0]], { upperM: 120.4, durationMin: 15, name: '  Fire  ' }, LIMITS);
    expect(r).toEqual({
      ok: true,
      command: {
        type: 'zone',
        polygon: [[21.0, 52.23], [21.01, 52.23], [21.01, 52.24], [21.0, 52.24]], // closing corner dropped
        lowerM: 0,
        upperM: 120,
        durationS: 900,
        name: 'Fire',
      },
    });
    const unnamed = zoneCommand([c(52.2300001234, 21.0000004321), ...SQUARE.slice(1)], { upperM: 60, durationMin: 1 }, LIMITS);
    expect(unnamed.ok && unnamed.command.polygon[0]).toEqual([21.0, 52.23]);
    expect(unnamed.ok && 'name' in unnamed.command).toBe(false);
  });

  it('rejects zones the backend would reject, with a plain message', () => {
    const err = (r: ReturnType<typeof zoneCommand>) => (r.ok ? '' : r.error);
    expect(err(zoneCommand(SQUARE.slice(0, 2), { upperM: 120, durationMin: 5 }, LIMITS))).toContain('three corners');
    expect(err(zoneCommand([SQUARE[0], SQUARE[0], SQUARE[1]], { upperM: 120, durationMin: 5 }, LIMITS))).toContain('three corners');
    const bowTie = [SQUARE[0], SQUARE[2], SQUARE[1], SQUARE[3]];
    expect(outlineCrossesItself(bowTie)).toBe(true);
    expect(outlineCrossesItself(SQUARE)).toBe(false);
    expect(err(zoneCommand(bowTie, { upperM: 120, durationMin: 5 }, LIMITS))).toContain('crosses itself');
    expect(err(zoneCommand(SQUARE, { upperM: 0, durationMin: 5 }, LIMITS))).toContain('altitude cap');
    expect(err(zoneCommand(SQUARE, { upperM: 501, durationMin: 5 }, LIMITS))).toContain('between 1 and 500 m');
    expect(err(zoneCommand(SQUARE, { upperM: 120, durationMin: 0 }, LIMITS))).toContain('duration');
    expect(err(zoneCommand(SQUARE, { upperM: 120, durationMin: 241 }, LIMITS))).toContain('1 and 240 minutes');
    expect(err(zoneCommand(SQUARE, { upperM: NaN, durationMin: 5 }, LIMITS))).toContain('altitude cap');
    expect(err(zoneCommand(SQUARE, { upperM: 120, durationMin: 5 }, { ...LIMITS, zoneMaxVertices: 3 }))).toContain('at most 3');
  });

  it('builds a wind command with the direction normalised to [0, 360)', () => {
    expect(windCommand(20, 90, LIMITS)).toEqual({ ok: true, command: { type: 'wind', speedKmh: 20, directionDeg: 90 } });
    expect(windCommand(12.345, -90, LIMITS)).toEqual({ ok: true, command: { type: 'wind', speedKmh: 12.3, directionDeg: 270 } });
    expect(windCommand(5, 360, LIMITS)).toMatchObject({ ok: true, command: { directionDeg: 0 } });
    expect(windCommand(5, 359.99, LIMITS)).toMatchObject({ ok: true, command: { directionDeg: 0 } });
    expect(windCommand(101, 0, LIMITS)).toMatchObject({ ok: false });
    expect(windCommand(-1, 0, LIMITS)).toMatchObject({ ok: false });
    expect(windCommand(5, NaN, LIMITS)).toMatchObject({ ok: false });
  });

  it('only fails flying drones', () => {
    expect(failCommand('d1', 'CRUISE')).toEqual({ ok: true, command: { type: 'drone_failure', droneId: 'd1' } });
    expect(failCommand('d1', 'HOLDING').ok).toBe(true);
    expect(failCommand('d1', 'IDLE')).toEqual({ ok: false, error: 'Only a flying drone can be failed.' });
    expect(canFail('CHARGING')).toBe(false);
    expect(canFail('FAILED')).toBe(false);
    expect(canFail(undefined)).toBe(false);
  });
});
