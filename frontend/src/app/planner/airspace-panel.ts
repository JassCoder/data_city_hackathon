import { Component, inject } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatIconModule } from '@angular/material/icon';
import { describeHttpError } from '../core/api';
import { AirspaceService, CATEGORY_GROUPS, SOURCE_LABEL, STATUS_LABEL } from '../core/airspace';

@Component({
  selector: 'app-airspace-panel',
  imports: [MatButtonModule, MatCheckboxModule, MatIconModule],
  template: `
    <h2>Airspace zones</h2>
    @if (airspace.resource.error(); as err) {
      <p class="error" role="alert" data-testid="airspace-error">
        Airspace zones could not be loaded: {{ errorText(err) }}
      </p>
      <button mat-stroked-button (click)="airspace.resource.reload()">Retry</button>
    } @else if (airspace.source(); as src) {
      <div class="source" [class]="'source source-' + src.sourceType.toLowerCase()" data-testid="airspace-source">
        <span class="badge">{{ sourceLabel[src.sourceType] }}</span>
        <span class="label">{{ src.label }}</span>
        <span class="meta">version {{ src.datasetVersion }} · evaluated for
          {{ airspace.response()?.flightContext?.flightAltitudeMeters }} m AGL, now</span>
        <span class="disclaimer">{{ src.disclaimer }}</span>
      </div>

      <div class="filters" data-testid="zone-filters">
        @for (g of groups; track g.key) {
          <mat-checkbox
            [checked]="airspace.filters()[g.key]"
            (change)="airspace.toggleFilter(g.key, $event.checked)"
            [attr.data-testid]="'filter-' + g.key"
          >
            {{ g.label }} ({{ airspace.counts()[g.key] }})
          </mat-checkbox>
        }
        <p class="hint">Filters change the map only. Routing always uses every loaded zone.</p>
      </div>

      <ul class="zones" data-testid="zone-list">
        @for (z of airspace.visibleZones(); track z.id) {
          <li>
            <button type="button" class="zone" (click)="airspace.focusZoneId.set(z.id)" [attr.data-zone-id]="z.id">
              <span class="dot" [class]="'dot dot-' + z.evaluation.displayClass.toLowerCase()"
                    [class.obstacle]="z.evaluation.isObstacle"></span>
              <span class="text">
                <span class="name">{{ z.name }}</span>
                <span class="meta">{{ z.draCategory }} · {{ statusLabel[z.evaluation.status] }}</span>
              </span>
            </button>
          </li>
        } @empty {
          <li class="hint">No zones match the selected filters.</li>
        }
      </ul>
    } @else {
      <p class="hint">Loading airspace zones…</p>
    }
  `,
  styleUrl: './airspace-panel.scss',
})
export class AirspacePanelComponent {
  protected readonly airspace = inject(AirspaceService);
  protected readonly groups = CATEGORY_GROUPS;
  protected readonly sourceLabel = SOURCE_LABEL;
  protected readonly statusLabel = STATUS_LABEL;

  protected errorText(err: unknown): string {
    return describeHttpError(err, 'request failed');
  }
}
