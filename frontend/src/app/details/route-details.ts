import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { AirspaceService, ZoneConflict } from '../core/airspace';
import { droneIssues, shownResponse } from '../core/fleet';
import { FleetStore } from '../core/fleet.store';
import { RouteStatus } from '../core/models';
import { MODE_LABEL, OBJECTIVE_LABEL, TERM_LABEL } from '../core/routing-options';
import { IconComponent } from '../ui/icon';
import { formatDistance, formatDuration, formatNumber } from '../ui/format';

export const STATUS_HEADLINE: Record<RouteStatus, string> = {
  OK: 'Route ready',
  NO_ROUTE: 'No feasible route',
  OUTSIDE_COVERAGE: 'A point is outside Warsaw',
  START_BLOCKED: 'Point A is inside a blocked zone',
  DESTINATION_BLOCKED: 'Point B is inside a blocked zone',
  BLOCKED_WEATHER: 'Wind is too strong for this drone',
  SEARCH_LIMIT: 'Route search limit reached',
  COVERAGE_UNAVAILABLE: 'Warsaw boundary unavailable',
  INSUFFICIENT_BATTERY: 'Not enough battery',
  RISK_DATA_UNAVAILABLE: 'Safest is unavailable',
};

/** What to do next, for each outcome that is not a route. */
export const STATUS_NEXT_STEP: Partial<Record<RouteStatus, string>> = {
  NO_ROUTE: 'Try other points or a higher altitude, or check the highlighted zones on the map.',
  OUTSIDE_COVERAGE: 'Choose a point inside the Warsaw boundary.',
  START_BLOCKED: 'Move Point A out of the zone: drag its marker or pick it again.',
  DESTINATION_BLOCKED: 'Move Point B out of the zone: drag its marker or pick it again.',
  BLOCKED_WEATHER: 'Use a drone with a higher wind limit, or try again with live wind later.',
  SEARCH_LIMIT: 'Try closer points or calculate again.',
  COVERAGE_UNAVAILABLE: 'The server is missing the Warsaw boundary, so routing is turned off.',
  INSUFFICIENT_BATTERY: 'Choose closer points: the route needs more energy than the battery allows with its reserve.',
  RISK_DATA_UNAVAILABLE: 'Choose another route optimisation: the server has not loaded the risk layers Safest needs.',
};



const RELATION_TEXT: Record<ZoneConflict['relation'], string> = {
  START_INSIDE: 'Point A inside',
  DESTINATION_INSIDE: 'Point B inside',
  DIRECT_LINE_BLOCKED: 'Avoided',
  ROUTE_CROSSES_INFO: 'Passes through',
  NEAR_ROUTE: 'Passes near',
};

const RELATION_RANK: Record<ZoneConflict['relation'], number> = {
  START_INSIDE: 0,
  DESTINATION_INSIDE: 0,
  DIRECT_LINE_BLOCKED: 1,
  ROUTE_CROSSES_INFO: 2,
  NEAR_ROUTE: 3,
};

/** Drawer "Route" tab for the selected drone. */
@Component({
  selector: 'app-route-details',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent],
  template: `
    @if (drone(); as d) {
      @switch (d.route.phase) {
        @case ('draft') {
          <div class="state" data-testid="details-draft">
            <p>Not calculated yet.</p>
            @for (i of issues(); track i) {
              <p class="small">{{ i }}</p>
            }
            <button type="button" class="btn btn-s btn-primary" [disabled]="issues().length > 0" (click)="fleet.calculate(d.id)">
              Calculate route
            </button>
          </div>
        }
        @case ('calculating') {
          <p class="state" role="status" data-testid="details-calculating"><span class="spinner" aria-hidden="true"></span> Calculating route…</p>
        }
        @case ('error') {
          <div class="state state-error" role="alert" data-testid="details-error">
            <p><b>Route calculation failed.</b> {{ $any(d.route).message }}</p>
            <button type="button" class="btn btn-s" (click)="fleet.calculate(d.id)">Try again</button>
          </div>
        }
      }
      @if (response(); as r) {
        @if (d.route.phase === 'stale') {
          <div class="banner warn" role="status" data-testid="details-outdated">
            <app-icon name="alert" />
            <span>Settings changed after this route was calculated.</span>
            <button type="button" class="btn btn-s" [disabled]="issues().length > 0" (click)="fleet.calculate(d.id)">Recalculate</button>
          </div>
        }
        <div class="result" [class.dim]="d.route.phase !== 'ready'">
          <p class="headline" [class.ok]="r.status === 'OK'" [class.bad]="r.status !== 'OK'" data-testid="details-headline">
            <app-icon [name]="r.status === 'OK' ? 'check' : 'alert'" />{{ headline[r.status] }}
          </p>
          @if (r.status === 'OK') {
            <dl class="stats" data-testid="details-stats">
              <dt>Distance</dt><dd class="num" data-testid="details-distance">{{ km(r.distanceM) }}</dd>
              <dt>Estimated time</dt><dd class="num">{{ time(r.etaS) }}</dd>
              @if (r.costBreakdown; as b) {
                <dt>Energy</dt><dd class="num" data-testid="details-energy">{{ num(b.energyWh) }} Wh of {{ num(b.batteryUsableWh, 0) }} Wh usable</dd>
              }
              <dt>Altitude</dt><dd class="num">{{ r.flightAltitudeMeters }} m above ground</dd>
              <dt>Flight mode</dt><dd>{{ modeLabel[r.mode] }}</dd>
              <dt>Optimised for</dt><dd>{{ objectiveLabel[r.routeObjective] }}</dd>
              <dt>Wind</dt><dd class="num">{{ r.weather.windSpeedKmh }} km/h from {{ r.weather.windDirectionDeg }}° ({{ r.weather.source === 'OPEN_METEO' ? 'live' : 'demo' }})</dd>
            </dl>
          } @else {
            <p class="message" data-testid="details-message">{{ r.message }}</p>
            @if (nextStep(); as n) {
              <p class="next" data-testid="details-next">{{ n }}</p>
            }
          }

          @if (conflicts().length) {
            <h3>Airspace on this route</h3>
            <ul class="zones" data-testid="details-zones">
              @for (c of conflicts(); track $index) {
                <li>
                  <span class="rel" [class]="'rel rel-' + c.relation.toLowerCase()">{{ relationText[c.relation] }}</span>
                  <span class="zname">{{ c.name }} <span class="muted">({{ c.draCategory }})</span></span>
                  <button type="button" class="btn btn-s btn-ghost" (click)="airspace.focusZoneId.set(c.zoneId)">Show</button>
                </li>
              }
            </ul>
          }

          @for (c of crossings(); track c.otherId) {
            <p class="banner warn" data-testid="details-crossing">
              <app-icon name="alert" />Crosses {{ c.otherName }} at a similar altitude. Not collision avoidance: plan different altitudes or times.
            </p>
          }

          @if (r.costBreakdown; as b) {
            <details class="breakdown" [open]="r.routeObjective === 'SAFEST' || r.routeObjective === 'LOWEST_ENERGY'"
                     data-testid="details-breakdown">
              <summary>Cost breakdown</summary>
              <table class="terms">
                <thead><tr><th scope="col">Term</th><th scope="col">Weight</th><th scope="col">Mean</th><th scope="col">Cost</th></tr></thead>
                <tbody>
                  <tr><td>Distance</td><td>1</td><td>—</td><td>{{ num(b.lengthM, 0) }}</td></tr>
                  @for (t of b.terms; track t.term) {
                    <tr [class.off]="!t.weight"><td>{{ termLabel[t.term] }}</td><td>{{ t.weight }}</td>
                      <td>{{ t.mean.toFixed(2) }}</td><td>{{ num(t.cost, 0) }}</td></tr>
                  }
                  <tr class="total"><td>Total</td><td></td><td></td><td>{{ num(b.totalCost, 0) }}</td></tr>
                </tbody>
              </table>
              <p class="small muted">
                Crowd exposure {{ num(b.populationExposure) }} people/ha·km (peak {{ num(b.maxDensityPerHa, 0) }}/ha),
                departure {{ b.localHour }}:00 local. {{ b.note }}
              </p>
            </details>
          }

          @if (r.warnings.length) {
            <ul class="warnings" data-testid="details-warnings">
              @for (w of r.warnings; track $index) {
                <li><app-icon name="info" /><span>{{ w }}</span></li>
              }
            </ul>
          }

          <div class="safety" data-testid="details-safety">
            <p><span class="badge badge-demo">Demo data</span> {{ r.planningVerificationStatus }}</p>
            <p>This route is not a flight authorization. Real limits depend on the operation category and the airspace; check PANSA DroneMap and DroneTower.</p>
          </div>
          <details class="sources">
            <summary>Data sources</summary>
            <ul>
              @for (s of r.dataSources; track $index) {
                <li>{{ s }}</li>
              }
            </ul>
          </details>
        </div>
      }
    } @else {
      <p class="state" data-testid="details-empty">Select a drone in the list or click its route to see details.</p>
    }
  `,
  styles: `
    :host {
      display: grid;
      gap: var(--sp-3);
    }
    .result {
      display: grid;
      gap: var(--sp-3);
    }
    .result.dim .stats,
    .result.dim .headline {
      opacity: 0.6;
    }
    .headline {
      display: flex;
      align-items: center;
      gap: var(--sp-2);
      font-size: var(--fs-14);
      font-weight: var(--fw-bold);
    }
    .headline.ok {
      color: var(--c-ok);
    }
    .headline.bad {
      color: var(--c-danger);
    }
    .next {
      font-size: var(--fs-13);
      font-weight: var(--fw-medium);
    }
    .stats {
      display: grid;
      grid-template-columns: auto 1fr;
      gap: var(--sp-1) var(--sp-3);
      margin: 0;
      font-size: var(--fs-13);
    }
    dt {
      color: var(--c-muted);
    }
    dd {
      margin: 0;
      min-width: 0;
    }
    h3 {
      font-size: var(--fs-12);
    }
    .zones,
    .warnings {
      display: grid;
      gap: var(--sp-1);
      margin: 0;
      padding: 0;
      list-style: none;
      font-size: var(--fs-12);
    }
    .zones li {
      display: flex;
      align-items: center;
      gap: var(--sp-2);
    }
    .zname {
      flex: 1;
      min-width: 0;
    }
    .rel {
      flex: none;
      min-width: 84px;
      padding: 1px 6px;
      border-radius: var(--radius-s);
      background: var(--c-surface-2);
      font-weight: var(--fw-medium);
    }
    .rel-direct_line_blocked,
    .rel-start_inside,
    .rel-destination_inside {
      background: var(--c-danger-soft);
      color: var(--c-danger);
    }
    .warnings li {
      display: flex;
      gap: var(--sp-2);
      color: var(--c-muted);
    }
    .banner {
      display: flex;
      align-items: center;
      gap: var(--sp-2);
      padding: var(--sp-2);
      border-radius: var(--radius-m);
      font-size: var(--fs-12);
    }
    .banner span {
      flex: 1;
    }
    .banner.warn {
      background: var(--c-warn-soft);
      color: var(--c-warn);
    }
    details summary {
      cursor: pointer;
      font-size: var(--fs-12);
      font-weight: var(--fw-medium);
      color: var(--c-accent);
    }
    .terms {
      width: 100%;
      margin: var(--sp-2) 0;
      border-collapse: collapse;
      font-size: var(--fs-12);
      font-variant-numeric: tabular-nums;
    }
    .terms th,
    .terms td {
      padding: 2px 4px;
      text-align: right;
    }
    .terms th:first-child,
    .terms td:first-child {
      text-align: left;
    }
    .terms thead th {
      border-bottom: 1px solid var(--c-line);
      font-weight: var(--fw-medium);
      color: var(--c-muted);
    }
    .terms tr.off td {
      color: var(--c-muted);
    }
    .terms tr.total td {
      border-top: 1px solid var(--c-line);
      font-weight: var(--fw-bold);
    }
    .safety {
      display: grid;
      gap: var(--sp-1);
      padding: var(--sp-2) var(--sp-3);
      border-radius: var(--radius-m);
      background: var(--c-surface-2);
      font-size: var(--fs-12);
      color: var(--c-muted);
    }
    .sources ul {
      margin: var(--sp-1) 0 0;
      padding-left: var(--sp-4);
      font-size: var(--fs-11);
      color: var(--c-muted);
    }
  `,
})
export class RouteDetailsComponent {
  protected readonly fleet = inject(FleetStore);
  protected readonly airspace = inject(AirspaceService);

  protected readonly headline = STATUS_HEADLINE;
  protected readonly termLabel = TERM_LABEL;
  protected readonly relationText = RELATION_TEXT;
  protected readonly objectiveLabel = OBJECTIVE_LABEL;
  protected readonly modeLabel = MODE_LABEL;

  protected readonly drone = this.fleet.selected;
  protected readonly response = computed(() => {
    const d = this.drone();
    return d ? shownResponse(d) : undefined;
  });
  protected readonly issues = computed(() => {
    const d = this.drone();
    return d ? droneIssues(d) : [];
  });
  protected readonly nextStep = computed(() => {
    const r = this.response();
    return r ? (STATUS_NEXT_STEP[r.status] ?? null) : null;
  });
  /** One line per zone, with its strongest relation to this route. */
  protected readonly conflicts = computed(() => {
    const byZone = new Map<string, ZoneConflict>();
    for (const c of this.response()?.zoneConflicts ?? []) {
      const prev = byZone.get(c.zoneId);
      if (!prev || RELATION_RANK[c.relation] < RELATION_RANK[prev.relation]) byZone.set(c.zoneId, c);
    }
    return [...byZone.values()].sort((a, b) => RELATION_RANK[a.relation] - RELATION_RANK[b.relation]);
  });
  protected readonly crossings = computed(() => {
    const d = this.drone();
    return d ? (this.fleet.crossings().get(d.id) ?? []) : [];
  });

  protected km = formatDistance;
  protected time = formatDuration;
  protected num = formatNumber;
}
