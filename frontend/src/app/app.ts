import { Component, computed, inject } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { LayersService } from './core/layers';
import { AirspaceService } from './core/airspace';
import { MapDataService } from './core/map-data';
import { HealthService } from './core/health';
import { DemoBadgeComponent } from './ui/demo-badge';
import { IconComponent } from './ui/icon';

/** Top bar (brand, demo notice, Plan | Simulate, backend status) above the routed page. */
@Component({
  imports: [RouterOutlet, RouterLink, RouterLinkActive, DemoBadgeComponent, IconComponent],
  selector: 'app-root',
  styleUrl: './app.scss',
  templateUrl: './app.html',
})
export class App {
  protected readonly health = inject(HealthService);
  protected readonly layers = inject(LayersService);
  private readonly airspace = inject(AirspaceService);
  private readonly mapData = inject(MapDataService);

  protected readonly backendLabel = computed(
    () => ({ connecting: 'Connecting…', online: 'Backend online', offline: 'Backend offline' })[this.health.status()],
  );
  protected readonly backendTitle = computed(() => {
    const h = this.health.info();
    if (!h) return 'Routing backend';
    const risk = h.riskDataAvailable ? 'risk layers loaded' : 'risk layers not loaded (Safest unavailable)';
    return `Routing backend v${h.version}, ${risk}`;
  });

  protected retry(): void {
    this.health.resource.reload();
    this.layers.resource.reload();
    this.airspace.resource.reload();
    this.mapData.boundary.reload();
    this.mapData.coverage.reload();
  }
}
