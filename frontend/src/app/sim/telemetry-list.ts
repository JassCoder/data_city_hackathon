import { ChangeDetectionStrategy, Component, inject, output } from '@angular/core';

import { IconComponent } from '../ui/icon';
import { STATE_LABEL } from './event-feed';
import { AIRBORNE, SimState } from './sim-models';
import { DroneTelemetry, SimSession } from './sim-session';

/** Badge colour per state (the label always says the state; the map adds shapes). */
export const STATE_BADGE: Record<SimState, string> = {
  IDLE: 'badge-neutral',
  LOADING: 'badge-neutral',
  CHARGING: 'badge-ok',
  TAKEOFF: 'badge-accent',
  CRUISE: 'badge-accent',
  DELIVERING: 'badge-accent',
  RETURNING: 'badge-accent',
  LANDING: 'badge-accent',
  HOLDING: 'badge-warn',
  EMERGENCY_LANDING: 'badge-danger',
  FAILED: 'badge-danger',
};

export function formatEta(s: number | null): string {
  if (s === null) return '—';
  const total = Math.round(s);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/** Live telemetry, one row per drone (refreshed with the panels, not per frame). Click = select and follow. */
@Component({
  selector: 'app-telemetry-list',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent],
  styleUrl: './telemetry-list.scss',
  template: `
    <section aria-labelledby="tl-title" data-testid="telemetry">
      <div class="tl-head">
        <h3 id="tl-title">Drones <span class="count num">{{ sim.telemetry().length }}</span></h3>
        <button type="button" class="btn btn-s" [attr.aria-pressed]="sim.follow()" [disabled]="!sim.selectedId()"
                (click)="sim.follow.set(!sim.follow())" data-testid="follow-toggle"
                [title]="sim.selectedId() ? 'Keep the selected drone in view' : 'Select a drone first'">
          <app-icon name="target" />Follow
        </button>
        <button type="button" class="btn btn-s" [disabled]="!sim.selectedId()" (click)="details.emit()" data-testid="details-open">
          <app-icon name="info" />Details
        </button>
      </div>
      <ul class="tl-list" aria-label="Drones">
        @for (d of sim.telemetry(); track d.id) {
          <li>
            <button type="button" class="tl-row" [class.selected]="d.id === sim.selectedId()" [attr.aria-pressed]="d.id === sim.selectedId()"
                    [style.--drone]="d.color" [attr.data-state]="d.pose.state" (click)="pick(d)" [attr.data-testid]="'tl-' + d.id"
                    [attr.aria-label]="label(d)">
              <span class="tl-line">
                <span class="dot" aria-hidden="true"></span>
                <span class="tl-name">{{ d.name }}</span>
                <span class="badge" [class]="'badge ' + badge[d.pose.state]" data-testid="tl-state">
                  @if (alarm(d)) {
                    <app-icon name="alert" />
                  }
                  {{ stateLabel[d.pose.state] }}
                </span>
              </span>
              <span class="tl-stats num" aria-hidden="true">
                <span class="tl-bat" [attr.data-level]="level(d)"><i [style.width.%]="d.pose.batteryPct"></i></span>
                <span class="tl-v">{{ d.pose.batteryPct.toFixed(0) }} %</span>
                @if (flying(d)) {
                  <span class="tl-v">{{ d.pose.speedMps.toFixed(1) }} m/s</span>
                  <span class="tl-v">{{ d.pose.altitudeM.toFixed(0) }} m</span>
                  <span class="tl-v">ETA {{ eta(d.etaS) }}</span>
                }
              </span>
              @if (d.progress !== null) {
                <span class="tl-progress" aria-hidden="true"><i [style.width.%]="d.progress * 100"></i></span>
                <span class="tl-target muted">to {{ d.target }}</span>
              }
            </button>
          </li>
        }
      </ul>
    </section>
  `,
})
export class TelemetryListComponent {
  protected readonly sim = inject(SimSession);
  /** A row was picked (the page opens the details). */
  readonly picked = output<string>();
  /** "Details" was pressed for the selected drone. */
  readonly details = output<void>();
  protected readonly badge = STATE_BADGE;
  protected readonly stateLabel = STATE_LABEL;
  protected readonly eta = formatEta;

  protected flying(d: DroneTelemetry): boolean {
    return AIRBORNE.has(d.pose.state);
  }

  protected alarm(d: DroneTelemetry): boolean {
    return d.pose.state === 'HOLDING' || d.pose.state === 'EMERGENCY_LANDING' || d.pose.state === 'FAILED';
  }

  protected level(d: DroneTelemetry): string {
    const reserve = this.sim.info()?.drones.find((x) => x.id === d.id)?.minReservePct ?? 20;
    return d.pose.batteryPct <= reserve ? 'critical' : d.pose.batteryPct <= 2 * reserve ? 'low' : 'ok';
  }

  protected label(d: DroneTelemetry): string {
    const p = d.pose;
    const parts = [`${d.name}, ${STATE_LABEL[p.state]}`, `battery ${p.batteryPct.toFixed(0)} %`];
    if (this.flying(d)) parts.push(`${p.speedMps.toFixed(1)} m/s`, `${p.altitudeM.toFixed(0)} m`);
    if (d.etaS !== null) parts.push(`arrives in ${formatEta(d.etaS)}`);
    return parts.join(', ');
  }

  protected pick(d: DroneTelemetry): void {
    this.sim.select(d.id);
    this.sim.follow.set(true);
    this.picked.emit(d.id);
  }
}
