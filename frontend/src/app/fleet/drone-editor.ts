import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { FleetStore } from '../core/fleet.store';
import { droneIssues } from '../core/fleet';
import { HealthService } from '../core/health';
import { FlightMode } from '../core/models';
import { PlannerApi } from '../core/planner-api';
import {
  MODE_HELP,
  MissionId,
  OBJECTIVE_LABEL,
  OPTIMISATIONS,
  OptimisationId,
  lockedObjective,
  missionHelp,
  missionsFor,
  optimisation,
} from '../core/routing-options';
import { IconComponent } from '../ui/icon';
import { AltitudeInputComponent } from './altitude-input';
import { PointFieldComponent } from './point-field';

let seq = 0;

/** The inline form of one drone: points, flight mode + mission, optimisation, altitude, drone. */
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
            @for (m of modes; track m.value) {
              <label><input type="radio" [name]="ids + '-mode'" [value]="m.value" [checked]="d.mode === m.value"
                            (change)="setMode(m.value)" /><span>{{ m.label }}</span></label>
            }
          </div>
          <p class="field-hint" data-testid="mode-help">{{ modeHelp[d.mode] }}</p>
          <div class="segmented" role="radiogroup" aria-label="Mission" data-testid="mission">
            @for (m of missions(); track m.id) {
              <label><input type="radio" [name]="ids + '-mission'" [value]="m.id" [checked]="d.mission === m.id"
                            (change)="setMission(m.id)" /><span>{{ m.label }}</span></label>
            }
          </div>
          @if (missionText(); as t) {
            <p class="field-hint" data-testid="mission-help">{{ t }}</p>
          }
        </fieldset>

        <fieldset class="group" [attr.aria-describedby]="ids + '-opt-help'">
          <legend class="field-label">Route optimisation</legend>
          <div class="segmented grid-2" role="radiogroup" aria-label="Route optimisation" data-testid="optimisation">
            @for (o of optimisations; track o.id) {
              <label><input type="radio" [name]="ids + '-opt'" [value]="o.id" [disabled]="!!locked()"
                            [checked]="locked() ? lockedOption() === o.id : d.optimisation === o.id"
                            (change)="setOptimisation(o.id)" /><span>{{ o.label }}</span></label>
            }
          </div>
          <p class="field-hint" [id]="ids + '-opt-help'" data-testid="optimisation-help">
            @if (locked(); as l) {
              {{ objectiveLabel[l] }}, set by the {{ missionLabel() }} mission.
            } @else {
              {{ optimisationHelp() }}
            }
          </p>
          @if (safestUnavailable()) {
            <p class="field-error" role="alert">Safest is unavailable: the server has not loaded the risk layers.</p>
          }
        </fieldset>

        <app-altitude-input [value]="d.altitude" (valueChange)="fleet.setAltitude(d.id, $event)" />

        <div class="row-2">
          <div class="field">
            <label class="field-label" [for]="ids + '-profile'">Drone profile</label>
            <select [id]="ids + '-profile'" class="input" [value]="d.profileId" (change)="fleet.setProfile(d.id, $any($event.target).value)"
                    data-testid="profile">
              @for (p of profiles(); track p.id) {
                <option [value]="p.id" [selected]="p.id === d.profileId">{{ p.name }}</option>
              }
            </select>
          </div>
          <div class="field">
            <label class="field-label" [for]="ids + '-payload'">Payload (kg)</label>
            <input [id]="ids + '-payload'" class="input num" type="number" inputmode="decimal" min="0"
                   [max]="maxPayload()" step="0.1" [value]="d.payloadKg ?? ''" placeholder="Default"
                   (change)="setPayload($any($event.target).value)" [attr.aria-invalid]="payloadError() ? true : null" />
          </div>
        </div>
        @if (payloadError(); as e) {
          <p class="field-error" role="alert">{{ e }}</p>
        }

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
    .row-2 {
      display: grid;
      grid-template-columns: 1fr 96px;
      gap: var(--sp-2);
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
  private readonly api = inject(PlannerApi);
  private readonly health = inject(HealthService);

  protected readonly ids = `ed-${++seq}`;
  protected readonly modes: { value: FlightMode; label: string }[] = [
    { value: 'NORMAL', label: 'Normal' },
    { value: 'EMERGENCY', label: 'Emergency' },
  ];
  protected readonly modeHelp = MODE_HELP;
  protected readonly optimisations = OPTIMISATIONS;
  protected readonly objectiveLabel = OBJECTIVE_LABEL;

  protected readonly drone = computed(() => this.fleet.drones().find((d) => d.id === this.droneId()));
  protected readonly profiles = computed(() => this.api.profileList() ?? []);
  protected readonly missions = computed(() => missionsFor(this.drone()?.mode ?? 'NORMAL'));
  protected readonly missionLabel = computed(() => this.missions().find((m) => m.id === this.drone()?.mission)?.label.toLowerCase());
  protected readonly missionText = computed(() => {
    const d = this.drone();
    return d ? missionHelp(d.mission, this.api.scenarioList()) : null;
  });
  /** A mission's scenario fixes the objective; the control then shows it, disabled. */
  protected readonly locked = computed(() => {
    const d = this.drone();
    return d ? lockedObjective(d.mission, this.api.scenarioList()) : null;
  });
  protected readonly lockedOption = computed(() => OPTIMISATIONS.find((o) => o.objective === this.locked())?.id ?? null);
  protected readonly optimisationHelp = computed(() => optimisation(this.drone()?.optimisation ?? 'BALANCED').help);
  protected readonly safestUnavailable = computed(
    () => !this.locked() && this.drone()?.optimisation === 'SAFEST' && this.health.riskDataMissing(),
  );
  protected readonly maxPayload = computed(
    () => this.profiles().find((p) => p.id === this.drone()?.profileId)?.maxPayloadKg ?? null,
  );
  protected readonly payloadError = computed(() => {
    const d = this.drone();
    const max = this.maxPayload();
    if (!d || d.payloadKg === null) return null;
    if (d.payloadKg < 0) return 'Payload cannot be negative.';
    return max !== null && d.payloadKg > max ? `This profile carries at most ${max} kg.` : null;
  });
  protected readonly issues = computed(() => {
    const d = this.drone();
    if (!d) return [];
    const p = this.payloadError();
    return [...droneIssues(d), ...(p ? [p] : [])];
  });

  protected setMode(mode: FlightMode): void {
    this.fleet.setMode(this.droneId(), mode);
  }

  protected setMission(id: MissionId): void {
    this.fleet.setMission(this.droneId(), id);
  }

  protected setOptimisation(id: OptimisationId): void {
    this.fleet.setOptimisation(this.droneId(), id);
  }

  protected setPayload(raw: string): void {
    const v = raw.trim() === '' ? null : Number(raw);
    this.fleet.setPayload(this.droneId(), v === null || Number.isFinite(v) ? v : null);
  }

  protected calculate(): void {
    if (!this.issues().length) this.fleet.calculate(this.droneId());
  }
}
