import { ChangeDetectionStrategy, Component, ElementRef, computed, inject, viewChild } from '@angular/core';
import { AirspaceService, CATEGORY_GROUPS, CategoryGroup } from '../core/airspace';
import { LayersService, TALL_BUILDING_M } from '../core/layers';
import { LayerKey, MapLayersService } from '../core/map-layers';
import { SETTINGS } from '../core/settings';
import { IconComponent } from '../ui/icon';
import { BUILDING_MIN_ZOOM } from './map';

/** The one "Layers" overlay (top right): grouped toggles and the zone category filters. */
@Component({
  selector: 'app-layers-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent],
  template: `
    <button #toggleBtn type="button" class="map-btn" data-testid="layers-toggle" aria-controls="layers-panel"
            [attr.aria-expanded]="open()" (click)="toggle()">
      <app-icon name="layers" /><span>Layers</span>
    </button>
    @if (open()) {
      <div id="layers-panel" class="map-panel" role="region" aria-label="Map layers" data-testid="layers-panel"
           (keydown.escape)="close()">
        <fieldset>
          <legend>Airspace</legend>
          <label class="check">
            <input type="checkbox" [checked]="v().zones" (change)="set('zones', $event)" />
            <span>Zones</span><span class="count num">{{ zoneCount() }}</span>
          </label>
          <div class="sub" role="group" aria-label="Zone categories">
            @for (g of groups; track g.key) {
              <label class="check">
                <input type="checkbox" [checked]="filters()[g.key]" [disabled]="!v().zones"
                       (change)="filter(g.key, $event)" [attr.data-testid]="'filter-' + g.key" />
                <span>{{ g.label }}</span><span class="count num">{{ counts()[g.key] }}</span>
              </label>
            }
          </div>
          <label class="check">
            <input type="checkbox" [checked]="v().extent" (change)="set('extent', $event)" />
            <span>Zone data extent</span>
          </label>
          <p class="note" data-testid="filter-note">
            Filters change the map display only. Routing always uses every loaded zone.
          </p>
        </fieldset>
        <fieldset>
          <legend>Buildings</legend>
          <label class="check">
            <input type="checkbox" [checked]="v().buildings" (change)="set('buildings', $event)" />
            <span>All footprints (zoom {{ minZoom }}+)</span>
          </label>
          <label class="check">
            <input type="checkbox" [checked]="v().tallBuildings" (change)="set('tallBuildings', $event)" />
            <span>Tall buildings (≥&nbsp;{{ tallM }}&nbsp;m)</span><span class="count num">{{ summary()?.tallBuildings ?? '–' }}</span>
          </label>
        </fieldset>
        <fieldset>
          <legend>Boundaries</legend>
          <label class="check">
            <input type="checkbox" [checked]="v().city" (change)="set('city', $event)" />
            <span>Warsaw boundary</span>
          </label>
          <label class="check">
            <input type="checkbox" [checked]="v().districts" (change)="set('districts', $event)" />
            <span>Districts</span><span class="count num">18</span>
          </label>
          <label class="check">
            <input type="checkbox" [checked]="v().river" (change)="set('river', $event)" />
            <span>Vistula river</span>
          </label>
          <label class="check">
            <input type="checkbox" [checked]="v().parks" (change)="set('parks', $event)" />
            <span>Parks and green</span><span class="count num">{{ summary()?.parks ?? '–' }}</span>
          </label>
        </fieldset>
        <fieldset>
          <legend>Landing stations</legend>
          <label class="check">
            <input type="checkbox" [checked]="v().stations" (change)="set('stations', $event)" />
            <span>Stations <span class="badge badge-demo tiny">Demo</span></span>
            <span class="count num">{{ summary()?.stations ?? '–' }}</span>
          </label>
        </fieldset>
      </div>
    }
  `,
  styles: `
    :host {
      display: flex;
      flex-direction: column;
      align-items: flex-end;
      gap: var(--sp-2);
    }
    .map-panel {
      width: min(272px, calc(100cqw - 72px));
      /* Top corner: 10 px margin + 32 px button + 8 px gap above the panel; the bottom
         corner (legend) gets the other half of the map height. */
      max-height: calc(50cqh - 54px);
    }
    fieldset {
      margin: 0;
      padding: 0;
      border: 0;
      display: grid;
      gap: 2px;
    }
    fieldset + fieldset {
      margin-top: var(--sp-3);
      padding-top: var(--sp-3);
      border-top: 1px solid var(--c-line);
    }
    legend {
      padding: 0;
      margin-bottom: var(--sp-1);
      font-size: var(--fs-12);
      font-weight: var(--fw-bold);
    }
    .sub {
      display: grid;
      gap: 2px;
      padding-left: var(--sp-5);
    }
    .count {
      margin-left: auto;
      color: var(--c-muted);
      font-size: var(--fs-12);
    }
    .note {
      margin-top: var(--sp-1);
      font-size: var(--fs-11);
      color: var(--c-muted);
    }
    .tiny {
      padding: 0 5px;
      font-size: var(--fs-11);
      line-height: 15px;
    }
  `,
})
export class LayersPanelComponent {
  private readonly layers = inject(MapLayersService);
  private readonly airspace = inject(AirspaceService);
  private readonly data = inject(LayersService);
  private readonly toggleBtn = viewChild.required<ElementRef<HTMLButtonElement>>('toggleBtn');

  protected readonly groups = CATEGORY_GROUPS;
  protected readonly minZoom = BUILDING_MIN_ZOOM;
  protected readonly tallM = TALL_BUILDING_M;
  protected readonly open = this.layers.layersOpen;
  protected readonly v = this.layers.visible;
  protected readonly filters = this.airspace.filters;
  protected readonly counts = this.airspace.counts;
  protected readonly zoneCount = computed(() => this.airspace.zones().length);
  protected readonly summary = this.data.summary;

  protected toggle(): void {
    this.layers.toggle('layers', isSmallScreen());
  }

  protected close(): void {
    this.layers.layersOpen.set(false);
    this.toggleBtn().nativeElement.focus();
  }

  protected set(key: LayerKey, event: Event): void {
    this.layers.setVisible(key, (event.target as HTMLInputElement).checked);
  }

  protected filter(group: CategoryGroup, event: Event): void {
    this.airspace.toggleFilter(group, (event.target as HTMLInputElement).checked);
  }
}

export function isSmallScreen(): boolean {
  return typeof matchMedia === 'function' && matchMedia(`(max-width: ${SETTINGS.mobileMaxWidthPx}px)`).matches;
}
