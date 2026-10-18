import { Component, computed, inject } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatButtonToggleModule } from '@angular/material/button-toggle';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatSliderModule } from '@angular/material/slider';
import { ALTITUDE } from '../core/models';
import { PlannerApi } from '../core/planner-api';
import { PlannerStore } from '../core/planner.store';
import { SimulationService } from '../core/simulation';
import { SimulationPanelComponent } from './simulation-panel';
import { LocationInputComponent } from './location-input';
import { WeatherStatusComponent } from './weather-status';

/**
 * Flight planner: Point A/B, altitude, flight mode, optimisation, the fixed Standard
 * Drone profile and weather. Restricted-zone avoidance is always on (no scenario choice);
 * the backend picks the calculation time (Europe/Warsaw).
 */
@Component({
  selector: 'app-planner-panel',
  imports: [
    LocationInputComponent,
    WeatherStatusComponent,
    MatButtonModule,
    MatButtonToggleModule,
    MatFormFieldModule,
    MatIconModule,
    MatInputModule,
    MatProgressSpinnerModule,
    MatSliderModule,
    SimulationPanelComponent,
  ],
  templateUrl: './planner-panel.html',
  styleUrl: './planner-panel.scss',
})
export class PlannerPanelComponent {
  protected readonly store = inject(PlannerStore);
  protected readonly api = inject(PlannerApi);
  protected readonly sim = inject(SimulationService);
  protected readonly ALTITUDE = ALTITUDE;

  /** The Standard Drone (the store's fixed profile id). */
  protected readonly profile = computed(() => this.api.profileList()?.find((p) => p.id === this.store.droneProfileId()));

  /** Clamped value for the slider thumb; the numeric input shows the raw value. */
  protected readonly sliderValue = computed(() => {
    const v = this.store.altitude();
    return Number.isFinite(v) ? Math.min(ALTITUDE.max, Math.max(ALTITUDE.min, v)) : ALTITUDE.default;
  });

  /** Why Calculate Route is disabled, in plain words. */
  protected readonly missing = computed(() => {
    const s = this.store;
    const out: string[] = [];
    if (!s.start()) out.push('select the starting address');
    if (!s.destination()) out.push('select the destination address');
    const a = s.start()?.coordinate;
    const b = s.destination()?.coordinate;
    if (a && b && a.latitude === b.latitude && a.longitude === b.longitude) out.push('choose two different points');
    if (!s.altitudeValid()) out.push('enter a valid altitude');
    if (!s.profileValid()) out.push('drone profile unavailable');
    return out;
  });

  protected onAltitudeInput(event: Event): void {
    const raw = (event.target as HTMLInputElement).value;
    this.store.setAltitude(raw === '' ? NaN : Number(raw));
  }
}
