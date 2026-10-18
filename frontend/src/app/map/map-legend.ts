import { ChangeDetectionStrategy, Component, ElementRef, computed, inject, input, viewChild } from '@angular/core';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';
import { AirspaceService, SOURCE_LABEL } from '../core/airspace';
import { TALL_BUILDING_M } from '../core/layers';
import { MapLayersService } from '../core/map-layers';
import { IconComponent } from '../ui/icon';
import { isSmallScreen } from './layers-panel';
import { MAP_COLORS, ZONE_KINDS, ZONE_KIND_ORDER, zoneGlyphSvg, zoneSwatchSvg } from './map-style';

/** The one collapsible legend (bottom right). Same visuals as the map, built from map-style.ts. */
@Component({
  selector: 'app-map-legend',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent],
  template: `
    @if (open()) {
      <div id="map-legend" class="map-panel" role="region" aria-label="Map legend" data-testid="legend-panel"
           (keydown.escape)="close()">
        <h3>Airspace for {{ flightLabel() }}</h3>
        <ul class="rows">
          @for (row of zoneRows; track row.label) {
            <li><span class="sw" [innerHTML]="row.swatch"></span><span class="gl" [innerHTML]="row.glyph"></span>{{ row.label }}</li>
          }
        </ul>
        <h3>Drone routes</h3>
        <ul class="rows">
          <li><span class="sw line-multi" aria-hidden="true"></span>One colour per drone</li>
          <li><span class="sw line-stale" aria-hidden="true"></span>Outdated: settings changed</li>
        </ul>
        <h3>Map</h3>
        <ul class="rows">
          <li><span class="sw fill" [style.background]="c.river"></span>Vistula river</li>
          <li><span class="sw fill" [style.background]="c.park"></span>Parks and green</li>
          <li><span class="sw fill" [style.background]="c.building"></span>Building</li>
          <li><span class="sw fill" [style.background]="c.tallBuilding"></span>Building ≥&nbsp;{{ tallM }}&nbsp;m</li>
          <li><span class="sw outline" [style.borderColor]="c.city"></span>Warsaw boundary, districts</li>
          <li><span class="sw outline dashed" [style.borderColor]="c.extent"></span>Zone data extent</li>
          <li><span class="sw station" aria-hidden="true"></span>Landing station (demo)</li>
        </ul>
        <p class="source" data-testid="legend-source">{{ sourceText() }}</p>
      </div>
    }
    <button #toggleBtn type="button" class="map-btn" data-testid="legend-toggle" aria-controls="map-legend"
            [attr.aria-expanded]="open()" (click)="toggle()">
      <app-icon name="legend" /><span>Legend</span>
    </button>
  `,
  styles: `
    :host {
      display: flex;
      flex-direction: column;
      align-items: flex-end;
      gap: var(--sp-2);
    }
    .map-panel {
      width: min(248px, calc(100cqw - 24px));
      /* Bottom corner: 8 px gap + 32 px button + 10 px margin + attribution (~16 px). */
      max-height: calc(50cqh - 74px);
    }
    h3 {
      margin: 0 0 var(--sp-1);
      font-size: var(--fs-12);
    }
    .rows {
      margin: 0 0 var(--sp-3);
      padding: 0;
      list-style: none;
      display: grid;
      gap: 3px;
    }
    li {
      display: flex;
      align-items: center;
      gap: var(--sp-2);
      font-size: var(--fs-12);
      line-height: var(--lh-tight);
    }
    .sw {
      display: inline-flex;
      flex: none;
      width: 28px;
      height: 18px;
      align-items: center;
      justify-content: center;
    }
    .gl {
      display: inline-flex;
      flex: none;
      width: 16px;
      margin-left: -4px;
    }
    .gl:empty {
      visibility: hidden;
    }
    .fill {
      width: 20px;
      height: 12px;
      margin: 0 4px;
      border-radius: 2px;
      opacity: 0.8;
    }
    .outline {
      width: 20px;
      height: 12px;
      margin: 0 4px;
      border: 2px solid;
      border-radius: 2px;
    }
    .dashed {
      border-style: dashed;
    }
    .line-multi {
      height: 6px;
      margin: 6px 0;
      border-radius: 3px;
      background: linear-gradient(90deg, #0072b2 0 33%, #009e73 33% 66%, #b05fa0 66%);
    }
    .line-stale {
      height: 0;
      border-top: 3px dashed #7b8790; /* MAP_COLORS.routeStale */
    }
    .station {
      width: 14px;
      height: 14px;
      margin: 0 7px;
      border: 2px solid #fff;
      border-radius: 50%;
      background: #1f5f99;
      box-shadow: 0 0 0 1px var(--c-line-strong);
    }
    .source {
      font-size: var(--fs-11);
      color: var(--c-muted);
    }
  `,
})
export class MapLegendComponent {
  /** Whose evaluation the zones show, e.g. "Drone 2 at 80 m AGL". */
  readonly flightLabel = input('the planned flight');

  private readonly layers = inject(MapLayersService);
  private readonly airspace = inject(AirspaceService);
  private readonly sanitizer = inject(DomSanitizer);
  private readonly toggleBtn = viewChild.required<ElementRef<HTMLButtonElement>>('toggleBtn');

  protected readonly open = this.layers.legendOpen;
  protected readonly c = MAP_COLORS;
  protected readonly tallM = TALL_BUILDING_M;
  // Static, trusted markup generated in map-style.ts (no user data).
  protected readonly zoneRows: { label: string; swatch: SafeHtml; glyph: SafeHtml }[] = ZONE_KIND_ORDER.map((k) => ({
    label: ZONE_KINDS[k].label,
    swatch: this.sanitizer.bypassSecurityTrustHtml(zoneSwatchSvg(k)),
    glyph: this.sanitizer.bypassSecurityTrustHtml(zoneGlyphSvg(k, 16)),
  }));
  protected readonly sourceText = computed(() => {
    const s = this.airspace.source();
    return s ? `Airspace data: ${SOURCE_LABEL[s.sourceType]} (v${s.datasetVersion})` : 'Airspace data: not loaded';
  });

  protected toggle(): void {
    this.layers.toggle('legend', isSmallScreen());
  }

  protected close(): void {
    this.layers.legendOpen.set(false);
    this.toggleBtn().nativeElement.focus();
  }
}
