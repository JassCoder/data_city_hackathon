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
import { FleetFlightService } from './core/fleet-flight';
import { AirspaceService } from './core/airspace';
import { MapDataService } from './core/map-data';
import { Coordinate } from './core/models';
import { PlannerPanelComponent } from './planner/planner-panel';
import { RouteDetailsPanelComponent } from './planner/route-details-panel';
import { MapLayersControlComponent } from './map/layers-control';
import { AirspaceLegendComponent } from './map/airspace-legend';
import { CityWeatherComponent } from './map/city-weather';
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
    CityWeatherComponent,
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
  protected readonly flight = inject(FleetFlightService);
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

  /** Opening or closing the Fleet dashboard starts fresh: no old addresses, route, simulation or form input. */
  protected toggleFleetDashboard(): void {
    this.sim.stop();
    this.flight.clear();
    this.planner.reset(); // also clears the planner's address fields (resetCount)
    this.fleet.resetForm();
    this.fleet.dashboardOpen.set(!this.fleet.dashboardOpen());
  }

  /** A fleet "Select on map" field takes the click; otherwise the planner does. */
  protected onMapClick(c: Coordinate): void {
    if (!this.fleet.pickTarget()) {
      this.planner.handleMapClick(c);
      return;
    }
    if (this.mapData.contains(c) === false) {
      this.fleet.lastMessage.set({ ok: false, text: 'That point is outside the City of Warsaw boundary. Choose a point inside Warsaw.' });
      return;
    }
    this.fleet.setPickedPoint(c);
  }

  /** Popup actions are explicit user choices; scenario selection never moves Point A/B. */
  protected onFacilityAction(a: FacilityAction): void {
    switch (a.action) {
      case 'setStart':
      case 'setDestination':
        this.planner.setLocation(a.action === 'setStart' ? 'start' : 'destination',
          { coordinate: { latitude: a.latitude, longitude: a.longitude }, label: a.label, source: 'FACILITY' });
        break;
      case 'orderFrom': {
        // Fills the fleet order form (its own addresses); the planner's Point A/B stay as they are.
        const point = { latitude: a.latitude, longitude: a.longitude };
        this.fleet.draft.update((d) => ({ ...d, orderType: 'FOOD_DELIVERY', pickup: { coordinate: point, label: `${a.label} (pickup pad)` },
          pickupFacilityId: a.padId, partnerId: a.restaurantId }));
        this.fleet.showLayersFor('FOOD_DELIVERY');
        this.fleet.dashboardOpen.set(true);
        break;
      }
      case 'deliverTo': {
        const point = { latitude: a.latitude, longitude: a.longitude };
        this.fleet.draft.update((d) => ({ ...d, delivery: { coordinate: point, label: `${a.label} (drone station)` },
          destinationFacilityId: a.stationId }));
        this.fleet.dashboardOpen.set(true);
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
