import { ROUTE, STATES, code, cruiseFrame, row } from '../../testing/sim-fixtures';
import { interpolateFrame, interpolateRow, lerpAngle, pointAlong, poseOf, segmentAt, splitRoute } from './interpolation';
import { F } from './sim-models';

describe('interpolation', () => {
  it('turns headings along the shorter arc and stays in [0, 360)', () => {
    expect(lerpAngle(350, 10, 0.5)).toBeCloseTo(0);
    expect(lerpAngle(10, 350, 0.5)).toBeCloseTo(0);
    expect(lerpAngle(10, 350, 0.25)).toBeCloseTo(5);
    expect(lerpAngle(90, 180, 0.5)).toBeCloseTo(135);
    expect(lerpAngle(0, 0, 0.7)).toBe(0);
    for (const [a, b, t] of [[359, 1, 0.9], [1, 359, 0.9], [180, 0, 0.3]]) {
      const h = lerpAngle(a, b, t);
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThan(360);
    }
  });

  it('finds points along a route by distance, clamped to its ends', () => {
    expect(segmentAt(ROUTE.cumM, 0)).toBe(0);
    expect(segmentAt(ROUTE.cumM, 999)).toBe(0);
    expect(segmentAt(ROUTE.cumM, 1000)).toBe(1);
    expect(segmentAt(ROUTE.cumM, 5000)).toBe(1);
    expect(pointAlong(ROUTE, 500)).toEqual([expect.closeTo(21.00735, 6), 52.23]);
    expect(pointAlong(ROUTE, 1500)).toEqual([21.0147, expect.closeTo(52.2345, 6)]);
    expect(pointAlong(ROUTE, -10)).toEqual(ROUTE.path[0]);
    expect(pointAlong(ROUTE, 99999)).toEqual(ROUTE.path[2]);
  });

  it('splits a route into the flown and the remaining part, meeting at the drone', () => {
    const { flown, ahead } = splitRoute(ROUTE, 1500);
    expect(flown.length).toBe(3);
    expect(ahead.length).toBe(2);
    expect(flown[flown.length - 1]).toEqual(ahead[0]);
    expect(flown[1]).toEqual(ROUTE.path[1]); // the corner is already flown
    const start = splitRoute(ROUTE, 0);
    expect(start.flown).toEqual([ROUTE.path[0], ROUTE.path[0]]);
  });

  it('moves a drone on the same route along the polyline, around corners', () => {
    // 900 m and 1100 m: straight-line interpolation would cut the corner at 1000 m.
    const a = row({ progressM: 900, route: 0, state: code('CRUISE'), longitude: 21.01323, latitude: 52.23 });
    const b = row({ progressM: 1100, route: 0, state: code('CRUISE'), longitude: 21.0147, latitude: 52.2309 });
    const mid = interpolateRow(a, b, 0.5, [ROUTE], STATES);
    expect(mid.progressM).toBe(1000);
    expect(mid.longitude).toBeCloseTo(21.0147, 6); // exactly at the corner
    expect(mid.latitude).toBeCloseTo(52.23, 6);
  });

  it('interpolates in a straight line when the route changes between frames', () => {
    const a = row({ longitude: 21.0, latitude: 52.23, route: 0, progressM: 900 });
    const b = row({ longitude: 21.002, latitude: 52.232, route: 1, progressM: 0 });
    const mid = interpolateRow(a, b, 0.5, [ROUTE], STATES);
    expect(mid.longitude).toBeCloseTo(21.001, 9);
    expect(mid.latitude).toBeCloseTo(52.231, 9);
    expect(mid.route).toBe(0); // the earlier frame's route until the later frame is reached
  });

  it('keeps the earlier state until the later frame and interpolates the battery', () => {
    const a = row({ state: code('CRUISE'), batteryPct: 50, headingDeg: 350 });
    const b = row({ state: code('HOLDING'), batteryPct: 48, headingDeg: 10 });
    const p = interpolateRow(a, b, 0.5, [], STATES);
    expect(p.state).toBe('CRUISE');
    expect(p.batteryPct).toBe(49);
    expect(p.headingDeg).toBeCloseTo(0);
    expect(interpolateRow(a, b, 1, [], STATES).state).toBe('HOLDING');
    expect(interpolateRow(a, b, 1.7, [], STATES)).toEqual(poseOf(b, STATES)); // clamped
    expect(interpolateRow(a, b, -1, [], STATES)).toEqual(poseOf(a, STATES));
  });

  it('interpolates every drone of a frame', () => {
    const poses = interpolateFrame(cruiseFrame(10), cruiseFrame(20), 0.5, [ROUTE], STATES);
    expect(poses.length).toBe(2);
    expect(poses[0].progressM).toBe(150);
    expect(poses[0].state).toBe('CRUISE');
    expect(poses[1].state).toBe('IDLE');
    expect(poses[1].route).toBe(-1);
    expect(cruiseFrame(10).d[0][F.route]).toBe(0);
  });
});
