import { ChangeDetectionStrategy, Component, ElementRef, computed, effect, inject, signal, untracked } from '@angular/core';
import { Router } from '@angular/router';
import { Drone, STATUS_TEXT, droneIssues, droneStatus, shortLabel } from '../core/fleet';
import { FleetStore } from '../core/fleet.store';
import { WeatherMode } from '../core/models';
import { UiState } from '../core/ui-state';
import { IconComponent } from '../ui/icon';
import { formatDistance, formatDuration } from '../ui/format';
import { DroneEditorComponent } from './drone-editor';
import { isSmallScreen } from '../map/layers-panel';
import { plannedDrones } from '../sim/fleet-scenario';

const STATUS_BADGE = {
  draft: 'badge-neutral',
  calculating: 'badge-accent',
  ready: 'badge-ok',
  'no-route': 'badge-danger',
  outdated: 'badge-warn',
  error: 'badge-danger',
} as const;

/** Sidebar: the drone list, the inline form of the open drone, and fleet actions. */
@Component({
  selector: 'app-drone-list',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent, DroneEditorComponent],
  template: `
    <p class="visually-hidden" aria-live="polite" data-testid="status-announcer">{{ announcement() }}</p>
    <div class="head">
      <h2>Drones <span class="count num">{{ fleet.drones().length }}</span></h2>
      <button type="button" class="btn btn-s btn-primary" (click)="add()" data-testid="add-drone">
        <app-icon name="plus" />Add drone
      </button>
    </div>

    @if (!fleet.drones().length) {
      <div class="state empty" data-testid="fleet-empty">
        <p>No drones yet. Add a drone, then set its start and destination.</p>
        <button type="button" class="btn btn-s" (click)="loadDemo()" data-testid="load-demo">Load demo fleet</button>
      </div>
    }

    <ul class="drones" aria-label="Drones">
      @for (d of fleet.drones(); track d.id) {
        <li class="drone" [class.selected]="d.id === fleet.selectedId()" [class.hidden-route]="!d.visible"
            [style.--drone]="d.color" [attr.data-testid]="'drone-' + d.id">
          <div class="row">
            <button type="button" class="main" (click)="select(d)" [attr.aria-pressed]="d.id === fleet.selectedId()"
                    [attr.aria-label]="d.name + ', ' + statusText[status(d)]" data-testid="drone-select">
              <span class="line1">
                <span class="dot" aria-hidden="true"></span>
                <span class="name">{{ d.name }}</span>
                @if (d.mode === 'EMERGENCY') {
                  <span class="badge badge-neutral mode">Emergency</span>
                }
              </span>
              <span class="summary">{{ label(d.start) }} → {{ label(d.destination) }}</span>
              <span class="line3">
                <span class="badge" [class]="'badge ' + badge[status(d)]" data-testid="drone-status">
                  @if (status(d) === 'calculating') {
                    <span class="spinner" aria-hidden="true"></span>
                  }
                  {{ statusText[status(d)] }}
                </span>
                @if (stats(d); as s) {
                  <span class="stats num" data-testid="drone-stats">{{ s }}</span>
                }
              </span>
              @for (c of fleet.crossings().get(d.id) ?? []; track c.otherId) {
                <span class="badge badge-warn crossing" data-testid="crossing-warning">
                  <app-icon name="alert" />Crosses {{ c.otherName }} at a similar altitude
                </span>
              }
            </button>
            <div class="tools">
              <button type="button" class="icon-btn icon-btn-s" (click)="fleet.calculate(d.id)"
                      [disabled]="!!issues(d).length || d.route.phase === 'calculating'"
                      [attr.aria-label]="'Calculate route for ' + d.name" [title]="issues(d)[0] ?? 'Calculate route'"
                      data-testid="drone-calculate">
                <app-icon name="route" />
              </button>
              <button type="button" class="icon-btn icon-btn-s" (click)="toggleEdit(d)"
                      [attr.aria-pressed]="d.id === fleet.editingId()" [attr.aria-label]="'Edit ' + d.name" title="Edit"
                      data-testid="drone-edit">
                <app-icon name="edit" />
              </button>
              <button type="button" class="icon-btn icon-btn-s" [attr.popovertarget]="'menu-' + d.id"
                      [attr.aria-label]="'More actions for ' + d.name" title="More" data-testid="drone-more">
                <app-icon name="more" />
              </button>
              <div class="popover menu" popover [id]="'menu-' + d.id" role="menu" [attr.aria-label]="'Actions for ' + d.name">
                <button type="button" role="menuitem" (click)="act(d, 'details')"><app-icon name="info" />Route details</button>
                <button type="button" role="menuitem" (click)="act(d, 'focus')"><app-icon name="target" />Show on map</button>
                <button type="button" role="menuitem" (click)="act(d, 'visible')" data-testid="toggle-visible">
                  <app-icon [name]="d.visible ? 'eyeOff' : 'eye'" />{{ d.visible ? 'Hide route' : 'Show route' }}
                </button>
                <button type="button" role="menuitem" (click)="act(d, 'duplicate')" data-testid="duplicate">
                  <app-icon name="copy" />Duplicate
                </button>
                <button type="button" role="menuitem" class="danger" (click)="act(d, 'delete')" data-testid="delete">
                  <app-icon name="trash" />Delete
                </button>
              </div>
            </div>
          </div>
          @if (d.id === fleet.editingId()) {
            <app-drone-editor [droneId]="d.id" />
          }
        </li>
      }
    </ul>

    @if (fleet.drones().length) {
      <div class="foot">
        <button type="button" class="btn btn-block" (click)="fleet.calculateAll()"
                [disabled]="!fleet.calculableCount() || fleet.anyCalculating()" data-testid="calculate-all">
          @if (fleet.anyCalculating()) {
            <span class="spinner" aria-hidden="true"></span>Calculating…
          } @else {
            Calculate all ({{ fleet.calculableCount() }})
          }
        </button>
        <button type="button" class="btn btn-block" (click)="simulate()" [disabled]="!plannedCount()" data-testid="simulate-fleet"
                [title]="plannedCount() ? 'Fly these drones in the simulation view' : 'Give a drone Point A and B first'">
          <app-icon name="play" />Simulate ({{ plannedCount() }})
        </button>
        <div class="foot-row">
          <div class="segmented wind" role="radiogroup" aria-label="Wind data">
            @for (w of winds; track w.value) {
              <label><input type="radio" name="wind-mode" [value]="w.value" [checked]="fleet.weatherMode() === w.value"
                            (change)="setWind(w.value)" /><span>{{ w.label }}</span></label>
            }
          </div>
          <button type="button" class="btn btn-s btn-ghost" (click)="loadDemo()" data-testid="load-demo">Load demo fleet</button>
        </div>
        @if (demoError(); as e) {
          <p class="field-error" role="alert">{{ e }}</p>
        }
      </div>
    }
  `,
  styles: `
    :host {
      display: flex;
      flex-direction: column;
      gap: var(--sp-3);
    }
    .head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: var(--sp-2);
    }
    .count {
      margin-left: var(--sp-1);
      color: var(--c-muted);
      font-weight: normal;
    }
    .empty {
      display: grid;
      gap: var(--sp-2);
      justify-items: start;
    }
    .drones {
      display: grid;
      margin: 0;
      padding: 0;
      list-style: none;
    }
    .drone {
      position: relative;
      display: grid;
      gap: var(--sp-2);
      padding: var(--sp-2) 0 var(--sp-2) var(--sp-3);
      border-bottom: 1px solid var(--c-line);
    }
    .drone::before {
      content: '';
      position: absolute;
      left: 0;
      top: var(--sp-2);
      bottom: var(--sp-2);
      width: 4px;
      border-radius: 2px;
      background: var(--drone);
    }
    .drone.hidden-route::before {
      background: repeating-linear-gradient(180deg, var(--drone) 0 4px, transparent 4px 7px);
    }
    .drone.selected {
      background: var(--c-accent-soft);
      border-radius: var(--radius-m);
      border-bottom-color: transparent;
    }
    .row {
      display: flex;
      align-items: flex-start;
      gap: var(--sp-1);
    }
    .main {
      display: grid;
      gap: 2px;
      flex: 1;
      min-width: 0;
      padding: 0;
      border: 0;
      background: transparent;
      text-align: left;
    }
    .line1,
    .line3 {
      display: flex;
      align-items: center;
      gap: var(--sp-2);
      min-width: 0;
    }
    .dot {
      flex: none;
      width: 10px;
      height: 10px;
      border-radius: 50%;
      background: var(--drone);
    }
    .name {
      overflow: hidden;
      font-weight: var(--fw-bold);
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .mode {
      padding: 0 6px;
      font-size: var(--fs-11);
      line-height: 16px;
    }
    .summary {
      overflow: hidden;
      font-size: var(--fs-12);
      color: var(--c-muted);
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .line3 {
      flex-wrap: wrap;
      row-gap: 2px;
    }
    .stats {
      font-size: var(--fs-12);
      color: var(--c-muted);
      white-space: nowrap;
    }
    .crossing {
      justify-self: start;
      white-space: normal;
    }
    .tools {
      display: flex;
      flex: none;
      gap: 2px;
      padding-right: var(--sp-1);
    }
    .menu {
      display: none;
      min-width: 180px;
      padding: var(--sp-1);
    }
    .menu:popover-open {
      display: grid;
    }
    @supports (position-area: bottom) {
      .menu {
        inset: auto;
        margin: var(--sp-1) 0 0;
        position-area: bottom span-left;
      }
    }
    .menu button {
      display: flex;
      align-items: center;
      gap: var(--sp-2);
      padding: var(--sp-2);
      border: 0;
      border-radius: var(--radius-s);
      background: transparent;
      font-size: var(--fs-13);
      text-align: left;
    }
    .menu button:hover {
      background: var(--c-surface-2);
    }
    .menu .danger {
      color: var(--c-danger);
    }
    .foot {
      display: grid;
      gap: var(--sp-2);
      padding-top: var(--sp-1);
    }
    .foot-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: var(--sp-2);
    }
    .wind {
      flex: 0 1 160px;
    }
  `,
})
export class DroneListComponent {
  protected readonly fleet = inject(FleetStore);
  private readonly ui = inject(UiState);
  private readonly router = inject(Router);
  protected readonly plannedCount = computed(() => plannedDrones(this.fleet.drones()).length);
  private readonly host = inject(ElementRef<HTMLElement>);

  protected readonly statusText = STATUS_TEXT;
  protected readonly badge = STATUS_BADGE;
  protected readonly winds: { value: WeatherMode; label: string }[] = [
    { value: 'DEMO', label: 'Demo wind' },
    { value: 'LIVE', label: 'Live wind' },
  ];
  protected readonly demoError = signal<string | null>(null);
  /** Screen readers hear when a drone's status changes (e.g. "Drone 2: Route ready"). */
  protected readonly announcement = signal('');
  private lastStatus = new Map<string, string>();

  /** Opens the simulation view with these drones (one mission each, from A to B). */
  protected simulate(): void {
    void this.router.navigate(['/simulate'], { queryParams: { from: 'plan' } });
  }

  constructor() {
    effect(() => {
      const changes: string[] = [];
      const next = new Map<string, string>();
      for (const d of this.fleet.drones()) {
        const s = droneStatus(d);
        next.set(d.id, s);
        const prev = this.lastStatus.get(d.id);
        if (prev && prev !== s && s !== 'draft') changes.push(`${d.name}: ${STATUS_TEXT[s]}`);
      }
      this.lastStatus = next;
      if (changes.length) untracked(() => this.announcement.set(changes.join('. ')));
    });
  }

  protected status = droneStatus;
  protected issues = droneIssues;
  protected label = shortLabel;

  protected stats(d: Drone): string | null {
    const r = d.route;
    if ((r.phase !== 'ready' && r.phase !== 'stale') || r.response.status !== 'OK') return null;
    return `${formatDistance(r.response.distanceM)} · ${formatDuration(r.response.etaS)}`;
  }

  protected add(): void {
    this.fleet.addDrone();
    if (isSmallScreen()) this.ui.sheet.set('full');
  }

  protected select(d: Drone): void {
    this.fleet.select(d.id);
    const r = d.route;
    if (!isSmallScreen() && (r.phase === 'ready' || r.phase === 'stale' || r.phase === 'error')) this.ui.openDetails();
  }

  protected toggleEdit(d: Drone): void {
    this.fleet.edit(this.fleet.editingId() === d.id ? null : d.id);
  }

  protected setWind(mode: WeatherMode): void {
    this.fleet.setWeatherMode(mode);
  }

  protected loadDemo(): void {
    this.demoError.set(this.fleet.loadDemoFleet());
  }

  protected act(d: Drone, action: 'details' | 'focus' | 'visible' | 'duplicate' | 'delete'): void {
    (this.host.nativeElement as HTMLElement).querySelector<HTMLElement>(`#menu-${CSS.escape(d.id)}`)?.hidePopover();
    switch (action) {
      case 'details':
        this.fleet.select(d.id);
        this.ui.openDetails();
        break;
      case 'focus':
        this.fleet.select(d.id);
        this.ui.focusOnMap(d.id);
        if (isSmallScreen()) this.ui.sheet.set('peek');
        break;
      case 'visible':
        this.fleet.toggleVisible(d.id);
        break;
      case 'duplicate':
        this.fleet.duplicate(d.id);
        break;
      case 'delete':
        this.fleet.remove(d.id);
        break;
    }
  }
}
