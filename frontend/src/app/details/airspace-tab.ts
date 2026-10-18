import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';
import { AirspaceService, AirspaceZone, SOURCE_LABEL } from '../core/airspace';
import { FleetStore } from '../core/fleet.store';
import { ZONE_KINDS, ZONE_KIND_ORDER, ZoneKind, zoneGlyphSvg, zoneKind } from '../map/map-style';

/** Drawer "Airspace" tab: the zones as evaluated for the selected flight. */
@Component({
  selector: 'app-airspace-tab',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (airspace.resource.error() && !airspace.zones().length) {
      <div class="state state-error" role="alert" data-testid="airspace-error">
        <p>Could not load airspace zones from the backend.</p>
        <button type="button" class="btn btn-s" (click)="airspace.resource.reload()">Try again</button>
      </div>
    } @else {
      <p class="context" data-testid="airspace-context">
        Zones evaluated for <b>{{ flight() }}</b>.
        @if (airspace.resource.isLoading()) {
          <span class="muted">Updating…</span>
        }
      </p>
      @if (source(); as s) {
        <div class="source" data-testid="airspace-source">
          <span class="badge" [class]="s.sourceType === 'DEMO' ? 'badge badge-demo' : 'badge badge-neutral'">{{ sourceLabel[s.sourceType] }}</span>
          <span class="muted small">{{ s.label }} · version {{ s.datasetVersion }}</span>
          <p class="small muted">{{ s.disclaimer }}</p>
        </div>
      }
      @for (g of groups(); track g.kind) {
        <section class="group" [attr.aria-label]="g.label">
          <h3><span class="glyph" [innerHTML]="g.glyph"></span>{{ g.label }} <span class="muted num">{{ g.zones.length }}</span></h3>
          <p class="small muted">{{ g.meaning }}</p>
          <ul>
            @for (z of g.zones; track z.id) {
              <li>
                <button type="button" class="zone" (click)="airspace.focusZoneId.set(z.id)" [attr.data-testid]="'zone-' + z.id">
                  <span class="zname">{{ z.name }}</span><span class="cat">{{ z.draCategory }}</span>
                </button>
              </li>
            }
          </ul>
        </section>
      } @empty {
        <p class="state">No zones loaded.</p>
      }
      <p class="small muted">Zone filters in the Layers panel change the map only. Routing always uses every loaded zone.</p>
    }
  `,
  styles: `
    :host {
      display: grid;
      gap: var(--sp-3);
      font-size: var(--fs-13);
    }
    .source {
      display: grid;
      gap: var(--sp-1);
      justify-items: start;
    }
    .group {
      display: grid;
      gap: var(--sp-1);
    }
    h3 {
      display: flex;
      align-items: center;
      gap: var(--sp-2);
      font-size: var(--fs-13);
    }
    .glyph {
      display: inline-flex;
    }
    ul {
      margin: 0;
      padding: 0;
      list-style: none;
    }
    .zone {
      display: flex;
      align-items: center;
      gap: var(--sp-2);
      width: 100%;
      padding: var(--sp-1) var(--sp-2);
      border: 0;
      border-radius: var(--radius-s);
      background: transparent;
      text-align: left;
    }
    .zone:hover {
      background: var(--c-surface-2);
    }
    .zname {
      flex: 1;
      min-width: 0;
    }
    .cat {
      color: var(--c-muted);
      font-size: var(--fs-12);
    }
  `,
})
export class AirspaceTabComponent {
  protected readonly airspace = inject(AirspaceService);
  private readonly fleet = inject(FleetStore);
  private readonly sanitizer = inject(DomSanitizer);

  protected readonly sourceLabel = SOURCE_LABEL;
  protected readonly source = this.airspace.source;
  protected readonly flight = computed(() => {
    const d = this.fleet.focusDrone();
    return d ? `${d.name} at ${this.airspace.altitude()} m above ground` : `${this.airspace.altitude()} m above ground`;
  });
  protected readonly groups = computed(() => {
    const byKind = new Map<ZoneKind, AirspaceZone[]>();
    for (const z of this.airspace.zones()) {
      const k = zoneKind(z.evaluation);
      byKind.set(k, [...(byKind.get(k) ?? []), z]);
    }
    return ZONE_KIND_ORDER.filter((k) => byKind.has(k)).map((k) => ({
      kind: k,
      label: ZONE_KINDS[k].label,
      meaning: ZONE_KINDS[k].meaning,
      zones: byKind.get(k)!,
      // Static, trusted markup generated in map-style.ts.
      glyph: this.sanitizer.bypassSecurityTrustHtml(zoneGlyphSvg(k, 16)) as SafeHtml,
    }));
  });
}
