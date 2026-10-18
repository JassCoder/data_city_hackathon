/**
 * The event feed (pure): severity of each engine event, plain-language text, filters,
 * and where an event happened (for "jump to").
 */

import { formatDistance } from '../ui/format';
import { SimEvent, SimState } from './sim-models';

export type Severity = 'critical' | 'warning' | 'info';
export const SEVERITIES: Severity[] = ['critical', 'warning', 'info'];
export const SEVERITY_LABEL: Record<Severity, string> = { critical: 'Critical', warning: 'Warning', info: 'Info' };

export const STATE_LABEL: Record<SimState, string> = {
  IDLE: 'Idle',
  LOADING: 'Loading',
  TAKEOFF: 'Taking off',
  CRUISE: 'Cruising',
  DELIVERING: 'Delivering',
  RETURNING: 'Returning',
  LANDING: 'Landing',
  CHARGING: 'Charging',
  HOLDING: 'Holding',
  EMERGENCY_LANDING: 'Emergency landing',
  FAILED: 'Failed',
};

const CRITICAL_TYPES = new Set(['EMERGENCY', 'FAILURE', 'MISSION_ABORTED']);
const WARNING_TYPES = new Set(['BATTERY_WARNING', 'REPLANNED', 'MISSION_REJECTED']);
const WARNING_SCENARIO = new Set(['zone_activate', 'drone_failure', 'battery_fault']);

export function eventSeverity(e: SimEvent): Severity {
  if (CRITICAL_TYPES.has(e.type)) return 'critical';
  if (e.type === 'STATE_CHANGED') {
    const to = e.details['to'];
    if (to === 'FAILED' || to === 'EMERGENCY_LANDING') return 'critical';
    if (to === 'HOLDING') return 'warning';
    return 'info';
  }
  if (WARNING_TYPES.has(e.type)) return 'warning';
  if (e.type === 'SCENARIO_EVENT' && WARNING_SCENARIO.has(String(e.details['kind']))) return 'warning';
  return 'info';
}

export interface FeedContext {
  droneName(id: string): string;
  zoneName(id: string): string;
}

export interface EventText {
  title: string;
  detail?: string;
}

const num = (v: unknown, digits = 0) => (typeof v === 'number' ? v.toFixed(digits) : '?');
const reason = (e: SimEvent) => (typeof e.details['reason'] === 'string' ? (e.details['reason'] as string) : undefined);

/** The zones an event refers to (drone reactions to a zone, zone events). */
export function eventZoneIds(e: SimEvent): string[] {
  const ids = e.details['zoneIds'];
  if (Array.isArray(ids)) return ids.map(String);
  return typeof e.details['zoneId'] === 'string' ? [e.details['zoneId'] as string] : [];
}

export function describeEvent(e: SimEvent, ctx: FeedContext): EventText {
  const d = e.details;
  const zones = eventZoneIds(e).map((id) => ctx.zoneName(id));
  switch (e.type) {
    case 'STATE_CHANGED':
      return {
        title: `${STATE_LABEL[d['from'] as SimState] ?? d['from']} → ${STATE_LABEL[d['to'] as SimState] ?? d['to']}`,
        detail: reason(e),
      };
    case 'MISSION_ASSIGNED':
      return { title: `Mission ${d['missionId']} assigned` };
    case 'MISSION_REJECTED':
      return { title: `Mission ${d['missionId']} rejected`, detail: reason(e) };
    case 'ROUTE_PLANNED':
      return { title: `Route planned (${d['leg']}, ${formatDistance(d['distanceM'] as number)})` };
    case 'REPLANNED':
      if (d['applied'] === false) return { title: `Inside ${zones.join(', ') || 'a zone'}: continuing out`, detail: reason(e) };
      if (d['leg'] === 'divert') return { title: `Diverting to ${d['target']}`, detail: reason(e) };
      return {
        title: zones.length ? `Re-routed around ${zones.join(', ')}` : 'Re-routed',
        detail: d['distanceM'] !== undefined ? `New route ${formatDistance(d['distanceM'] as number)}. ${reason(e) ?? ''}`.trim() : reason(e),
      };
    case 'DELIVERED':
      return { title: 'Parcel delivered' };
    case 'MISSION_COMPLETED':
      return {
        title: `Mission ${d['missionId']} completed at ${d['landedAt']}`,
        detail: d['energyUsedWh'] !== undefined ? `Used ${num(d['energyUsedWh'], 1)} Wh (planned ${num(d['plannedEnergyWh'], 1)} Wh)` : undefined,
      };
    case 'MISSION_ABORTED':
      return { title: `Mission ${d['missionId']} aborted`, detail: reason(e) };
    case 'BATTERY_WARNING':
      return { title: `Battery below ${num(d['levelPct'])} %` };
    case 'EMERGENCY':
      return { title: `Emergency landing: ${d['site']}`, detail: reason(e) };
    case 'CHARGED':
      return { title: 'Fully charged' };
    case 'FAILURE':
      return { title: 'Drone failed', detail: reason(e) };
    case 'SCENARIO_EVENT':
      switch (d['kind']) {
        case 'zone_activate':
          return { title: `Zone ${d['name']} active`, detail: `${num(d['lowerM'])}–${num(d['upperM'])} m above ground` };
        case 'zone_deactivate':
          return { title: `Zone ${zones[0] ?? d['zoneId']} lifted` };
        case 'wind_change':
          return { title: `Wind ${num(d['speedKmh'])} km/h from ${num(d['directionDeg'])}°` };
        case 'drone_failure':
          return { title: d['applied'] === false ? 'Failure ignored (on the ground)' : 'Failure injected', detail: reason(e) };
        case 'battery_fault':
          return { title: `Battery fault: −${num(d['lossPct'])} %` };
      }
      return { title: String(d['kind']) };
  }
  return { title: e.type };
}

export interface FeedFilter {
  droneId: string | null;
  severities: ReadonlySet<Severity>;
}

/** Events up to time t matching the filter, newest first, at most `limit`. */
export function filterEvents(events: readonly SimEvent[], filter: FeedFilter, t: number, limit: number): SimEvent[] {
  const out: SimEvent[] = [];
  for (let i = events.length - 1; i >= 0 && out.length < limit; i--) {
    const e = events[i];
    if (e.tS > t) continue;
    if (filter.droneId && e.droneId !== filter.droneId) continue;
    if (!filter.severities.has(eventSeverity(e))) continue;
    out.push(e);
  }
  return out;
}

/** Where an event happened ([lon, lat]) when it says so; otherwise the drone's position at that time is used. */
export function eventPlace(e: SimEvent): [number, number] | null {
  const pos = e.details['position'] ?? e.details['at'];
  if (Array.isArray(pos) && typeof pos[0] === 'number' && typeof pos[1] === 'number') return [pos[1], pos[0]]; // [lat, lon, …]
  return null;
}
