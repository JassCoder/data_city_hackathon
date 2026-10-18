import { ChangeDetectionStrategy, Component, computed, inject, linkedSignal, output, signal } from '@angular/core';

import { IconComponent } from '../ui/icon';
import { canFail, failCommand, windCommand } from './commands';
import { STATE_LABEL, eventZoneIds } from './event-feed';
import { SimSession } from './sim-session';
import { ZoneDraft } from './zone-draft';

const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
export const compass = (deg: number) => COMPASS[Math.round((((deg % 360) + 360) % 360) / 45) % 8];

/** Sidebar section: draw a temporary restricted zone, change the wind, fail the selected drone. */
@Component({
  selector: 'app-inject-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent],
  styleUrl: './inject-panel.scss',
  template: `
    <section class="inj" aria-labelledby="inj-title" data-testid="inject-panel">
      <h3 id="inj-title">Change the simulation</h3>
      @if (sim.mode() === 'REPLAY') {
        <p class="inj-note" data-testid="inject-replay">
          You are replaying the past. Changes apply at the newest time.
          <button type="button" class="btn btn-s" (click)="sim.goLive()">Go live</button>
        </p>
      }
      <fieldset class="inj-group" [disabled]="sim.mode() === 'REPLAY'">
        <legend><app-icon name="polygon" />Restricted zone</legend>
        <div class="inj-row">
          <label class="field">
            <span class="field-label">Altitude cap (m)</span>
            <input class="input num" type="number" min="1" [max]="limits()?.zoneMaxUpperM ?? 500" step="5" [value]="draft.upperM()"
                   (input)="draft.upperM.set(num($event))" data-testid="zone-upper" />
          </label>
          <label class="field">
            <span class="field-label">Duration (min)</span>
            <input class="input num" type="number" min="1" [max]="maxMinutes()" step="1" [value]="draft.durationMin()"
                   (input)="draft.durationMin.set(num($event))" data-testid="zone-duration" />
          </label>
        </div>
        <label class="field">
          <span class="field-label">Name (optional)</span>
          <input class="input" type="text" maxlength="80" placeholder="e.g. Fire near the station" [value]="draft.name()"
                 (input)="draft.name.set(text($event))" data-testid="zone-name" />
        </label>
        @if (draft.active()) {
          <div class="inj-actions">
            <button type="button" class="btn btn-s btn-primary" [disabled]="!draft.canFinish()" (click)="draft.finish()" data-testid="zone-finish">
              @if (draft.sending()) {
                <span class="spinner"></span>
              }
              Send zone ({{ draft.points().length }} corners)
            </button>
            <button type="button" class="btn btn-s" (click)="draft.cancel()">Cancel</button>
          </div>
        } @else {
          <button type="button" class="btn btn-s" (click)="startDrawing()" data-testid="zone-draw">
            <app-icon name="polygon" />Draw on the map
          </button>
        }
        @if (draft.error(); as e) {
          <p class="field-error" role="alert" data-testid="zone-error">{{ e }}</p>
        }
        @if (draft.sent(); as s) {
          <p class="inj-ok" role="status" data-testid="zone-sent">{{ s.text }}</p>
          @if (reactions().length) {
            <p class="small" data-testid="zone-reactions">Reacting: {{ reactions().join(', ') }}.</p>
          }
        }
      </fieldset>

      <fieldset class="inj-group" [disabled]="sim.mode() === 'REPLAY'">
        <legend><app-icon name="wind" />Wind</legend>
        <p class="small muted">Now {{ windNow() }}.</p>
        <div class="inj-row">
          <label class="field">
            <span class="field-label">Speed (km/h)</span>
            <input class="input num" type="number" min="0" [max]="limits()?.windMaxKmh ?? 100" step="1" [value]="windSpeed()"
                   (input)="windSpeed.set(num($event))" data-testid="wind-speed" />
          </label>
          <label class="field">
            <span class="field-label">From (°)</span>
            <span class="inj-dir">
              <input class="input num" type="number" min="0" max="359" step="5" [value]="windDir()" (input)="windDir.set(num($event))"
                     data-testid="wind-dir" aria-describedby="wind-dir-name" />
              <span id="wind-dir-name" class="inj-compass" aria-hidden="true">
                <svg viewBox="0 0 24 24" [style.transform]="'rotate(' + windDir() + 'deg)'"><path d="M12 3v15M7 13l5 5 5-5" /></svg>
                {{ compass(windDir()) }}
              </span>
            </span>
          </label>
        </div>
        <button type="button" class="btn btn-s" (click)="sendWind()" data-testid="wind-send">Change the wind</button>
        @if (windMsg(); as m) {
          <p [class]="m.ok ? 'inj-ok' : 'field-error'" role="status" data-testid="wind-msg">{{ m.text }}</p>
        }
      </fieldset>

      <fieldset class="inj-group" [disabled]="sim.mode() === 'REPLAY'">
        <legend><app-icon name="zap" />Failure (test)</legend>
        @if (sim.selected(); as d) {
          <button type="button" class="btn btn-s btn-danger" [disabled]="!canFailSelected()" (click)="fail()" data-testid="fail-drone">
            Fail {{ d.name }}
          </button>
          @if (!canFailSelected()) {
            <p class="small muted">{{ d.name }} is {{ stateLabel[d.pose.state].toLowerCase() }}: only a flying drone can be failed.</p>
          }
        } @else {
          <p class="small muted">Select a flying drone to fail it.</p>
        }
        @if (failMsg(); as m) {
          <p [class]="m.ok ? 'inj-ok' : 'field-error'" role="status" data-testid="fail-msg">{{ m.text }}</p>
        }
      </fieldset>
    </section>
  `,
})
export class InjectPanelComponent {
  protected readonly sim = inject(SimSession);
  protected readonly draft = inject(ZoneDraft);
  /** Drawing started (the page shows the map on small screens). */
  readonly drawing = output<void>();
  protected readonly stateLabel = STATE_LABEL;
  protected readonly compass = compass;

  protected readonly limits = computed(() => this.sim.info()?.limits);
  protected readonly maxMinutes = computed(() => Math.floor((this.limits()?.zoneMaxDurationS ?? 14400) / 60));
  protected readonly windSpeed = linkedSignal(() => Math.round(this.sim.info()?.initialWind.speedKmh ?? 0));
  protected readonly windDir = linkedSignal(() => Math.round(this.sim.info()?.initialWind.directionDeg ?? 0));
  protected readonly windNow = computed(() => {
    const w = this.sim.wind();
    return w ? `${w.speedKmh.toFixed(0)} km/h from ${w.directionDeg.toFixed(0)}° (${compass(w.directionDeg)})` : '—';
  });
  protected readonly windMsg = signal<{ ok: boolean; text: string } | null>(null);
  protected readonly failMsg = signal<{ ok: boolean; text: string } | null>(null);
  protected readonly canFailSelected = computed(() => this.sim.mode() === 'LIVE' && canFail(this.sim.selected()?.pose.state));

  /** Drones whose events name the last drawn zone (re-routed, holding, continuing out). */
  protected readonly reactions = computed(() => {
    const id = this.draft.sent()?.zoneId;
    const info = this.sim.info();
    if (!id || !info) return [];
    const names = new Set<string>();
    for (const e of this.sim.events()) {
      if (e.droneId && e.tS <= this.sim.playT() && eventZoneIds(e).includes(id) && e.type !== 'SCENARIO_EVENT') {
        names.add(info.drones.find((d) => d.id === e.droneId)?.name ?? e.droneId);
      }
    }
    return [...names];
  });

  protected num(e: Event): number {
    return Number((e.target as HTMLInputElement).value);
  }

  protected text(e: Event): string {
    return (e.target as HTMLInputElement).value;
  }

  protected startDrawing(): void {
    this.draft.start();
    this.drawing.emit();
  }

  protected async sendWind(): Promise<void> {
    const info = this.sim.info();
    if (!info) return;
    const built = windCommand(this.windSpeed(), this.windDir(), info.limits);
    if (!built.ok) {
      this.windMsg.set({ ok: false, text: built.error });
      return;
    }
    try {
      await this.sim.inject(built.command);
      const c = built.command;
      this.windMsg.set({ ok: true, text: `Wind changes to ${c.speedKmh} km/h from ${c.directionDeg}° at the next tick.` });
    } catch (e) {
      this.windMsg.set({ ok: false, text: (e as Error).message });
    }
  }

  protected async fail(): Promise<void> {
    const d = this.sim.selected();
    if (!d) return;
    const built = failCommand(d.id, d.pose.state);
    if (!built.ok) {
      this.failMsg.set({ ok: false, text: built.error });
      return;
    }
    try {
      await this.sim.inject(built.command);
      this.failMsg.set({ ok: true, text: `${d.name} fails at the next tick. Watch the events for what follows.` });
    } catch (e) {
      this.failMsg.set({ ok: false, text: (e as Error).message });
    }
  }
}
