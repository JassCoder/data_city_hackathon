import { OPTIMISATIONS } from './routing-options';

describe('routing options', () => {
  it('names one backend objective per optimisation (weights stay in backend config)', () => {
    expect(OPTIMISATIONS.map((o) => [o.id, o.objective])).toEqual([
      ['BALANCED', 'CORRIDORS'],
      ['FASTEST', 'FASTEST'],
      ['SAFEST', 'SAFEST'],
      ['LOWEST_ENERGY', 'LOWEST_ENERGY'],
    ]);
  });
});
