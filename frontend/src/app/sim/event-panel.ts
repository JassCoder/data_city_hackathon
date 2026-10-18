import { ChangeDetectionStrategy, Component, computed, inject, output, signal } from '@angular/core';

import { SETTINGS } from '../core/settings';
import { IconComponent, IconName } from '../ui/icon';
import { FeedContext, SEVERITIES, SEVERITY_LABEL, Severity, describeEvent, eventSeverity, filterEvents } from './event-feed';
import { SimEvent } from './sim-models';
import { SimSession } from './sim-session';
import { formatElapsed } from './timeline';

const SEVERITY_ICON: Record<Severity, IconName> = { critical: 'alert', warning: 'alert', info: 'info' };

/** Collapsible event feed: newest first up to the playhead, filter by drone and severity, click to jump. */
@Component({
  selector: 'app-event-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent],
  styleUrl: './event-panel.scss',
  template: `
    <section class="ef" data-testid="event-feed">
      <h3 class="ef-heading">
        <button type="button" class="ef-toggle" [attr.aria-expanded]="open()" aria-controls="ef-body" (click)="open.set(!open())"
                data-testid="feed-toggle">
          <app-icon [name]="open() ? 'chevronDown' : 'chevronRight'" />
          <span>Events</span>
          <span class="count num">{{ total() }}</span>
          @if (criticalCount()) {
            <span class="badge badge-danger num">{{ criticalCount() }} critical</span>
          }
        </button>
      </h3>
      @if (open()) {
        <div id="ef-body">
          <div class="ef-filters">
            <label class="ef-drone">
              <span class="visually-hidden">Drone</span>
              <select class="input" (change)="setDrone($event)" data-testid="feed-drone">
                <option value="" [selected]="!droneId()">All drones</option>
                @for (d of sim.info()?.drones ?? []; track d.id) {
                  <option [value]="d.id" [selected]="droneId() === d.id">{{ d.name }}</option>
                }
              </select>
            </label>
            <div class="ef-sev" role="group" aria-label="Severity">
              @for (s of severities; track s) {
                <button type="button" class="btn btn-s" [attr.aria-pressed]="shown().has(s)" (click)="toggle(s)"
                        [attr.data-testid]="'feed-' + s">
                  <span class="sev-mark" [attr.data-sev]="s" aria-hidden="true"></span>{{ severityLabel[s] }}
                </button>
              }
            </div>
          </div>
          <ol class="ef-list" aria-label="Events, newest first">
            @for (r of rows(); track r.e.seq) {
              <li>
                <button type="button" class="ef-item" [attr.data-sev]="r.severity" (click)="jump(r.e)"
                        [attr.aria-label]="r.time + ', ' + r.who + ': ' + r.text.title + '. Jump to this moment.'" data-testid="feed-item">
                  <span class="ef-time num">{{ r.time }}</span>
                  <span class="ef-icon" [attr.data-sev]="r.severity" aria-hidden="true"><app-icon [name]="icon[r.severity]" /></span>
                  <span class="ef-text">
                    <span class="ef-title">
                      @if (r.color) {
                        <span class="dot" [style.background]="r.color" aria-hidden="true"></span>
                      }
                      <b>{{ r.who }}</b> {{ r.text.title }}
                    </span>
                    @if (r.text.detail) {
                      <span class="ef-detail">{{ r.text.detail }}</span>
                    }
                  </span>
                </button>
              </li>
            } @empty {
              <li class="state">{{ total() ? 'No events match these filters.' : 'No events yet. Press Play.' }}</li>
            }
          </ol>
        </div>
      }
      <p class="visually-hidden" aria-live="polite" data-testid="feed-announcer">{{ announcement() }}</p>
    </section>
  `,
})
export class EventPanelComponent {
  protected readonly sim = inject(SimSession);
  /** An event was clicked (the page shows the map on small screens). */
  readonly jumped = output<SimEvent>();
  protected readonly severities = SEVERITIES;
  protected readonly severityLabel = SEVERITY_LABEL;
  protected readonly icon = SEVERITY_ICON;

  protected readonly open = signal(true);
  protected readonly droneId = signal<string | null>(null);
  protected readonly shown = signal<ReadonlySet<Severity>>(new Set(SEVERITIES));

  private readonly ctx = computed<FeedContext>(() => {
    const info = this.sim.info();
    const zones = new Map(this.sim.zones().map((z) => [z.id, z.name]));
    const drones = new Map((info?.drones ?? []).map((d) => [d.id, d.name]));
    return { droneName: (id) => drones.get(id) ?? id, zoneName: (id) => zones.get(id) ?? id };
  });
  private readonly upToNow = computed(() => {
    const t = this.sim.playT();
    return this.sim.events().filter((e) => e.tS <= t);
  });
  protected readonly total = computed(() => this.upToNow().length);
  protected readonly criticalCount = computed(() => this.upToNow().filter((e) => eventSeverity(e) === 'critical').length);
  protected readonly rows = computed(() => {
    const ctx = this.ctx();
    const colors = new Map((this.sim.info()?.drones ?? []).map((d) => [d.id, d.color]));
    const filter = { droneId: this.droneId(), severities: this.shown() };
    return filterEvents(this.sim.events(), filter, this.sim.playT(), SETTINGS.sim.feedLimit).map((e) => ({
      e,
      severity: eventSeverity(e),
      time: formatElapsed(e.tS),
      who: e.droneId ? ctx.droneName(e.droneId) : 'Simulation',
      color: e.droneId ? colors.get(e.droneId) : undefined,
      text: describeEvent(e, ctx),
    }));
  });
  /** The newest critical event, for screen readers. */
  protected readonly announcement = computed(() => {
    const events = this.upToNow();
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i];
      if (eventSeverity(e) !== 'critical') continue;
      const ctx = this.ctx();
      return `${e.droneId ? ctx.droneName(e.droneId) : 'Simulation'}: ${describeEvent(e, ctx).title}`;
    }
    return '';
  });

  protected setDrone(e: Event): void {
    this.droneId.set((e.target as HTMLSelectElement).value || null);
  }

  protected toggle(s: Severity): void {
    const next = new Set(this.shown());
    if (next.has(s)) next.delete(s);
    else next.add(s);
    this.shown.set(next);
  }

  protected jump(e: SimEvent): void {
    this.sim.pause();
    this.sim.jumpTo(e);
    this.jumped.emit(e);
  }
}
