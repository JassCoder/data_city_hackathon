import { Component, inject } from '@angular/core';
import { DatePipe, DecimalPipe } from '@angular/common';
import { MatButtonModule } from '@angular/material/button';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { describeHttpError } from '../core/api';
import { AirspaceService, CATEGORY_GROUPS, SOURCE_LABEL, STALE_AFTER_DAYS, STATUS_LABEL } from '../core/airspace';

@Component({
  selector: 'app-airspace-panel',
  imports: [DatePipe, DecimalPipe, MatButtonModule, MatCheckboxModule, MatIconModule, MatProgressBarModule],
  template: `
    <h2>Airspace zones</h2>
    @if (airspace.loading()) {
      <mat-progress-bar mode="indeterminate" data-testid="airspace-loading" aria-label="Loading airspace zones" />
    }
    @if (airspace.resource.error(); as err) {
      <p class="error" role="alert" data-testid="airspace-error">
        Airspace zones could not be loaded: {{ errorText(err) }}. Routing on the server still uses its last
        loaded dataset; the map cannot show it.
      </p>
      <button mat-stroked-button (click)="airspace.resource.reload()">Retry</button>
    } @else if (airspace.source(); as src) {
      @if (airspace.completeness(); as c) {
        @if (c.status !== 'COMPLETE') {
          <p class="completeness warn" role="status" data-testid="airspace-completeness">
            <mat-icon inline>warning</mat-icon> {{ c.message }}
          </p>
        } @else {
          <p class="completeness" data-testid="airspace-completeness">{{ c.message }}</p>
        }
      }
      <div class="source" [class]="'source source-' + src.sourceType.toLowerCase()" data-testid="airspace-source">
        <span class="badge">{{ sourceLabel[src.sourceType] }}</span>
        <span class="label">{{ src.label }}</span>
        <span class="meta">version {{ src.datasetVersion }} · evaluated for
          {{ airspace.evaluatedFor()?.flightAltitudeMeters }} m AGL at
          {{ airspace.evaluatedFor()?.at | date: 'yyyy-MM-dd HH:mm' : 'UTC' }} UTC</span>
        @if (airspace.freshness(); as f) {
          <span class="meta" data-testid="airspace-freshness" [class.stale]="f.stale">
            Source data: {{ src.sourceTimestamp ? (src.sourceTimestamp | date: 'yyyy-MM-dd' : 'UTC') : 'date unknown' }}
            @if (f.ageDays !== null) { ({{ f.ageDays }} {{ f.ageDays === 1 ? 'day' : 'days' }} old) }
            · loaded {{ src.loadedAt | date: 'yyyy-MM-dd HH:mm' : 'UTC' }} UTC
            @if (f.stale) { · <b>may be outdated</b> (older than {{ staleDays }} days or undated) }
          </span>
        }
        <span class="disclaimer">{{ src.disclaimer }}</span>
      </div>

      <p class="hint">Category visibility is set in the Layers panel. Routing always uses every loaded zone.</p>

      <ul class="zones" data-testid="zone-list">
        @for (z of airspace.visibleZones(); track z.id) {
          <li>
            <button type="button" class="zone" (click)="airspace.focusZoneId.set(z.id)" [attr.data-zone-id]="z.id">
              <span class="dot" [class]="'dot dot-' + dotClass(z.evaluation)"
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

    <button mat-button class="diag-toggle" data-testid="diagnostics-toggle"
            [attr.aria-expanded]="airspace.diagnosticsOpen()"
            (click)="airspace.diagnosticsOpen.set(!airspace.diagnosticsOpen())">
      <mat-icon>{{ airspace.diagnosticsOpen() ? 'expand_less' : 'bug_report' }}</mat-icon>
      Coverage diagnostics
    </button>
    @if (airspace.diagnosticsOpen()) {
      <div class="diagnostics" data-testid="diagnostics">
        @if (airspace.diagnostics.error(); as err) {
          <p class="error" role="alert">Diagnostics unavailable: {{ errorText(err) }}</p>
        } @else if (airspace.diagnosticsData(); as d) {
          <dl class="totals" data-testid="diag-totals">
            <dt>Zone features</dt><dd>{{ d.totals.features }}</dd>
            <dt>DRA-P</dt><dd>{{ d.totals.byGroup.P }}</dd>
            <dt>DRA-R / RH / RM / RL</dt><dd>{{ d.totals.byGroup.R }}</dd>
            <dt>DRA-T</dt><dd>{{ d.totals.byGroup.T }}</dd>
            <dt>DRA-U</dt><dd>{{ d.totals.byGroup.U }}</dd>
            <dt>DRA-I</dt><dd>{{ d.totals.byGroup.I }}</dd>
            <dt>Unknown category</dt><dd>{{ d.totals.byGroup.UNKNOWN }}</dd>
            <dt>Blocked (red)</dt><dd data-testid="diag-blocked">{{ d.totals.blocked }}</dd>
            <dt>U-space / authorized (orange)</dt><dd>{{ d.totals.conditional }}</dd>
            <dt>Routing obstacles</dt><dd>{{ d.totals.obstacles }}</dd>
            <dt>Not applicable now</dt><dd>{{ d.totals.inactive }}</dd>
            <dt>Source</dt><dd>{{ sourceLabel[d.source.sourceType] }}</dd>
            <dt>Last update</dt><dd>{{ d.source.loadedAt | date: 'yyyy-MM-dd HH:mm' : 'UTC' }} UTC</dd>
            <dt>City area covered</dt>
            <dd data-testid="diag-coverage">{{ d.completeness.cityAreaCoveredPct === null ? 'unknown'
              : (d.completeness.cityAreaCoveredPct | number: '1.0-1') + ' %' }} ({{ d.completeness.status }})</dd>
            <dt>Failed requests</dt>
            <dd data-testid="diag-failed">{{ airspace.failedRequests() }} in this session{{
              d.failedRequests.length ? ' · server: ' + d.failedRequests.join('; ') : '' }}</dd>
            @if (d.duplicatesRemoved) {
              <dt>Duplicates removed</dt><dd>{{ d.duplicatesRemoved }}</dd>
            }
          </dl>
          @for (w of d.warnings; track w) {
            <p class="warn-line" data-testid="diag-warning">{{ w }}</p>
          }
          <table class="districts" data-testid="diag-districts">
            <thead><tr><th>District</th><th>Coverage</th><th>Zones</th><th>Status</th></tr></thead>
            <tbody>
              @for (x of d.districts; track x.teryt) {
                <tr [attr.data-district]="x.name" [class]="'st-' + x.status.toLowerCase()" [title]="x.note">
                  <td>{{ x.name }}</td>
                  <td>{{ x.areaCoveredPct | number: '1.0-1' }} %</td>
                  <td>{{ x.zoneCount }}@if (x.obstacleCount) { ({{ x.obstacleCount }} blocking) }</td>
                  <td>{{ x.status }}</td>
                </tr>
              }
            </tbody>
          </table>
          <p class="hint">Zero zones in a covered district is not an error. UNAVAILABLE means the dataset does not
            cover the district: zones there are unknown, not absent. SkyRoute never marks data as verified.</p>
        } @else {
          <p class="hint">Loading diagnostics…</p>
        }
      </div>
    }
  `,
  styleUrl: './airspace-panel.scss',
})
export class AirspacePanelComponent {
  protected readonly airspace = inject(AirspaceService);
  protected readonly groups = CATEGORY_GROUPS;
  protected readonly sourceLabel = SOURCE_LABEL;
  protected readonly statusLabel = STATUS_LABEL;
  protected readonly staleDays = STALE_AFTER_DAYS;

  protected errorText(err: unknown): string {
    return describeHttpError(err, 'request failed');
  }

  /** Same colours as the map: information-only zones are blue. */
  protected dotClass(e: { displayClass: string; isObstacle: boolean }): string {
    return e.displayClass === 'YELLOW' && !e.isObstacle ? 'blue' : e.displayClass.toLowerCase();
  }
}
