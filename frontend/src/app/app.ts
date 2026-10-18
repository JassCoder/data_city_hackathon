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
import { SimulationService } from './core/simulation';
import { AirspaceService } from './core/airspace';
import { MapDataService } from './core/map-data';
import { PlannerPanelComponent } from './planner/planner-panel';
import { RouteDetailsPanelComponent } from './planner/route-details-panel';
import { MapLayersControlComponent } from './map/layers-control';
import { AirspaceLegendComponent } from './map/airspace-legend';
import { FleetPanelComponent } from './planner/fleet-panel';
import { FleetService } from './core/fleet';
import { FacilityAction } from './map/fleet-layers';

@Component({
  imports: [
    MatToolbarModule,
    MatButtonModule,
    MatIconModule,
    MatProgressBarModule,
    MapComponent,
    PlannerPanelComponent,
    RouteDetailsPanelComponent,
    MapLayersControlComponent,
    AirspaceLegendComponent,
    FleetPanelComponent,
  ],
  selector: 'app-root',
  styleUrl: './app.scss',
  templateUrl: './app.html',
})
export class App {
  protected readonly health = httpResource<Health>(() => `${API_BASE_URL}/health`);
  protected readonly layers = inject(LayersService);
  protected readonly planner = inject(PlannerStore);
  protected readonly sim = inject(SimulationService);
  protected readonly airspace = inject(AirspaceService);
  protected readonly mapData = inject(MapDataService);
  protected readonly fleet = inject(FleetService);
  protected readonly tallBuildingM = TALL_BUILDING_M;

  protected readonly healthInfo = computed(() => safeValue(this.health));

  constructor() {
    this.planner.autoCalculate.set(true); // choosing Point A and B calculates the route at once
  }

  protected readonly backendStatus = computed(() => {
    if (this.health.isLoading()) return 'connecting';
    if (this.health.error()) return 'offline';
    return this.healthInfo()?.status === 'ok' ? 'online' : 'offline';
  });

  /** Popup actions are explicit user choices; scenario selection never moves Point A/B. */
  protected onFacilityAction(a: FacilityAction): void {
    switch (a.action) {
      case 'setStart':
      case 'setDestination':
        this.planner.setLocation(a.action === 'setStart' ? 'start' : 'destination',
          { coordinate: { latitude: a.latitude, longitude: a.longitude }, label: a.label, source: 'FACILITY' });
        break;
      case 'orderFrom': {
        const point = { latitude: a.latitude, longitude: a.longitude };
        if (this.planner.setLocation('start', { coordinate: point, label: `${a.label} (pickup pad)`, source: 'FACILITY' })) {
          this.fleet.draft.update((d) => ({ ...d, orderType: 'FOOD_DELIVERY', pickupFacilityId: a.padId,
            pickupFacilityPoint: point, partnerId: a.restaurantId }));
          this.fleet.dashboardOpen.set(true);
        }
        break;
      }
      case 'deliverTo': {
        const point = { latitude: a.latitude, longitude: a.longitude };
        if (this.planner.setLocation('destination', { coordinate: point, label: `${a.label} (drone station)`, source: 'FACILITY' })) {
          this.fleet.draft.update((d) => ({ ...d, destinationFacilityId: a.stationId, destinationFacilityPoint: point }));
          this.fleet.dashboardOpen.set(true);
        }
        break;
      }
      case 'viewFleet':
        this.fleet.dashboardOpen.set(true);
        break;
    }
  }

  protected retry(): void {
    this.health.reload();
    this.layers.resource.reload();
    this.airspace.resource.reload();
    this.mapData.boundary.reload();
    this.mapData.coverage.reload();
  }
}
