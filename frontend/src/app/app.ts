import { Component, computed, inject } from '@angular/core';
import { httpResource } from '@angular/common/http';
import { MatToolbarModule } from '@angular/material/toolbar';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MapComponent } from './map/map';
import { API_BASE_URL, Health, safeValue } from './core/api';
import { LayersService, TALL_BUILDING_M } from './core/layers';
import { PlannerStore } from './core/planner.store';
import { AirspaceService } from './core/airspace';
import { AirspacePanelComponent } from './planner/airspace-panel';
import { PlannerPanelComponent } from './planner/planner-panel';
import { RouteResultsComponent } from './planner/route-results';

@Component({
  imports: [
    MatToolbarModule,
    MatButtonModule,
    MatIconModule,
    MatProgressBarModule,
    MapComponent,
    PlannerPanelComponent,
    RouteResultsComponent,
    AirspacePanelComponent,
  ],
  selector: 'app-root',
  styleUrl: './app.scss',
  templateUrl: './app.html',
})
export class App {
  protected readonly health = httpResource<Health>(() => `${API_BASE_URL}/health`);
  protected readonly layers = inject(LayersService);
  protected readonly planner = inject(PlannerStore);
  protected readonly airspace = inject(AirspaceService);
  protected readonly tallBuildingM = TALL_BUILDING_M;

  protected readonly healthInfo = computed(() => safeValue(this.health));

  protected readonly backendStatus = computed(() => {
    if (this.health.isLoading()) return 'connecting';
    if (this.health.error()) return 'offline';
    return this.healthInfo()?.status === 'ok' ? 'online' : 'offline';
  });

  protected retry(): void {
    this.health.reload();
    this.layers.resource.reload();
    this.airspace.resource.reload();
  }
}
