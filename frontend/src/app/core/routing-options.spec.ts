import { MODE_HELP, OPTIMISATIONS, ZONE_RULE } from './routing-options';

describe('routing options', () => {
  it('names one backend objective per optimisation (weights stay in backend config)', () => {
    expect(OPTIMISATIONS.map((o) => [o.id, o.objective])).toEqual([
      ['BALANCED', 'CORRIDORS'],
      ['FASTEST', 'FASTEST'],
      ['SAFEST', 'SAFEST'],
      ['LOWEST_ENERGY', 'LOWEST_ENERGY'],
    ]);
  });

  it('says emergency grants no airspace permission and that zones are always avoided', () => {
    expect(MODE_HELP.EMERGENCY).toContain('grants no airspace permission');
    expect(ZONE_RULE).toContain('always avoided');
  });
});
