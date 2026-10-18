import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';

import { SETTINGS } from '../core/settings';
import { IconComponent } from '../ui/icon';
import { eventSeverity } from './event-feed';
import { SimSession } from './sim-session';
import { formatElapsed, formatSimClock, timeToFraction } from './timeline';

const MAX_MARKS = 300;

/** Bottom bar under the map: play/pause, step, reset, speed, clock, LIVE/REPLAY and the timeline. */
@Component({
  selector: 'app-playback-bar',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent],
  styleUrl: './playback-bar.scss',
  template: `
    <section class="pb" aria-label="Playback" data-testid="playback-bar">
      <div class="pb-row">
        <div class="pb-buttons">
          <button type="button" class="icon-btn pb-play" (click)="sim.togglePlay()" [disabled]="!canPlay()"
                  [attr.aria-label]="sim.playing() ? 'Pause' : 'Play'" aria-keyshortcuts="Space" data-testid="sim-play"
                  [attr.title]="(sim.playing() ? 'Pause' : 'Play') + ' (Space)'">
            <app-icon [name]="sim.playing() ? 'pause' : 'play'" />
          </button>
          <button type="button" class="icon-btn" (click)="sim.stepOnce()" aria-label="Step one tick" aria-keyshortcuts="."
                  title="Step one tick (.)" data-testid="sim-step">
            <app-icon name="stepForward" />
          </button>
          <button type="button" class="icon-btn" popovertarget="sim-reset-confirm" aria-label="Reset to the start"
                  title="Reset to the start" data-testid="sim-reset">
            <app-icon name="refresh" />
          </button>
          <div id="sim-reset-confirm" popover class="popover pb-confirm" data-testid="sim-reset-confirm">
            <p>Go back to T+0:00? Zones, wind changes and failures you added are dropped.</p>
            <div class="pb-confirm-actions">
              <button type="button" class="btn btn-s" popovertarget="sim-reset-confirm" popovertargetaction="hide">Cancel</button>
              <button type="button" class="btn btn-s btn-primary" popovertarget="sim-reset-confirm" popovertargetaction="hide"
                      (click)="sim.reset()" data-testid="sim-reset-ok">Reset</button>
            </div>
          </div>
        </div>

        <fieldset class="segmented pb-speed" data-testid="sim-speed">
          <legend class="visually-hidden">Speed</legend>
          @for (s of speeds; track s) {
            <label>
              <input type="radio" name="sim-speed" [value]="s" [checked]="sim.speed() === s" (change)="sim.setSpeed(s)"
                     [attr.aria-label]="s + ' times real time'" />
              <span class="num">{{ s }}×</span>
            </label>
          }
        </fieldset>

        <div class="pb-clock" data-testid="sim-clock">
          <span class="pb-time num" [attr.aria-label]="'Simulation time ' + clock()">{{ clock() }}</span>
          <span class="pb-elapsed num muted">{{ elapsed() }}</span>
        </div>

        <div class="pb-status">
          @if (sim.mode() === 'LIVE') {
            <span class="pb-mode pb-live" data-testid="sim-mode" role="status" aria-live="polite">
              <span class="pb-dot" [class.pulse]="sim.playing()" aria-hidden="true"></span>LIVE
            </span>
          } @else {
            <span class="pb-mode pb-replay" data-testid="sim-mode" role="status" aria-live="polite">
              <app-icon name="refresh" />REPLAY
            </span>
            <button type="button" class="btn btn-s" (click)="sim.goLive()" aria-keyshortcuts="L" data-testid="sim-go-live">
              Go live
            </button>
          }
          @if (sim.buffering()) {
            <span class="pb-note muted" role="status"><span class="spinner"></span> Loading</span>
          } @else if (sim.finished() && sim.mode() === 'LIVE') {
            <span class="badge badge-neutral" data-testid="sim-finished">All missions done</span>
          }
        </div>

        <p class="pb-keys" aria-hidden="true">
          <kbd>Space</kbd> play/pause <kbd>.</kbd> step <kbd>L</kbd> live
        </p>
      </div>

      <div class="pb-timeline">
        <input type="range" class="pb-scrub" [min]="range().fromS" [max]="range().toS" [step]="tickS()" [value]="sim.playT()"
               [disabled]="range().toS <= range().fromS" (input)="scrub($event)" aria-label="Timeline"
               [attr.aria-valuetext]="elapsed() + ', ' + clock()" data-testid="sim-scrubber"
               [style.--played.%]="playedPct()" />
        <div class="pb-marks" aria-hidden="true">
          @for (m of marks(); track m.seq) {
            <span class="pb-mark" [class]="'pb-mark pb-mark-' + m.severity" [style.left.%]="m.pct"></span>
          }
        </div>
      </div>
    </section>
  `,
})
export class PlaybackBarComponent {
  protected readonly sim = inject(SimSession);
  protected readonly speeds = SETTINGS.sim.speeds;

  protected readonly range = this.sim.timeline;
  protected readonly tickS = computed(() => this.sim.info()?.tickS ?? 1);
  protected readonly clock = computed(() => {
    const info = this.sim.info();
    return info ? formatSimClock(info.startTime, this.sim.playT()) : '--:--:--';
  });
  protected readonly elapsed = computed(() => formatElapsed(this.sim.playT()));
  protected readonly playedPct = computed(() => timeToFraction(this.sim.playT(), this.range()) * 100);
  protected readonly canPlay = computed(
    () => this.sim.phase() === 'ready' && !(this.sim.finished() && this.sim.mode() === 'LIVE' && !this.sim.playing() && this.sim.playT() >= this.sim.headT()),
  );
  /** Critical and warning events as ticks above the timeline. */
  protected readonly marks = computed(() => {
    const range = this.range();
    const out: { seq: number; pct: number; severity: string }[] = [];
    for (const e of this.sim.events()) {
      if (e.tS < range.fromS) continue;
      const severity = eventSeverity(e);
      if (severity === 'info') continue;
      out.push({ seq: e.seq, pct: timeToFraction(e.tS, range) * 100, severity });
    }
    return out.slice(-MAX_MARKS);
  });

  protected scrub(e: Event): void {
    this.sim.seek(Number((e.target as HTMLInputElement).value));
  }
}
