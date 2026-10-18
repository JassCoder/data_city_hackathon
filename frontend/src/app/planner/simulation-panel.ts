import { Component, inject } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { MatButtonModule } from '@angular/material/button';
import { MatButtonToggleModule } from '@angular/material/button-toggle';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { SIM_SPEEDS, SIM_TIME_SCALE, SimSpeed, SimulationService } from '../core/simulation';

/** Controls and live flight information for the virtual round trip (shown once started). */
@Component({
  selector: 'app-simulation-panel',
  imports: [DecimalPipe, MatButtonModule, MatButtonToggleModule, MatIconModule, MatProgressBarModule, MatCheckboxModule],
  template: `
    @if (sim.stats(); as s) {
      <section class="sim" data-testid="simulation-panel" aria-label="Flight simulation">
        <div class="head">
          <span class="phase" [class]="'phase ph-' + sim.phase().toLowerCase()" data-testid="sim-phase">{{ s.phaseLabel }}</span>
          <span class="pct" data-testid="sim-progress">{{ s.progressPct | number: '1.0-0' }}%</span>
        </div>
        <mat-progress-bar mode="determinate" [value]="s.progressPct" data-testid="sim-progress-bar" />
        @if (sim.message(); as m) {
          <p class="message" role="status" data-testid="sim-message">{{ m }}</p>
        }

        <dl class="facts">
          <dt>Location</dt>
          <dd data-testid="sim-location">
            @if (s.latitude !== null) {
              {{ s.latitude | number: '1.5-5' }}, {{ s.longitude | number: '1.5-5' }}@if (s.district) { · {{ s.district }} }
            } @else { — }
          </dd>
          <dt>Speed</dt><dd data-testid="sim-speed">{{ s.speedKmh | number: '1.0-1' }} km/h (simulated ground speed)</dd>
          <dt>Travelled</dt><dd data-testid="sim-travelled">{{ km(s.travelledM) }}</dd>
          <dt>Remaining</dt>
          <dd data-testid="sim-remaining">{{ km(s.remainingM) }}@if (!s.returnKnown && sim.returnState() === 'pending') { + return (calculating) }</dd>
          <dt>Elapsed</dt><dd data-testid="sim-elapsed">{{ time(s.elapsedS) }}</dd>
          <dt>Time left</dt><dd data-testid="sim-time-left">{{ time(s.remainingS) }}</dd>
        </dl>

        <div class="controls">
          @if (sim.active()) {
            @if (sim.playing()) {
              <button mat-stroked-button data-testid="sim-pause" (click)="sim.pause()"><mat-icon>pause</mat-icon> Pause</button>
            } @else {
              <button mat-stroked-button data-testid="sim-resume" (click)="sim.resume()"><mat-icon>play_arrow</mat-icon> Resume</button>
            }
            <button mat-stroked-button data-testid="sim-stop" (click)="sim.stop()"><mat-icon>stop</mat-icon> Stop</button>
          }
          <button mat-stroked-button data-testid="sim-restart" (click)="sim.restart()"><mat-icon>replay</mat-icon> Restart</button>
        </div>

        <div class="speed-row">
          <span class="label">Playback</span>
          <mat-button-toggle-group class="pill-toggle" data-testid="sim-speed-toggle" aria-label="Playback speed"
                                   hideSingleSelectionIndicator [value]="sim.speed()" (change)="setSpeed($event.value)">
            @for (s of speeds; track s) {
              <mat-button-toggle [value]="s">{{ s }}×</mat-button-toggle>
            }
          </mat-button-toggle-group>
        </div>
        <mat-checkbox [checked]="sim.follow()" (change)="sim.follow.set($event.checked)" data-testid="sim-follow">
          Keep the drone in view
        </mat-checkbox>
        <p class="note">Virtual flight only. 1× plays {{ scale }} simulated seconds per second; playback speed does not change the drone's assumed performance.</p>
      </section>
    }
  `,
  styles: `
    .sim { display: flex; flex-direction: column; gap: 6px; padding: 10px 12px; border-radius: 10px;
      background: var(--mat-sys-surface-container); }
    .head { display: flex; justify-content: space-between; align-items: center; }
    .phase { font-weight: 600; font-size: 13px; padding: 1px 8px; border-radius: 10px; background: #e3f2fd; color: #0d47a1; }
    .ph-returning { background: #ede7f6; color: #4527a0; }
    .ph-completed { background: #e8f5e9; color: #1b5e20; }
    .ph-stopped { background: #fbe9e7; color: #8a1c1c; }
    .ph-at_destination { background: #fff3e0; color: #8a4b00; }
    .pct { font-weight: 600; font-variant-numeric: tabular-nums; }
    .message { margin: 0; font-size: 13px; font-weight: 600; color: #1b5e20; }
    .facts { display: grid; grid-template-columns: auto 1fr; gap: 1px 10px; margin: 2px 0; font-size: 12px;
      dt { color: var(--mat-sys-on-surface-variant); } dd { margin: 0; font-variant-numeric: tabular-nums; } }
    .controls { display: flex; gap: 6px; flex-wrap: wrap;
      button { flex: 1; height: 32px; border-radius: 16px; font-size: 12px; min-width: 0; padding: 0 8px; }
      mat-icon { font-size: 18px; width: 18px; height: 18px; } }
    .speed-row { display: flex; align-items: center; justify-content: space-between; gap: 8px;
      .label { font-size: 12px; color: var(--mat-sys-on-surface-variant); } }
    .note { margin: 0; font-size: 11px; color: var(--mat-sys-on-surface-variant); }
  `,
})
export class SimulationPanelComponent {
  protected readonly sim = inject(SimulationService);
  protected readonly speeds = SIM_SPEEDS;
  protected readonly scale = SIM_TIME_SCALE;

  protected setSpeed(v: SimSpeed): void {
    this.sim.setSpeed(v);
  }

  protected km(m: number): string {
    return m >= 1000 ? `${(m / 1000).toFixed(2)} km` : `${Math.round(m)} m`;
  }

  protected time(s: number): string {
    const t = Math.round(s);
    return `${Math.floor(t / 60)} min ${String(t % 60).padStart(2, '0')} s`;
  }
}
