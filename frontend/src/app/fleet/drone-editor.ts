import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { FleetStore } from '../core/fleet.store';
import { droneIssues } from '../core/fleet';
import { HealthService } from '../core/health';
import { FlightMode } from '../core/models';
import { MODE_LABEL, OPTIMISATIONS, OptimisationId } from '../core/routing-options';
import { IconComponent } from '../ui/icon';
import { AltitudeInputComponent } from './altitude-input';
import { PointFieldComponent } from './point-field';

let seq = 0;

/** The inline form of one drone: points, flight mode, optimisation, altitude. */
@Component({
  selector: 'app-drone-editor',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [PointFieldComponent, AltitudeInputComponent, IconComponent],
  template: `
    @if (drone(); as d) {
      <form class="editor" (submit)="$event.preventDefault(); calculate()" [attr.aria-label]="'Settings of ' + d.name"
            data-testid="drone-editor">
        <div class="field">
          <label class="field-label" [for]="ids + '-name'">Name</label>
          <input [id]="ids + '-name'" class="input" name="name" autocomplete="off" [value]="d.name"
                 (change)="fleet.rename(d.id, $any($event.target).value)" data-testid="drone-name" />
        </div>

        <fieldset class="group points">
          <legend class="field-label">Route</legend>
          <app-point-field [droneId]="d.id" role="start" [color]="d.color" />
          <div class="point-actions">
            <button type="button" class="btn btn-s btn-ghost" (click)="fleet.swap(d.id)"
                    [disabled]="!d.start && !d.destination" data-testid="swap">
              <app-icon name="swap" />Swap A and B
            </button>
            <button type="button" class="btn btn-s btn-ghost" (click)="fleet.clearPoints(d.id)"
                    [disabled]="!d.start && !d.destination" data-testid="clear-points">Clear points</button>
          </div>
          <app-point-field [droneId]="d.id" role="destination" [color]="d.color" />
        </fieldset>

        <fieldset class="group">
          <legend class="field-label">Flight mode</legend>
          <div class="segmented" role="radiogroup" aria-label="Flight mode" data-testid="mode">
            @for (m of modes; track m) {
              <label><input type="radio" [name]="ids + '-mode'" [value]="m" [checked]="d.mode === m"
                            (change)="setMode(m)" /><span>{{ modeLabel[m] }}</span></label>
            }
          </div>
        </fieldset>

        <fieldset class="group">
          <legend class="field-label">Route optimisation</legend>
          <div class="segmented grid-2" role="radiogroup" aria-label="Route optimisation" data-testid="optimisation">
            @for (o of optimisations; track o.id) {
              <label><input type="radio" [name]="ids + '-opt'" [value]="o.id" [checked]="d.optimisation === o.id"
                            (change)="setOptimisation(o.id)" /><span>{{ o.label }}</span></label>
            }
          </div>
          @if (safestUnavailable()) {
            <p class="field-error" role="alert">Safest is unavailable: the server has not loaded the risk layers.</p>
          }
        </fieldset>

        <app-altitude-input [value]="d.altitude" (valueChange)="fleet.setAltitude(d.id, $event)" />

        @if (issues().length) {
          <ul class="issues" aria-live="polite" data-testid="drone-issues">
            @for (i of issues(); track i) {
              <li>{{ i }}</li>
            }
          </ul>
        }

        <div class="actions">
          <button type="submit" class="btn btn-primary" [disabled]="issues().length > 0 || d.route.phase === 'calculating'"
                  data-testid="calculate">
            @if (d.route.phase === 'calculating') {
              <span class="spinner" aria-hidden="true"></span>Calculating…
            } @else {
              <app-icon name="route" />Calculate route
            }
          </button>
          <button type="button" class="btn" (click)="fleet.edit(null)" data-testid="done">Done</button>
        </div>
      </form>
    }
  `,
  styles: `
    .editor {
      display: grid;
      gap: var(--sp-4);
      padding: var(--sp-3);
      border: 1px solid var(--c-line);
      border-radius: var(--radius-m);
      background: var(--c-surface-2);
    }
    .group {
      display: grid;
      gap: var(--sp-2);
      margin: 0;
      padding: 0;
      border: 0;
      min-width: 0;
    }
    legend {
      padding: 0;
      margin-bottom: var(--sp-1);
    }
    .point-actions {
      display: flex;
      gap: var(--sp-1);
      margin-left: 22px;
    }
    .segmented.grid-2 {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 2px;
    }
    .issues {
      margin: 0;
      padding: var(--sp-2) var(--sp-2) var(--sp-2) var(--sp-5);
      border-radius: var(--radius-s);
      background: var(--c-warn-soft);
      color: var(--c-warn);
      font-size: var(--fs-12);
    }
    .actions {
      display: flex;
      gap: var(--sp-2);
    }
    .actions .btn-primary {
      flex: 1;
    }
  `,
})
export class DroneEditorComponent {
  readonly droneId = input.required<string>();

  protected readonly fleet = inject(FleetStore);
  private readonly health = inject(HealthService);

  protected readonly ids = `ed-${++seq}`;
  protected readonly modes: FlightMode[] = ['NORMAL', 'EMERGENCY'];
  protected readonly modeLabel = MODE_LABEL;
  protected readonly optimisations = OPTIMISATIONS;

  protected readonly drone = computed(() => this.fleet.drones().find((d) => d.id === this.droneId()));
  protected readonly safestUnavailable = computed(
    () => this.drone()?.optimisation === 'SAFEST' && this.health.riskDataMissing(),
  );
  protected readonly issues = computed(() => {
    const d = this.drone();
    return d ? droneIssues(d) : [];
  });

  protected setMode(mode: FlightMode): void {
    this.fleet.setMode(this.droneId(), mode);
  }

  protected setOptimisation(id: OptimisationId): void {
    this.fleet.setOptimisation(this.droneId(), id);
  }

  protected calculate(): void {
    if (!this.issues().length) this.fleet.calculate(this.droneId());
  }
}
