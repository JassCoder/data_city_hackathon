import { simEvent } from '../../testing/sim-fixtures';
import { FeedContext, Severity, describeEvent, eventPlace, eventSeverity, eventZoneIds, filterEvents } from './event-feed';

const CTX: FeedContext = {
  droneName: (id) => ({ d1: 'Courier 1', d2: 'Courier 2' })[id] ?? id,
  zoneName: (id) => ({ 'drawn-1': 'Drawn zone 1' })[id] ?? id,
};
const ALL = new Set<Severity>(['critical', 'warning', 'info']);

describe('event feed', () => {
  it('rates events by severity', () => {
    expect(eventSeverity(simEvent(0, 1, 'EMERGENCY'))).toBe('critical');
    expect(eventSeverity(simEvent(0, 1, 'FAILURE'))).toBe('critical');
    expect(eventSeverity(simEvent(0, 1, 'MISSION_ABORTED'))).toBe('critical');
    expect(eventSeverity(simEvent(0, 1, 'STATE_CHANGED', { to: 'EMERGENCY_LANDING' }))).toBe('critical');
    expect(eventSeverity(simEvent(0, 1, 'STATE_CHANGED', { to: 'HOLDING' }))).toBe('warning');
    expect(eventSeverity(simEvent(0, 1, 'STATE_CHANGED', { to: 'CRUISE' }))).toBe('info');
    expect(eventSeverity(simEvent(0, 1, 'BATTERY_WARNING'))).toBe('warning');
    expect(eventSeverity(simEvent(0, 1, 'REPLANNED'))).toBe('warning');
    expect(eventSeverity(simEvent(0, 1, 'MISSION_REJECTED'))).toBe('warning');
    expect(eventSeverity(simEvent(0, 1, 'SCENARIO_EVENT', { kind: 'zone_activate' }))).toBe('warning');
    expect(eventSeverity(simEvent(0, 1, 'SCENARIO_EVENT', { kind: 'wind_change' }))).toBe('info');
    expect(eventSeverity(simEvent(0, 1, 'DELIVERED'))).toBe('info');
  });

  it('describes events in plain language, naming the zones drones react to', () => {
    const re = simEvent(5, 100, 'REPLANNED', { zoneIds: ['drawn-1'], distanceM: 2340, reason: "zone 'Drawn zone 1' activated", leg: 'outbound' });
    expect(eventZoneIds(re)).toEqual(['drawn-1']);
    expect(describeEvent(re, CTX)).toEqual({
      title: 'Re-routed around Drawn zone 1',
      detail: "New route 2.34 km. zone 'Drawn zone 1' activated",
    });
    expect(describeEvent(simEvent(1, 1, 'REPLANNED', { applied: false, zoneIds: ['drawn-1'] }), CTX).title).toBe(
      'Inside Drawn zone 1: continuing out',
    );
    expect(describeEvent(simEvent(1, 1, 'REPLANNED', { leg: 'divert', target: 'East pad' }), CTX).title).toBe('Diverting to East pad');
    expect(describeEvent(simEvent(1, 1, 'STATE_CHANGED', { from: 'CRUISE', to: 'HOLDING', reason: 'no route' }), CTX)).toEqual({
      title: 'Cruising → Holding',
      detail: 'no route',
    });
    expect(describeEvent(simEvent(1, 1, 'SCENARIO_EVENT', { kind: 'zone_activate', name: 'Fire', lowerM: 0, upperM: 120 }), CTX)).toEqual({
      title: 'Zone Fire active',
      detail: '0–120 m above ground',
    });
    expect(describeEvent(simEvent(1, 1, 'SCENARIO_EVENT', { kind: 'zone_deactivate', zoneId: 'drawn-1' }), CTX).title).toBe(
      'Zone Drawn zone 1 lifted',
    );
    expect(describeEvent(simEvent(1, 1, 'SCENARIO_EVENT', { kind: 'wind_change', speedKmh: 20, directionDeg: 90 }), CTX).title).toBe(
      'Wind 20 km/h from 90°',
    );
    expect(describeEvent(simEvent(1, 1, 'BATTERY_WARNING', { levelPct: 30 }), CTX).title).toBe('Battery below 30 %');
    expect(describeEvent(simEvent(1, 1, 'EMERGENCY', { site: 'West pad', reason: 'battery low' }), CTX)).toEqual({
      title: 'Emergency landing: West pad',
      detail: 'battery low',
    });
    expect(
      describeEvent(simEvent(1, 1, 'MISSION_COMPLETED', { missionId: 'm1', landedAt: 'East pad', energyUsedWh: 41.2, plannedEnergyWh: 44 }), CTX),
    ).toEqual({ title: 'Mission m1 completed at East pad', detail: 'Used 41.2 Wh (planned 44.0 Wh)' });
    expect(describeEvent(simEvent(1, 1, 'SOMETHING_NEW'), CTX).title).toBe('SOMETHING_NEW');
  });

  it('filters by drone, severity and time, newest first', () => {
    const events = [
      simEvent(0, 10, 'STATE_CHANGED', { to: 'LOADING' }, 'd1'),
      simEvent(1, 20, 'BATTERY_WARNING', { levelPct: 40 }, 'd2'),
      simEvent(2, 30, 'EMERGENCY', {}, 'd1'),
      simEvent(3, 40, 'SCENARIO_EVENT', { kind: 'wind_change' }, null),
      simEvent(4, 50, 'FAILURE', {}, 'd2'),
    ];
    const seqs = (list: { seq: number }[]) => list.map((e) => e.seq);
    expect(seqs(filterEvents(events, { droneId: null, severities: ALL }, 999, 10))).toEqual([4, 3, 2, 1, 0]);
    expect(seqs(filterEvents(events, { droneId: null, severities: ALL }, 35, 10))).toEqual([2, 1, 0]); // not yet happened
    expect(seqs(filterEvents(events, { droneId: 'd1', severities: ALL }, 999, 10))).toEqual([2, 0]);
    expect(seqs(filterEvents(events, { droneId: null, severities: new Set<Severity>(['critical']) }, 999, 10))).toEqual([4, 2]);
    expect(seqs(filterEvents(events, { droneId: null, severities: ALL }, 999, 2))).toEqual([4, 3]);
  });

  it('knows where an event happened when the event says so ([lon, lat])', () => {
    expect(eventPlace(simEvent(0, 1, 'STATE_CHANGED', { position: [52.23, 21.01, 80] }))).toEqual([21.01, 52.23]);
    expect(eventPlace(simEvent(0, 1, 'DELIVERED', { at: [52.24, 21.02] }))).toEqual([21.02, 52.24]);
    expect(eventPlace(simEvent(0, 1, 'BATTERY_WARNING', { levelPct: 30 }))).toBeNull();
  });
});
