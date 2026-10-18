import { simEvent } from '../../testing/sim-fixtures';
import {
  activeZoneIdsAt,
  clampTime,
  formatElapsed,
  formatSimClock,
  fractionToTime,
  historyWindow,
  modeAt,
  snapToTick,
  strideFor,
  timeToFraction,
  windAt,
} from './timeline';

const RANGE = { fromS: 100, toS: 600 };

describe('timeline', () => {
  it('maps between scrubber position and simulated time', () => {
    expect(timeToFraction(100, RANGE)).toBe(0);
    expect(timeToFraction(350, RANGE)).toBe(0.5);
    expect(timeToFraction(9999, RANGE)).toBe(1);
    expect(timeToFraction(0, { fromS: 0, toS: 0 })).toBe(1); // nothing simulated yet: at the end
    expect(fractionToTime(0.5, RANGE, 1)).toBe(350);
    expect(fractionToTime(0.5013, RANGE, 1)).toBe(351); // snapped to a tick
    expect(fractionToTime(-1, RANGE, 1)).toBe(100);
    expect(fractionToTime(2, RANGE, 1)).toBe(600);
    expect(fractionToTime(0.5, RANGE, 5)).toBe(350);
    for (const t of [100, 250, 600]) expect(fractionToTime(timeToFraction(t, RANGE), RANGE, 1)).toBe(t);
  });

  it('clamps and snaps times', () => {
    expect(clampTime(50, RANGE)).toBe(100);
    expect(clampTime(700, RANGE)).toBe(600);
    expect(snapToTick(12.4, 1)).toBe(12);
    expect(snapToTick(12.6, 0.5)).toBe(12.5);
  });

  it('is live at the newest time and replaying before it', () => {
    expect(modeAt(600, 600, 1)).toBe('LIVE');
    expect(modeAt(599.6, 600, 1)).toBe('LIVE');
    expect(modeAt(599, 600, 1)).toBe('REPLAY');
    expect(modeAt(0, 600, 1)).toBe('REPLAY');
  });

  it('chooses a coarser stride at higher speed', () => {
    expect(strideFor(1, 1, 12)).toBe(1);
    expect(strideFor(5, 1, 12)).toBe(1);
    expect(strideFor(20, 1, 12)).toBe(1);
    expect(strideFor(60, 1, 12)).toBe(5);
    expect(strideFor(60, 2, 12)).toBe(2);
  });

  it('loads a trail behind the playhead and playback ahead, inside the history', () => {
    expect(historyWindow(300, 20, RANGE, 8, 90)).toEqual({ fromS: 210, toS: 460 });
    expect(historyWindow(120, 60, RANGE, 8, 90)).toEqual({ fromS: 100, toS: 600 });
    expect(historyWindow(300, 1, RANGE, 0, 90)).toEqual({ fromS: 210, toS: 310 }); // at least 10 s ahead
  });

  it('formats elapsed time and the Warsaw clock', () => {
    expect(formatElapsed(0)).toBe('T+0:00');
    expect(formatElapsed(872.9)).toBe('T+14:32');
    expect(formatElapsed(3723)).toBe('T+1:02:03');
    expect(formatSimClock('2026-10-17T14:00:00+02:00', 200)).toBe('14:03:20');
    expect(formatSimClock('2026-10-17T12:00:00Z', 0)).toBe('14:00:00'); // CEST
    expect(formatSimClock('2026-12-01T12:00:00Z', 0)).toBe('13:00:00'); // CET
  });

  it('derives the active zones and the wind at a time from the event log', () => {
    const events = [
      simEvent(0, 10, 'SCENARIO_EVENT', { kind: 'zone_activate', zoneId: 'z1' }, null),
      simEvent(1, 20, 'SCENARIO_EVENT', { kind: 'wind_change', speedKmh: 25, directionDeg: 90 }, null),
      simEvent(2, 30, 'SCENARIO_EVENT', { kind: 'zone_activate', zoneId: 'z2' }, null),
      simEvent(3, 40, 'SCENARIO_EVENT', { kind: 'zone_deactivate', zoneId: 'z1' }, null),
      simEvent(4, 40, 'REPLANNED', { zoneIds: ['z2'] }),
    ];
    expect([...activeZoneIdsAt(events, 5)]).toEqual([]);
    expect([...activeZoneIdsAt(events, 10)]).toEqual(['z1']);
    expect([...activeZoneIdsAt(events, 35)].sort()).toEqual(['z1', 'z2']);
    expect([...activeZoneIdsAt(events, 40)]).toEqual(['z2']);
    const initial = { speedKmh: 10, directionDeg: 270 };
    expect(windAt(events, 19, initial)).toEqual(initial);
    expect(windAt(events, 20, initial)).toEqual({ speedKmh: 25, directionDeg: 90 });
  });
});
