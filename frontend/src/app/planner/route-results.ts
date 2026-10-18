import { Component, computed, inject } from '@angular/core';
import { DatePipe, DecimalPipe } from '@angular/common';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { RouteResponse } from '../core/models';
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
};

const OBJECTIVE_LABEL: Record<RouteResponse['routeObjective'], string> = {
  CORRIDORS: 'Smart Route (safe corridors)',
  SHORTEST: 'Shortest',
  FASTEST: 'Fastest (wind-aware)',
};

const WEATHER_SOURCE_LABEL: Record<RouteResponse['weather']['source'], string> = {
  OPEN_METEO: 'LIVE · Open-Meteo',
  CACHED: 'Cached live values (live unavailable)',
  SAMPLE_FALLBACK: 'Sample wind – live unavailable, NOT live data',
  SAMPLE: 'Sample wind (fixed, not live)',
};

@Component({
  selector: 'app-route-results',
  imports: [MatIconModule, MatProgressSpinnerModule, DatePipe, DecimalPipe],
  template: `
    <h2>Route details</h2>
    @switch (state().phase) {
      @case ('idle') {
        <p class="muted" data-testid="route-idle">No route calculated yet. Select Point A and Point B, then Calculate Route.</p>
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
        <h3>Route overview</h3>
        <dl class="stats">
          <dt>Point A</dt><dd data-testid="route-from">{{ label('start', r) }}</dd>
          <dt>Point B</dt><dd data-testid="route-to">{{ label('destination', r) }}</dd>
          <dt>Status</dt>
          <dd><span class="status" [class]="'status ' + (r.status === 'OK' ? 'ok' : 'bad')" data-testid="route-status">{{ statusLabel(r) }}</span></dd>
          @if (r.status === 'OK') {
            <dt>Distance</dt><dd data-testid="route-distance">{{ km(r.distanceM) }}</dd>
            <dt>Flight time</dt><dd data-testid="route-eta">{{ eta(r.etaS) }}</dd>
          }
          <dt>Altitude</dt><dd data-testid="route-altitude">{{ r.flightAltitudeMeters }} m AGL</dd>
          <dt>Flight mode</dt><dd [class.emergency]="r.mode === 'EMERGENCY'" data-testid="route-mode">{{ r.mode === 'EMERGENCY' ? 'Emergency' : 'Normal' }}</dd>
          <dt>Optimisation</dt><dd data-testid="route-objective">{{ objectiveLabel[r.routeObjective] }}</dd>
          @if (r.coverage.startDistrict || r.coverage.destinationDistrict) {
            <dt>Districts</dt><dd data-testid="route-districts">{{ r.coverage.startDistrict }} → {{ r.coverage.destinationDistrict }}</dd>
          }
          @if (r.calculatedAt) {
            <dt>Calculated</dt><dd data-testid="route-calculated">{{ r.calculatedAt | date: 'yyyy-MM-dd HH:mm' }} (Warsaw time)</dd>
          }
        </dl>
        @if (r.status !== 'OK') {
          <p class="error-box" data-testid="route-message">{{ r.message }}</p>
        }

        <h3>Weather conditions</h3>
        <dl class="stats" data-testid="route-weather">
          <dt>Wind</dt><dd>{{ r.weather.windSpeedKmh }} km/h from {{ r.weather.windDirectionDeg }}°</dd>
          @if (r.weather.windGustKmh !== null && r.weather.windGustKmh !== undefined) {
            <dt>Gusts</dt><dd>{{ r.weather.windGustKmh }} km/h</dd>
          }
          <dt>Source</dt><dd [class.warn]="r.weather.source !== 'OPEN_METEO' && r.weather.mode === 'LIVE'" data-testid="route-weather-source">
            {{ weatherSourceLabel[r.weather.source] }}</dd>
          @if (r.weather.observedAt) {
            <dt>Forecast time</dt><dd>{{ r.weather.observedAt | date: 'yyyy-MM-dd HH:mm' }}</dd>
          }
        </dl>

        <h3>Drone</h3>
        <dl class="stats" data-testid="route-drone">
          <dt>Profile</dt><dd>{{ profile(r.droneProfileId)?.name ?? r.droneProfileId }}</dd>
          @if (profile(r.droneProfileId); as p) {
            <dt>Speed</dt><dd>{{ p.cruiseSpeedMps }} m/s (assumed)</dd>
            <dt>Example range</dt><dd>{{ p.maxRangeKm }} km</dd>
          }
        </dl>

        <h3>Safety and warnings</h3>
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
            No path exists around the blocked areas with these settings. Choose other points or change the altitude.
          </p>
        }
        @if (r.warnings.length) {
          <ul class="warnings" data-testid="route-warnings">
            @for (w of r.warnings; track $index) {
              <li><mat-icon>warning_amber</mat-icon>{{ w }}</li>
            }
          </ul>
        }
        <p class="verification" data-testid="route-verification">{{ r.planningVerificationStatus }}</p>
        @if (r.search; as s) {
          <p class="hint" data-testid="route-search">
            Searched {{ s.windowKm2 }} km² at {{ s.resolutionM }} m resolution{{ s.wholeCity ? ' (whole city)' : '' }},
            {{ s.elapsedMs | number: '1.0-0' }} ms{{ s.cached ? ' (cached)' : '' }}.
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
  protected readonly weatherSourceLabel = WEATHER_SOURCE_LABEL;

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

  protected profile(id: string) {
    return this.api.profileList()?.find((p) => p.id === id);
  }

  /** The planner label for a point while it still matches the route request, else coordinates. */
  protected label(role: 'start' | 'destination', r: RouteResponse): string {
    const loc = role === 'start' ? this.store.start() : this.store.destination();
    const c = role === 'start' ? r.start : r.destination;
    if (loc && loc.coordinate.latitude === c.latitude && loc.coordinate.longitude === c.longitude) return loc.label;
    return `${c.latitude.toFixed(5)}, ${c.longitude.toFixed(5)}`;
  }
}
