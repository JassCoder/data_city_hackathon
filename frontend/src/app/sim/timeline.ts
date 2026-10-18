/**
 * Timeline maths (pure): scrubber position <-> simulated time, LIVE vs REPLAY, clock labels,
 * the history window to load when replaying, and what the event log says at a time
 * (active zones, wind).
 */

import { HistoryRange, SimEvent, SimWind } from './sim-models';

export type PlaybackMode = 'LIVE' | 'REPLAY';

export function clampTime(t: number, range: HistoryRange): number {
  return Math.min(Math.max(t, range.fromS), range.toS);
}

export function snapToTick(t: number, tickS: number): number {
  return Math.round(t / tickS) * tickS;
}

/** Scrubber position (0..1) of a time; an empty range sits at the end. */
export function timeToFraction(t: number, range: HistoryRange): number {
  const span = range.toS - range.fromS;
  if (span <= 0) return 1;
  return Math.min(Math.max((t - range.fromS) / span, 0), 1);
}

/** Time at a scrubber position, snapped to a tick and kept inside the stored history. */
export function fractionToTime(f: number, range: HistoryRange, tickS: number): number {
  const t = range.fromS + Math.min(Math.max(f, 0), 1) * (range.toS - range.fromS);
  return clampTime(snapToTick(t, tickS), range);
}

/** Playback at (or within half a tick of) the newest simulated time is live. */
export function modeAt(t: number, headT: number, tickS: number): PlaybackMode {
  return t >= headT - tickS / 2 ? 'LIVE' : 'REPLAY';
}

/** Coarser frames at high speed: about `framesPerWallSecond` frames per real second. */
export function strideFor(speed: number, tickS: number, framesPerWallSecond: number): number {
  return Math.max(1, Math.floor(speed / (tickS * framesPerWallSecond)));
}

/** Stored history to load for replaying from t: a trail behind it and some playback ahead. */
export function historyWindow(
  t: number,
  speed: number,
  range: HistoryRange,
  aheadWallS: number,
  behindS: number,
): HistoryRange {
  return { fromS: clampTime(t - behindS, range), toS: clampTime(t + Math.max(aheadWallS * speed, 10), range) };
}

/** "T+14:32" (or "T+1:02:03" from one hour on): time since the scenario start. */
export function formatElapsed(t: number): string {
  const s = Math.max(0, Math.floor(t + 1e-6));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h ? `T+${h}:${String(m).padStart(2, '0')}:${sec}` : `T+${m}:${sec}`;
}

const clockFormats = new Map<string, Intl.DateTimeFormat>();

/** Wall-clock time of the simulation (scenario start + t) in Warsaw time, e.g. "14:03:20". */
export function formatSimClock(startIso: string, t: number, timeZone = 'Europe/Warsaw'): string {
  let fmt = clockFormats.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, timeZone });
    clockFormats.set(timeZone, fmt);
  }
  return fmt.format(new Date(Date.parse(startIso) + t * 1000));
}

function scenarioEvents(events: readonly SimEvent[], t: number, kinds: string[]): SimEvent[] {
  return events.filter((e) => e.type === 'SCENARIO_EVENT' && e.tS <= t && kinds.includes(String(e.details['kind'])));
}

/** Ids of the scenario/drawn zones active at time t, from the zone events in the log. */
export function activeZoneIdsAt(events: readonly SimEvent[], t: number): Set<string> {
  const active = new Set<string>();
  for (const e of scenarioEvents(events, t, ['zone_activate', 'zone_deactivate'])) {
    const id = String(e.details['zoneId']);
    if (e.details['kind'] === 'zone_activate') active.add(id);
    else active.delete(id);
  }
  return active;
}

/** The (steady) wind at time t: the start wind changed by every wind event so far. */
export function windAt(events: readonly SimEvent[], t: number, initial: SimWind): SimWind {
  let wind = initial;
  for (const e of scenarioEvents(events, t, ['wind_change'])) {
    wind = { speedKmh: Number(e.details['speedKmh']), directionDeg: Number(e.details['directionDeg']) };
  }
  return wind;
}
