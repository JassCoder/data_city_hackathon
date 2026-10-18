import { Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { httpResource } from '@angular/common/http';
import { MatIconModule } from '@angular/material/icon';
import { API_BASE_URL, safeValue } from '../core/api';

export interface CityWeatherStation {
  name: string;
  latitude: number;
  longitude: number;
  measuredAt: string | null;
  airTempC: number | null;
  roadTempC: number | null;
  humidityPct: number | null;
  windSpeedMs: number | null;
  windDirectionDeg: number | null;
  precipitation: number | null;
}

export interface CityWeather {
  status: 'LIVE' | 'SAVED' | 'CACHED' | 'UNAVAILABLE';
  message: string;
  fetchedAt: string | null;
  ageS: number | null;
  nextRefreshAt: string | null;
  refreshIntervalS: number;
  summary: {
    stations: number;
    airTempC: number | null;
    minAirTempC: number | null;
    maxAirTempC: number | null;
    humidityPct: number | null;
    maxWindSpeedMs: number | null;
    rainingStations: number;
    latestMeasurement: string | null;
  } | null;
  stations: CityWeatherStation[];
  source: string;
  license: string;
  datasetUrl: string;
}

/** Re-asks the backend this often. The backend serves its saved snapshot and calls Open Data
 * Warsaw only when that snapshot is older than its refresh interval (24 h by default). */
export const CITY_WEATHER_REFRESH_MS = 15 * 60 * 1000;

/**
 * "Warsaw weather now": live readings from the City Cleaning Authority weather stations, from
 * Open Data Warsaw (dane.um.warszawa.pl) through the backend (the API key never reaches the browser).
 */
@Component({
  selector: 'app-city-weather',
  imports: [DecimalPipe, MatIconModule],
  template: `
    <section class="cw" data-testid="city-weather" aria-label="Current weather in Warsaw (Open Data Warsaw)">
      <button type="button" class="head" (click)="open.set(!open())" [attr.aria-expanded]="open()" data-testid="city-weather-toggle">
        <mat-icon>thermostat</mat-icon>
        <span class="title">Warsaw now</span>
        @if (data(); as d) {
          @if (d.summary?.airTempC !== null && d.summary?.airTempC !== undefined) {
            <span class="temp" data-testid="city-weather-temp">{{ d.summary!.airTempC | number: '1.1-1' }} °C</span>
          }
          <span class="chip" [class]="'chip ' + d.status.toLowerCase()" data-testid="city-weather-status">{{ d.status }}</span>
        } @else if (resource.isLoading()) {
          <span class="muted">loading…</span>
        } @else {
          <span class="chip unavailable">UNAVAILABLE</span>
        }
        <mat-icon class="caret">{{ open() ? 'expand_more' : 'expand_less' }}</mat-icon>
      </button>

      @if (data(); as d) {
        @if (d.summary; as s) {
          <p class="line" data-testid="city-weather-summary">
            Humidity {{ s.humidityPct ?? '–' }}% · wind up to {{ s.maxWindSpeedMs ?? '–' }} m/s ·
            {{ s.rainingStations ? s.rainingStations + ' station' + (s.rainingStations === 1 ? '' : 's') + ' reporting rain' : 'no rain' }}
          </p>
          <p class="meta" data-testid="city-weather-meta">
            {{ s.stations }} stations · measured {{ time(s.latestMeasurement) }}
            @if (d.status !== 'LIVE') { · saved {{ ago(d.ageS) }} ago }
            @if (d.status === 'CACHED') { · <b>not live</b> }
          </p>
          <p class="meta" data-testid="city-weather-refresh">Updated every {{ hours(d.refreshIntervalS) }} h from Open Data Warsaw</p>
        } @else {
          <p class="line warn" data-testid="city-weather-message">{{ d.message }}</p>
        }
        @if (open() && d.stations.length) {
          <ul class="stations" data-testid="city-weather-stations">
            @for (st of d.stations; track st.name) {
              <li>
                <span class="name">{{ st.name.replace('Stacja ', '') }}</span>
                <span>{{ st.airTempC ?? '–' }} °C</span>
                <span>{{ st.windSpeedMs ?? '–' }} m/s</span>
              </li>
            }
          </ul>
        }
        <p class="source">Source: <a [href]="d.datasetUrl" target="_blank" rel="noopener">Open Data Warsaw</a>, ZOM weather stations ({{ d.license }})</p>
      } @else if (resource.error()) {
        <p class="line warn" data-testid="city-weather-message">City weather could not be loaded from the backend.</p>
      }
    </section>
  `,
  styles: `
    .cw { width: min(300px, calc(100vw - 32px)); padding: 8px 12px; border-radius: 10px; background: #fff;
      box-shadow: 0 2px 10px rgba(0, 0, 0, 0.25); font-size: 12px; color: #1a1a1a; }
    .head { display: flex; align-items: center; gap: 6px; width: 100%; padding: 0; border: none; background: none;
      font: inherit; cursor: pointer; text-align: left; }
    .head mat-icon { font-size: 20px; width: 20px; height: 20px; color: #1565c0; }
    .title { font-weight: 600; font-size: 13px; }
    .temp { font-weight: 700; font-size: 16px; margin-left: auto; font-variant-numeric: tabular-nums; }
    .caret { color: #757575 !important; }
    .chip { font-size: 10px; font-weight: 700; padding: 1px 6px; border-radius: 8px; }
    .chip.live { background: #e8f5e9; color: #1b5e20; }
    .chip.saved { background: #e3f2fd; color: #0d47a1; }
    .chip.cached { background: #fff3e0; color: #8a4b00; }
    .chip.unavailable { background: #fbe9e7; color: #8a1c1c; margin-left: auto; }
    .muted { margin-left: auto; color: #757575; }
    .line { margin: 6px 0 0; }
    .line.warn { color: #8a4b00; }
    .meta { margin: 2px 0 0; color: #5f6368; }
    .stations { list-style: none; margin: 6px 0 0; padding: 0; max-height: 180px; overflow: auto; border-top: 1px solid #eee; }
    .stations li { display: grid; grid-template-columns: 1fr auto auto; gap: 10px; padding: 2px 0; font-variant-numeric: tabular-nums; }
    .stations .name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .source { margin: 6px 0 0; font-size: 11px; color: #5f6368; }
  `,
})
export class CityWeatherComponent {
  protected readonly resource = httpResource<CityWeather>(() => `${API_BASE_URL}/city-weather`);
  protected readonly data = computed(() => safeValue(this.resource));
  protected readonly open = signal(false);

  constructor() {
    const timer = setInterval(() => this.resource.reload(), CITY_WEATHER_REFRESH_MS);
    inject(DestroyRef).onDestroy(() => clearInterval(timer));
  }

  /** "2026-10-18 10:10:00" (Warsaw local time from the stations) → "18.10 10:10". */
  protected time(value: string | null): string {
    return value ? `${value.slice(8, 10)}.${value.slice(5, 7)} ${value.slice(11, 16)}` : '–';
  }

  protected ago(seconds: number | null): string {
    if (seconds === null) return '–';
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    return h ? `${h} h ${m} min` : `${m} min`;
  }

  protected hours(seconds: number): number {
    return Math.round(seconds / 3600);
  }
}
