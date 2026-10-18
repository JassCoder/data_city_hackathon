import { Component, computed, inject } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MapLayerStore } from '../core/map-layers';
import { RouteResultsComponent } from './route-results';

/** Top-right "Route Details" button (below Layers) with the collapsible route panel. */
@Component({
  selector: 'app-route-details-panel',
  imports: [MatButtonModule, MatIconModule, RouteResultsComponent],
  template: `
    <button
      mat-flat-button
      class="map-fab"
      data-testid="route-details-toggle"
      aria-controls="route-details-panel"
      [attr.aria-expanded]="open()"
      (click)="toggle()"
    >
      <mat-icon>route</mat-icon> Route Details
    </button>
    <section
      id="route-details-panel"
      class="map-panel"
      data-testid="route-details-panel"
      role="region"
      aria-label="Route details"
      [hidden]="!open()"
      (keydown.escape)="layers.openPanel.set(null)"
    >
      <app-route-results />
    </section>
  `,
  styleUrl: '../map/map-overlays.scss',
})
export class RouteDetailsPanelComponent {
  protected readonly layers = inject(MapLayerStore);
  protected readonly open = computed(() => this.layers.openPanel() === 'route');

  protected toggle(): void {
    this.layers.openPanel.set(this.open() ? null : 'route');
  }
}
