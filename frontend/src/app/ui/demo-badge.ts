import { ChangeDetectionStrategy, Component } from '@angular/core';

/** The single "Demo data" badge; the full disclaimer opens in a native popover (Esc closes it). */
@Component({
  selector: 'app-demo-badge',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <button type="button" class="badge badge-demo" popovertarget="demo-disclaimer" data-testid="demo-badge"
            aria-haspopup="dialog">
      Demo data
    </button>
    <div id="demo-disclaimer" popover class="popover demo-popover" role="dialog" aria-label="About the demo data"
         data-testid="demo-disclaimer">
      <p><b>Planning and simulation prototype.</b> It never controls real drones.</p>
      <p>
        Airspace zones, landing stations and drone profiles are synthetic demo data, not official PAŻP zones.
        Avoiding them does not mean a route is legal or authorized.
      </p>
      <p>
        Real limits depend on the operation category and the airspace. Check PANSA DroneMap and DroneTower before
        any real flight.
      </p>
      <p class="muted small">Buildings, parks, river and land use © OpenStreetMap contributors. Boundary: GUGiK PRG.</p>
    </div>
  `,
  styles: `
    :host {
      display: inline-flex;
    }
    /* Anchored under the badge where CSS anchor positioning exists; centred otherwise. */
    @supports (position-area: bottom) {
      .demo-popover {
        inset: auto;
        margin: var(--sp-2) 0 0;
        position-area: bottom span-right;
      }
    }
  `,
})
export class DemoBadgeComponent {}
