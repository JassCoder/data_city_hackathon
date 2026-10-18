import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';

import { CostTerm } from '../core/models';
import { MODE_LABEL, OBJECTIVE_LABEL, TERM_LABEL } from '../core/routing-options';
import { formatDistance, formatDuration, formatNumber } from '../ui/format';
import { STATE_LABEL } from './event-feed';
import { LegBreakdown } from './sim-models';
import { SimSession } from './sim-session';
import { STATE_BADGE, formatEta } from './telemetry-list';
import { formatElapsed } from './timeline';

const AFTER_DELIVERY: Record<string, string> = {
  RETURN_TO_START: 'Back to Point A',
  NEAREST_STATION: 'Nearest landing station',
  STAY_AT_DESTINATION: 'Stays at Point B',
};
const MISSION_STATUS: Record<string, string> = {
  LOADING: 'Loading',
  OUTBOUND: 'Flying to Point B',
  DELIVERED: 'Delivered',
  RETURNING: 'Delivered, returning',
  COMPLETED: 'Completed',
  REJECTED: 'Rejected',
  ABORTED: 'Aborted',
};
const LEG_LABEL: Record<string, string> = { outbound: 'Outbound', return: 'Return', divert: 'Divert' };

/** Right drawer: the selected drone's mission, planned vs. actual energy and route cost breakdown. */
@Component({
  selector: 'app-drone-details',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './drone-details.scss',
  template: `
    @if (sim.selected(); as t) {
      <section class="dd" data-testid="drone-details">
        <dl class="dd-live">
          <div><dt>State</dt><dd><span class="badge" [class]="'badge ' + badge[t.pose.state]">{{ stateLabel[t.pose.state] }}</span></dd></div>
          <div><dt>Battery</dt><dd class="num">{{ t.pose.batteryPct.toFixed(1) }} %</dd></div>
          <div><dt>Speed</dt><dd class="num">{{ t.pose.speedMps.toFixed(1) }} m/s</dd></div>
          <div><dt>Altitude</dt><dd class="num">{{ t.pose.altitudeM.toFixed(0) }} m</dd></div>
          <div><dt>Heading</dt><dd class="num">{{ t.pose.headingDeg.toFixed(0) }}°</dd></div>
          <div><dt>Arrives in</dt><dd class="num">{{ eta(t.etaS) }}</dd></div>
        </dl>
        @if (t.target) {
          <p class="small muted">Flying to {{ t.target }}{{ t.progress !== null ? ', ' + (t.progress * 100).toFixed(0) + ' % of the route' : '' }}.</p>
        }

        @if (sim.mode() === 'REPLAY') {
          <p class="note" data-testid="dd-replay-note">
            Replaying {{ elapsed(sim.playT()) }}. Mission and energy below are as of the newest time,
            {{ elapsed(sim.headT()) }}.
          </p>
        }

        @if (detail(); as d) {
          @if (d.mission; as m) {
            <h3>
              Mission {{ m.id }}
              <span class="badge badge-neutral">{{ status(m.status) }}</span>
            </h3>
            <dl class="dd-grid">
              <dt>From</dt><dd>{{ m.start.label }}</dd>
              <dt>To</dt><dd>{{ m.destination.label }}</dd>
              <dt>Afterwards</dt><dd>{{ m.returnTarget?.label ?? afterDelivery(m.afterDelivery) }}</dd>
              <dt>Mode</dt><dd>{{ mode(m.mode) }}, {{ objective(m.routeObjective) }}</dd>
              <dt>Altitude</dt><dd class="num">{{ m.altitudeM }} m</dd>
              <dt>Payload</dt><dd class="num">{{ m.payloadKg }} kg</dd>
            </dl>

            @if (energy(); as en) {
              <h3>Energy</h3>
              <div class="bars" data-testid="dd-energy">
                <div class="bar-row">
                  <span class="bar-label">Planned</span>
                  <span class="bar"><i class="planned" [style.width.%]="en.plannedPct"></i></span>
                  <span class="bar-value num">{{ wh(en.planned) }}</span>
                </div>
                <div class="bar-row">
                  <span class="bar-label">{{ en.toFinish !== null ? 'Used + needed' : 'Used' }}</span>
                  <span class="bar">
                    <i class="used" [style.width.%]="en.usedPct"></i>
                    @if (en.toFinish !== null) {
                      <i class="needed" [style.width.%]="en.neededPct"></i>
                    }
                  </span>
                  <span class="bar-value num">{{ wh(en.projected) }}</span>
                </div>
              </div>
              <p class="small" [class.over]="en.delta !== null && en.delta > 0.02" data-testid="dd-energy-text">
                Used {{ wh(en.used) }}{{ en.toFinish !== null ? ', about ' + wh(en.toFinish) + ' still needed' : '' }}.
                @if (en.delta !== null) {
                  {{ en.delta > 0 ? 'About ' + pct(en.delta) + ' more than planned.' : en.delta < 0 ? 'About ' + pct(-en.delta) + ' less than planned.' : 'As planned.' }}
                }
                @if (en.fault > 0) {
                  Lost {{ wh(en.fault) }} to a battery fault.
                }
              </p>
              <p class="small muted">Battery now {{ wh(en.battery) }}, reserve {{ wh(en.reserve) }}.</p>
            }

            @if (legs().length) {
              <h3>Route cost</h3>
              @for (leg of legs(); track leg.kind) {
                <details class="leg" [open]="$first" [attr.data-testid]="'dd-leg-' + leg.kind">
                  <summary>
                    <b>{{ leg.label }}</b>
                    <span class="muted num">{{ distance(leg.b.lengthM) }}, {{ wh(leg.b.energyWh) }}, {{ duration(leg.b.flightTimeS) }}</span>
                  </summary>
                  <table class="terms">
                    <thead><tr><th scope="col">Term</th><th scope="col">Weight</th><th scope="col">Mean</th><th scope="col">Cost</th></tr></thead>
                    <tbody>
                      <tr><td>Distance</td><td>1</td><td>—</td><td class="num">{{ num(leg.b.lengthM) }}</td></tr>
                      @for (term of leg.b.terms; track term.term) {
                        <tr [class.off]="!term.weight">
                          <td>{{ termLabel(term.term) }}</td><td class="num">{{ term.weight }}</td>
                          <td class="num">{{ term.mean.toFixed(2) }}</td><td class="num">{{ num(term.cost) }}</td>
                        </tr>
                      }
                      <tr class="total"><td>Total</td><td></td><td></td><td class="num">{{ num(leg.b.totalCost) }}</td></tr>
                    </tbody>
                  </table>
                </details>
              }
              <p class="small muted">Latest plan per leg; re-routes replace it. {{ legs()[0].b.note }}</p>
            }

            @if (d.missions.length > 1) {
              <h3>Earlier missions</h3>
              <ul class="history">
                @for (h of d.missions.slice(0, -1); track h.id) {
                  <li><span>{{ h.id }}: {{ status(h.status) }}</span><span class="num muted">{{ wh(h.energyUsedWh) }} of {{ wh(h.plannedEnergyWh) }}</span></li>
                }
              </ul>
            }
          } @else {
            <p class="state">No mission yet: this drone waits for its first departure.</p>
          }
        } @else {
          <p class="state" role="status"><span class="spinner"></span> Loading details…</p>
        }
        <p class="small muted dd-note">{{ sim.info()?.note }}</p>
      </section>
    } @else {
      <p class="state">Select a drone in the list or on the map.</p>
    }
  `,
})
export class DroneDetailsComponent {
  protected readonly sim = inject(SimSession);
  protected readonly badge = STATE_BADGE;
  protected readonly stateLabel = STATE_LABEL;
  protected readonly eta = formatEta;
  protected readonly elapsed = formatElapsed;
  protected readonly distance = formatDistance;
  protected readonly duration = formatDuration;

  protected readonly detail = computed(() => {
    const d = this.sim.detail();
    return d && d.drone.id === this.sim.selectedId() ? d : null;
  });

  protected readonly energy = computed(() => {
    const e = this.detail()?.energy;
    if (!e) return null;
    const planned = e.plannedWh;
    const projected = e.projectedWh ?? e.usedWh;
    const scale = Math.max(planned ?? 0, projected, 1e-9);
    return {
      planned,
      used: e.usedWh,
      toFinish: e.toFinishWh,
      projected,
      fault: e.faultLossWh,
      battery: e.batteryWh,
      reserve: e.reserveWh,
      plannedPct: ((planned ?? 0) / scale) * 100,
      usedPct: (e.usedWh / scale) * 100,
      neededPct: ((e.toFinishWh ?? 0) / scale) * 100,
      delta: planned ? Math.round((projected / planned - 1) * 100) / 100 : null, // whole per cent: under 1 % reads "as planned"
    };
  });

  protected readonly legs = computed(() => {
    const b = this.detail()?.mission?.breakdowns ?? {};
    return (['outbound', 'return', 'divert'] as const)
      .filter((k) => b[k])
      .map((k) => ({ kind: k, label: LEG_LABEL[k], b: b[k] as LegBreakdown }));
  });

  protected wh(v: number | null | undefined): string {
    return v === null || v === undefined ? '—' : `${formatNumber(v)} Wh`;
  }

  protected pct(v: number): string {
    return `${(v * 100).toFixed(0)} %`;
  }

  protected num(v: number): string {
    return formatNumber(v, 0);
  }

  protected status(s: string): string {
    return MISSION_STATUS[s] ?? s;
  }

  protected afterDelivery(s: string): string {
    return AFTER_DELIVERY[s] ?? s;
  }

  protected mode(m: string): string {
    return MODE_LABEL[m as keyof typeof MODE_LABEL] ?? m;
  }

  protected objective(o: string): string {
    return OBJECTIVE_LABEL[o as keyof typeof OBJECTIVE_LABEL] ?? o;
  }

  protected termLabel(t: string): string {
    return TERM_LABEL[t as CostTerm] ?? t;
  }
}
