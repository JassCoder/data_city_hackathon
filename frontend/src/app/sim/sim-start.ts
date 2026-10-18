import { ChangeDetectionStrategy, Component, computed, inject, input, linkedSignal, output } from '@angular/core';
import { httpResource } from '@angular/common/http';

import { API_BASE_URL, safeValue } from '../core/api';
import { FleetStore } from '../core/fleet.store';
import { IconComponent } from '../ui/icon';
import { fleetToScenario, plannedDrones } from './fleet-scenario';
import { ScenarioSummary } from './sim-models';

export type StartChoice = { scenarioId: string; seed?: number } | { scenario: Record<string, unknown>; seed?: number };

const FLEET = 'fleet';

/** Empty state of the simulation view: choose a scenario (or the planned drones) and start. */
@Component({
  selector: 'app-sim-start',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent],
  styleUrl: './sim-start.scss',
  template: `
    <section class="sim-start" aria-labelledby="sim-start-title" data-testid="sim-start">
      <h2 id="sim-start-title">Run a simulation</h2>
      <p class="muted">
        Drones fly their missions over Warsaw on synthetic DEMO airspace. While it runs you can draw a temporary
        zone, change the wind or fail a drone and watch how the others react.
      </p>

      @if (scenarios.isLoading()) {
        <p class="state" role="status"><span class="spinner"></span> Loading scenarios…</p>
      } @else if (scenarios.error()) {
        <div class="state state-error" role="alert">
          <p>Scenarios could not be loaded. Is the backend running on port 8000?</p>
          <button type="button" class="btn btn-s" (click)="scenarios.reload()">Try again</button>
        </div>
      } @else {
        <fieldset class="choices">
          <legend class="field-label">Scenario</legend>
          @for (s of list(); track s.id) {
            <label class="choice" [attr.data-testid]="'scenario-' + s.id">
              <input type="radio" name="sim-scenario" [value]="s.id" [checked]="chosen() === s.id" (change)="choose(s.id)" />
              <span class="choice-body">
                <span class="choice-name">{{ s.name }}</span>
                <span class="choice-meta">{{ s.drones }} drones, {{ s.missions }} missions{{ s.events ? ', ' + s.events + ' timed events' : '' }}</span>
                @if (s.description) {
                  <span class="choice-desc">{{ s.description }}</span>
                }
              </span>
            </label>
          }
          <label class="choice" [class.disabled]="!planned().length" data-testid="scenario-fleet">
            <input type="radio" name="sim-scenario" value="fleet" [checked]="chosen() === 'fleet'"
                   [disabled]="!planned().length" (change)="choose('fleet')" />
            <span class="choice-body">
              <span class="choice-name">My planned drones</span>
              @if (planned().length) {
                <span class="choice-meta">{{ planned().length }} drone{{ planned().length === 1 ? '' : 's' }} from Plan, one mission each</span>
              } @else {
                <span class="choice-meta">Give a drone Point A and B in Plan first.</span>
              }
            </span>
          </label>
        </fieldset>

        <label class="field seed">
          <span class="field-label">Seed</span>
          <input class="input num" type="number" inputmode="numeric" step="1" [value]="seed()" (input)="setSeed($event)"
                 data-testid="sim-seed" aria-describedby="seed-hint" />
          <span id="seed-hint" class="field-hint">The same scenario and seed always play out the same way.</span>
        </label>

        <button type="button" class="btn btn-primary btn-block" [disabled]="!chosen() || starting()" (click)="go()"
                data-testid="sim-start-btn">
          @if (starting()) {
            <span class="spinner"></span> Starting…
          } @else {
            <app-icon name="play" /> Start simulation
          }
        </button>
      }
    </section>
  `,
})
export class SimStartComponent {
  readonly start = output<StartChoice>();
  readonly starting = input(false);

  private readonly fleet = inject(FleetStore);
  protected readonly scenarios = httpResource<ScenarioSummary[]>(() => `${API_BASE_URL}/simulations/scenarios`);
  protected readonly list = computed(() => safeValue(this.scenarios) ?? []);
  protected readonly planned = computed(() => plannedDrones(this.fleet.drones()));
  protected readonly chosen = linkedSignal<string | null>(() => this.list()[0]?.id ?? null);
  protected readonly seed = linkedSignal<number>(() => this.list().find((s) => s.id === this.chosen())?.seed ?? 1);

  protected choose(id: string): void {
    this.chosen.set(id);
  }

  protected setSeed(e: Event): void {
    const v = Math.trunc(Number((e.target as HTMLInputElement).value));
    if (Number.isFinite(v)) this.seed.set(v);
  }

  protected go(): void {
    const id = this.chosen();
    if (!id) return;
    if (id === FLEET) {
      const built = fleetToScenario(this.fleet.drones(), new Date(), this.seed());
      if (built) this.start.emit({ scenario: built.scenario });
      return;
    }
    this.start.emit({ scenarioId: id, seed: this.seed() });
  }
}
