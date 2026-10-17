import { Component, computed, inject, signal } from '@angular/core';
import { httpResource } from '@angular/common/http';
import { MatButtonModule } from '@angular/material/button';
import { MatButtonToggleModule } from '@angular/material/button-toggle';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatSelectModule } from '@angular/material/select';
import { MatSliderModule } from '@angular/material/slider';
import { API_BASE_URL, safeValue } from '../core/api';
import { ALTITUDE, FlightMode, RouteObjective, ScenarioId, WeatherInfo, WeatherMode } from '../core/models';
import { PlannerApi } from '../core/planner-api';
import { DEMO_FIXTURES, DemoFixture, PlannerStore } from '../core/planner.store';
import { LocationInputComponent } from './location-input';

@Component({
  selector: 'app-planner-panel',
  imports: [
    LocationInputComponent,
    MatButtonModule,
    MatButtonToggleModule,
    MatFormFieldModule,
    MatIconModule,
    MatInputModule,
    MatProgressSpinnerModule,
    MatSelectModule,
    MatSliderModule,
  ],
  templateUrl: './planner-panel.html',
  styleUrl: './planner-panel.scss',
})
export class PlannerPanelComponent {
  protected readonly store = inject(PlannerStore);
  protected readonly api = inject(PlannerApi);
  protected readonly ALTITUDE = ALTITUDE;

  protected readonly weather = httpResource<WeatherInfo>(
    () => `${API_BASE_URL}/weather?mode=${this.store.weatherMode()}&altitude_m=${this.store.altitudeValid() ? this.store.altitude() : 80}`,
  );
  protected readonly weatherInfo = computed(() => safeValue(this.weather));
  protected readonly demoError = signal<string | null>(null);
  protected readonly fixtures = DEMO_FIXTURES;
  protected readonly showFixtures = signal(false);

  protected readonly selectedProfile = computed(() =>
    this.api.profileList()?.find((p) => p.id === this.store.droneProfileId()),
  );

  /** Clamped value for the slider thumb; the numeric input shows the raw value. */
  protected readonly sliderValue = computed(() => {
    const v = this.store.altitude();
    return Number.isFinite(v) ? Math.min(ALTITUDE.max, Math.max(ALTITUDE.min, v)) : ALTITUDE.default;
  });

  /** Why Calculate Route is disabled, in plain words. */
  protected readonly missing = computed(() => {
    const s = this.store;
    const out: string[] = [];
    if (!s.start()) out.push('select Point A');
    if (!s.destination()) out.push('select Point B');
    const a = s.start()?.coordinate;
    const b = s.destination()?.coordinate;
    if (a && b && a.latitude === b.latitude && a.longitude === b.longitude) out.push('choose two different points');
    if (!s.altitudeValid()) out.push('enter a valid altitude');
    if (!s.profileValid()) out.push('choose a drone profile');
    return out;
  });

  protected onAltitudeInput(event: Event): void {
    const raw = (event.target as HTMLInputElement).value;
    this.store.setAltitude(raw === '' ? NaN : Number(raw));
  }

  protected setMode(mode: FlightMode): void {
    this.store.setMode(mode);
  }

  protected setObjective(objective: RouteObjective): void {
    this.store.setRouteObjective(objective);
  }

  protected setWeatherMode(mode: WeatherMode): void {
    this.store.setWeatherMode(mode);
  }

  protected loadFixture(id: DemoFixture['id']): void {
    this.demoError.set(this.store.loadDemoFixture(id));
  }

  protected selectScenario(id: ScenarioId): void {
    this.store.selectScenario(id);
  }

  protected profileName(id: string | null): string {
    return this.api.profileList()?.find((p) => p.id === id)?.name ?? id ?? '';
  }

  protected reset(): void {
    this.demoError.set(null);
    this.store.reset();
  }
}
