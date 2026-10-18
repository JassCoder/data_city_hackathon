import { Component, computed, inject } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { CostTerm, RouteResponse } from '../core/models';
import { PlannerApi } from '../core/planner-api';
import { PlannerStore } from '../core/planner.store';
import { AirspaceService, ZoneConflict } from '../core/airspace';

const RELATION_LABEL: Record<ZoneConflict['relation'], string> = {
  START_INSIDE: 'Start inside zone',
  DESTINATION_INSIDE: 'Destination inside zone',
  DIRECT_LINE_BLOCKED: 'Avoided',
  ROUTE_CROSSES_INFO: 'Information',
  NEAR_ROUTE: 'Near route',
};

const STATUS_LABEL: Record<RouteResponse['status'], string> = {
  OK: 'Route found',
  NO_ROUTE: 'No route',
  OUTSIDE_COVERAGE: 'Outside coverage',
  START_BLOCKED: 'Start blocked',
  DESTINATION_BLOCKED: 'Destination blocked',
  BLOCKED_WEATHER: 'Blocked by weather',
  SEARCH_LIMIT: 'Search limit reached',
  COVERAGE_UNAVAILABLE: 'Coverage unavailable',
  INSUFFICIENT_BATTERY: 'Insufficient battery',
  RISK_DATA_UNAVAILABLE: 'Safest unavailable',
};

const OBJECTIVE_LABEL: Record<RouteResponse['routeObjective'], string> = {
  CORRIDORS: 'Safe corridors',
  SHORTEST: 'Shortest',
  FASTEST: 'Fastest (wind-aware)',
  SAFEST: 'Safest (multi-criteria)',
  LOWEST_ENERGY: 'Lowest energy',
};

const TERM_LABEL: Record<CostTerm, string> = {
  population: 'Crowds (estimated)',
  obstacle_proximity: 'Near tall structures',
  noise: 'Noise over homes',
  emergency_landing: 'Far from landing space',
  sensitive_areas: 'Schools, hospitals, stadiums',
  energy: 'Energy (wind, payload)',
  time: 'Flight time',
};

@Component({
  selector: 'app-route-results',
  imports: [MatIconModule, MatProgressSpinnerModule, DecimalPipe],
  template: `
    <h2>Route details</h2>
    @switch (state().phase) {
      @case ('idle') {
        <p class="muted" data-testid="route-idle">No route yet. Select Point A and Point B, then Calculate Route.</p>
      }
      @case ('loading') {
        <p class="loading" data-testid="route-loading"><mat-spinner diameter="18" /> Calculating route…</p>
      }
      @case ('error') {
        <p class="error-box" role="alert" data-testid="route-error">{{ errorMessage() }}</p>
      }
    }
    @if (response(); as r) {
      <div class="result" [class.stale]="stale()" data-testid="route-result">
        @if (stale()) {
          <p class="stale-banner" data-testid="route-stale">
            <mat-icon>update</mat-icon> Inputs changed. This route is outdated; recalculate.
          </p>
        }
        <div class="status" [class]="'status ' + (r.status === 'OK' ? 'ok' : 'bad')" data-testid="route-status">
          {{ statusLabel(r) }}
        </div>
        @if (r.status === 'OK') {
          <dl class="stats">
            <dt>Distance</dt><dd data-testid="route-distance">{{ km(r.distanceM) }}</dd>
            <dt>ETA</dt><dd data-testid="route-eta">{{ eta(r.etaS) }}</dd>
            <dt>Scenario</dt><dd data-testid="route-scenario">{{ r.scenarioDisplayName }}</dd>
            <dt>Optimised for</dt><dd data-testid="route-objective">{{ objectiveLabel[r.routeObjective] }}</dd>
            <dt>Mode</dt><dd [class.emergency]="r.mode === 'EMERGENCY'">{{ r.mode }}</dd>
            @if (r.coverage.startDistrict || r.coverage.destinationDistrict) {
              <dt>Districts</dt><dd data-testid="route-districts">{{ r.coverage.startDistrict }} → {{ r.coverage.destinationDistrict }}</dd>
            }
            <dt>Altitude</dt><dd>{{ r.flightAltitudeMeters }} m AGL</dd>
            <dt>Drone</dt><dd>{{ profileName(r.droneProfileId) }}</dd>
            <dt>Wind</dt><dd>{{ r.weather.windSpeedKmh }} km/h from {{ r.weather.windDirectionDeg }}° ({{ r.weather.source }})</dd>
          </dl>
        } @else {
          <p class="error-box" data-testid="route-message">{{ r.message }}</p>
        }
        @if (r.costBreakdown; as b) {
          <details class="breakdown" data-testid="route-breakdown" [open]="r.routeObjective === 'SAFEST'">
            <summary>Cost breakdown (why this route)</summary>
            <dl class="stats">
              <dt>Energy</dt>
              <dd data-testid="breakdown-energy">{{ b.energyWh | number: '1.0-1' }} Wh of {{ b.batteryUsableWh | number: '1.0-0' }} Wh usable</dd>
              <dt>Crowd exposure</dt>
              <dd data-testid="breakdown-exposure">{{ b.populationExposure | number: '1.0-1' }} people/ha·km (peak {{ b.maxDensityPerHa | number: '1.0-0' }}/ha)</dd>
              <dt>Payload</dt><dd>{{ b.payloadKg }} kg · departure {{ b.localHour }}:00 local</dd>
            </dl>
            <table class="terms">
              <thead><tr><th>Term</th><th>Weight</th><th>Mean</th><th>Cost</th></tr></thead>
              <tbody>
                <tr><td>Distance</td><td>1</td><td>—</td><td>{{ b.lengthM | number: '1.0-0' }}</td></tr>
                @for (t of b.terms; track t.term) {
                  <tr [class.off]="!t.weight">
                    <td>{{ termLabel[t.term] }}</td><td>{{ t.weight }}</td>
                    <td>{{ t.mean | number: '1.2-2' }}</td><td>{{ t.cost | number: '1.0-0' }}</td>
                  </tr>
                }
                <tr class="total"><td>Total</td><td></td><td></td><td>{{ b.totalCost | number: '1.0-0' }}</td></tr>
              </tbody>
            </table>
            <p class="hint">{{ b.note }}</p>
          </details>
        }
        <p class="verification" data-testid="route-verification">{{ r.planningVerificationStatus }}</p>
        @if (r.zoneConflicts.length) {
          <ul class="conflicts" data-testid="route-conflicts">
            @for (c of r.zoneConflicts; track $index) {
              <li [class]="'conflict rel-' + c.relation.toLowerCase()">
                <span class="dot" [class]="'dot dot-' + c.displayClass.toLowerCase()"></span>
                <span>
                  <b>{{ relationLabel[c.relation] }}</b> · {{ c.message }}
                  <button type="button" class="link" (click)="airspace.focusZoneId.set(c.zoneId)">Show zone</button>
                </span>
              </li>
            }
          </ul>
        }
        @if (r.status === 'NO_ROUTE') {
          <p class="hint" data-testid="route-no-route-hint">
            No path exists around the currently blocked geometry with these settings. Choose other points, change the
            altitude, or check the zone list.
          </p>
        }
        @if (r.warnings.length) {
          <ul class="warnings" data-testid="route-warnings">
            @for (w of r.warnings; track $index) {
              <li><mat-icon>warning_amber</mat-icon>{{ w }}</li>
            }
          </ul>
        }
        @if (r.search; as s) {
          <p class="hint" data-testid="route-search">
            Searched {{ s.windowKm2 }} km² at {{ s.resolutionM }} m resolution{{ s.wholeCity ? ' (whole city)' : '' }},
            {{ s.attempts }} attempt{{ s.attempts === 1 ? '' : 's' }}, {{ s.elapsedMs | number: '1.0-0' }} ms{{ s.cached ? ' (cached)' : '' }}.
          </p>
        }
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
  `,
  styleUrl: './route-results.scss',
})
export class RouteResultsComponent {
  private readonly store = inject(PlannerStore);
  private readonly api = inject(PlannerApi);
  protected readonly airspace = inject(AirspaceService);
  protected readonly relationLabel = RELATION_LABEL;
  protected readonly objectiveLabel = OBJECTIVE_LABEL;
  protected readonly termLabel = TERM_LABEL;

  protected readonly state = this.store.route;
  protected readonly stale = computed(() => {
    const s = this.state();
    return s.phase === 'stale' || (s.phase === 'loading' && !!s.previous);
  });
  protected readonly response = computed(() => {
    const s = this.state();
    if (s.phase === 'ready' || s.phase === 'stale') return s.response;
    if (s.phase === 'loading') return s.previous;
    return undefined;
  });
  protected readonly errorMessage = computed(() => {
    const s = this.state();
    return s.phase === 'error' ? s.message : '';
  });

  protected statusLabel(r: RouteResponse): string {
    return STATUS_LABEL[r.status];
  }

  protected km(m: number | null): string {
    return m === null ? '—' : m >= 1000 ? `${(m / 1000).toFixed(2)} km` : `${Math.round(m)} m`;
  }

  protected eta(s: number | null): string {
    if (s === null) return '—';
    const total = Math.round(s);
    return `${Math.floor(total / 60)} min ${String(total % 60).padStart(2, '0')} s`;
  }

  protected profileName(id: string): string {
    return this.api.profileList()?.find((p) => p.id === id)?.name ?? id;
  }
}
