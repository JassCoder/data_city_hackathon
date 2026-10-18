import { Component, computed, inject } from '@angular/core';
import { DatePipe } from '@angular/common';
import { httpResource } from '@angular/common/http';
import { MatButtonToggleModule } from '@angular/material/button-toggle';
import { MatIconModule } from '@angular/material/icon';
import { API_BASE_URL, safeValue } from '../core/api';
import { WeatherInfo, WeatherMode } from '../core/models';
import { PlannerStore } from '../core/planner.store';

/**
 * Weather status in the planner. LIVE (Open-Meteo through the backend) is the
 * default. A LIVE failure is shown as such: cached LIVE values are labelled
 * CACHED, a sample fallback is labelled NOT live; nothing is silently relabelled.
 */
@Component({
  selector: 'app-weather-status',
  imports: [DatePipe, MatButtonToggleModule, MatIconModule],
  template: `
    <div class="row">
      <span class="block-title">Weather</span>
      <mat-button-toggle-group
        class="pill-toggle"
        data-testid="weather"
        aria-label="Weather mode"
        hideSingleSelectionIndicator
        [value]="store.weatherMode()"
        (change)="setMode($event.value)"
      >
        <mat-button-toggle value="LIVE">Live</mat-button-toggle>
        <mat-button-toggle value="SAMPLE">Sample</mat-button-toggle>
      </mat-button-toggle-group>
    </div>
    @if (info(); as w) {
      <p class="status" [class]="'status ' + state()" data-testid="weather-info" role="status">
        @switch (w.source) {
          @case ('OPEN_METEO') { <b>LIVE · Open-Meteo</b> }
          @case ('CACHED') { <mat-icon inline>history</mat-icon> <b>CACHED live values</b> }
          @case ('SAMPLE_FALLBACK') { <mat-icon inline>error</mat-icon> <b>Live weather unavailable – sample wind, NOT live data</b> }
          @default { <b>SAMPLE wind (fixed, not live)</b> }
        }
        <br />
        Wind {{ w.windSpeedKmh }} km/h from {{ w.windDirectionDeg }}°@if (w.altitudeM) { at {{ w.altitudeM }} m }
        @if (w.windGustKmh !== null && w.windGustKmh !== undefined) { · gusts {{ w.windGustKmh }} km/h }
        @if (w.observedAt) {
          <br /><span data-testid="weather-time">Forecast for {{ w.observedAt | date: 'yyyy-MM-dd HH:mm' : undefined }}</span>
        }
        @if (w.source !== 'OPEN_METEO') { <br />{{ w.message }} }
      </p>
    } @else if (weather.isLoading()) {
      <p class="status" data-testid="weather-loading">Loading {{ store.weatherMode() === 'LIVE' ? 'live' : 'sample' }} weather…</p>
    } @else if (weather.error()) {
      <p class="status error" role="alert" data-testid="weather-error">Weather could not be loaded from the backend.</p>
    }
  `,
  styles: `
    :host { display: flex; flex-direction: column; gap: 6px; }
    .row { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
    .block-title { font: var(--mat-sys-title-small); }
    .status { margin: 0; font-size: 12px; line-height: 1.4; color: var(--mat-sys-on-surface-variant); }
    .status.live b { color: #1b5e20; }
    .status.cached { color: #8a4b00; }
    .status.error, .status.fallback { color: #b71c1c; }
    mat-icon { vertical-align: -2px; }
  `,
})
export class WeatherStatusComponent {
  protected readonly store = inject(PlannerStore);

  /** Requested from our backend for the selected flight altitude (never directly from the browser). */
  protected readonly weather = httpResource<WeatherInfo>(
    () => `${API_BASE_URL}/weather?mode=${this.store.weatherMode()}&altitude_m=${this.store.altitudeValid() ? this.store.altitude() : 80}`,
  );
  protected readonly info = computed(() => safeValue(this.weather));
  protected readonly state = computed(() => {
    switch (this.info()?.source) {
      case 'OPEN_METEO':
        return 'live';
      case 'CACHED':
        return 'cached';
      case 'SAMPLE_FALLBACK':
        return 'fallback';
      default:
        return 'sample';
    }
  });

  protected setMode(mode: WeatherMode): void {
    this.store.setWeatherMode(mode);
  }
}
