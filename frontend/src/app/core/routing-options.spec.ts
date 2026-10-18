import { SCENARIOS } from '../../testing/fixtures';
import { MISSIONS, OPTIMISATIONS, defaultMission, lockedObjective, missionHelp, missionsFor } from './routing-options';

describe('routing options', () => {
  it('splits missions by flight mode, with a general option first', () => {
    expect(missionsFor('NORMAL').map((m) => m.id)).toEqual(['GENERAL', 'AVOID_PROHIBITED_ZONE']);
    expect(missionsFor('EMERGENCY').map((m) => m.id)).toEqual(['GENERAL_EMERGENCY', 'BLOOD_DELIVERY', 'AED_DELIVERY']);
    expect(defaultMission('EMERGENCY')).toBe('GENERAL_EMERGENCY');
  });

  it('every mission mode is allowed by its backend scenario', () => {
    for (const m of MISSIONS.filter((x) => x.scenario)) {
      const cfg = SCENARIOS.scenarios.find((c) => c.id === m.scenario)!;
      expect(cfg.allowedModes ?? [cfg.mode]).toContain(m.mode);
    }
  });

  it('a mission locks the objective its scenario sets; general missions do not', () => {
    const list = SCENARIOS.scenarios;
    expect(lockedObjective('GENERAL', list)).toBeNull();
    expect(lockedObjective('AVOID_PROHIBITED_ZONE', list)).toBe('SHORTEST');
    expect(lockedObjective('BLOOD_DELIVERY', list)).toBe('FASTEST');
    expect(lockedObjective('BLOOD_DELIVERY', undefined)).toBeNull(); // scenarios not loaded yet
    expect(missionHelp('AED_DELIVERY', list)).toBe(list.find((c) => c.id === 'AED_DELIVERY')!.description);
  });

  it('names one backend objective per optimisation (weights stay in backend config)', () => {
    expect(OPTIMISATIONS.map((o) => [o.id, o.objective])).toEqual([
      ['BALANCED', 'CORRIDORS'],
      ['FASTEST', 'FASTEST'],
      ['SAFEST', 'SAFEST'],
      ['LOWEST_ENERGY', 'LOWEST_ENERGY'],
    ]);
  });
});
