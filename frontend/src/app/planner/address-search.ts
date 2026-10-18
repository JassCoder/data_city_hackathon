import { Component, inject, input, output, signal } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { Subject, catchError, map, of, switchMap } from 'rxjs';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { describeHttpError } from '../core/api';
import { Coordinate, GeocodeResult } from '../core/models';
import { PlannerApi } from '../core/planner-api';
import { ACCURACY_LABEL, BUILDING_LEVEL, SAME_BUILDING_M, distanceM } from './location-input';

export interface ChosenPlace {
  coordinate: Coordinate;
  label: string;
}

/**
 * Compact address field for the fleet order form. Searches only on submit (Nominatim
 * policy), selects a single building match automatically, otherwise lists the matches.
 */
@Component({
  selector: 'app-address-search',
  imports: [MatButtonModule, MatIconModule],
  template: `
    <div class="field" [attr.data-testid]="testId()">
      <span class="label">{{ label() }}</span>
      @if (value(); as v) {
        <div class="chosen" data-testid="chosen">
          <span class="name">{{ v.label }}</span>
          <button mat-icon-button type="button" (click)="change()" [attr.aria-label]="'Change ' + label()">
            <mat-icon>edit</mat-icon>
          </button>
        </div>
      } @else {
        <form class="row" (submit)="search($event)">
          <input data-testid="query" [placeholder]="placeholder()" [value]="query()" (input)="query.set(text($event))"
                 autocomplete="off" [attr.aria-label]="label()" />
          <button mat-stroked-button type="submit" data-testid="search" [disabled]="searching()">
            {{ searching() ? '…' : 'Search' }}
          </button>
        </form>
        <button mat-button type="button" class="pick" data-testid="pick" [class.active]="picking()" (click)="pickOnMap.emit()">
          <mat-icon>ads_click</mat-icon> {{ picking() ? 'Click the map…' : 'Select on map' }}
        </button>
        @if (error(); as e) { <p class="err" role="alert" data-testid="search-error">{{ e }}</p> }
        @if (results(); as list) {
          @if (list.length === 0) {
            <p class="hint">No matching address in Warsaw.</p>
          }
          @for (r of list; track r.placeId ?? $index) {
            <button type="button" class="result" data-testid="result" [disabled]="!r.inCoverage" (click)="pick(r)">
              <span>{{ r.displayName }}</span>
              @if (r.accuracy) { <small>{{ accuracy[r.accuracy] }}</small> }
              @if (!r.inCoverage) { <small class="out">Outside Warsaw</small> }
            </button>
          }
        }
      }
    </div>
  `,
  styles: `
    .field { display: flex; flex-direction: column; gap: 4px; }
    .label { font-weight: 500; }
    .row { display: flex; gap: 6px; }
    input { flex: 1; min-width: 0; height: 32px; padding: 0 10px; border: 1px solid var(--mat-sys-outline-variant);
      border-radius: 8px; font: inherit; }
    .row button { height: 32px; border-radius: 16px; padding: 0 12px; font-size: 12px; }
    .chosen { display: flex; align-items: center; gap: 4px; padding: 4px 4px 4px 10px; border-radius: 8px;
      background: var(--mat-sys-secondary-container); }
    .chosen .name { flex: 1; font-size: 12px; }
    .result { display: flex; flex-direction: column; align-items: flex-start; text-align: left; padding: 4px 8px;
      border: 1px solid var(--mat-sys-outline-variant); border-radius: 6px; background: #fff; font: inherit;
      font-size: 12px; cursor: pointer; }
    .result small { color: var(--mat-sys-on-surface-variant); }
    .result .out { color: var(--mat-sys-error); }
    .pick { align-self: flex-start; height: 28px; font-size: 12px; padding: 0 8px; }
    .pick.active { background: var(--mat-sys-primary-container); color: var(--mat-sys-on-primary-container); }
    .pick mat-icon { font-size: 18px; width: 18px; height: 18px; }
    .err { margin: 0; font-size: 12px; color: var(--mat-sys-error); }
    .hint { margin: 0; font-size: 12px; color: var(--mat-sys-on-surface-variant); }
  `,
})
export class AddressSearchComponent {
  readonly label = input.required<string>();
  readonly placeholder = input('e.g. Puławska 2, Warszawa');
  readonly testId = input('address');
  readonly value = input<ChosenPlace | null>(null);
  readonly chosen = output<ChosenPlace | null>();
  /** True while this field waits for a map click. */
  readonly picking = input(false);
  readonly pickOnMap = output<void>();

  private readonly api = inject(PlannerApi);
  protected readonly accuracy = ACCURACY_LABEL;
  protected readonly query = signal('');
  protected readonly searching = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly results = signal<GeocodeResult[] | null>(null);
  private readonly searches = new Subject<string>();

  constructor() {
    this.searches
      .pipe(
        switchMap((q) => this.api.searchAddress(q).pipe(
          map((res) => ({ ok: true as const, list: res.results })),
          catchError((e) => of({ ok: false as const, message: describeHttpError(e, 'Address search failed') })),
        )),
        takeUntilDestroyed(),
      )
      .subscribe((out) => {
        this.searching.set(false);
        if (!out.ok) {
          this.error.set(out.message);
          return;
        }
        const buildings = out.list.filter((r) => r.inCoverage && BUILDING_LEVEL.has(r.accuracy));
        const top = buildings[0];
        if (top && buildings.every((r) => distanceM(top, r) <= SAME_BUILDING_M)) {
          this.pick(top); // one building matched: no extra click
        } else {
          this.results.set(out.list);
        }
      });
  }

  protected search(event: Event): void {
    event.preventDefault();
    const q = this.query().trim();
    this.results.set(null);
    if (q.length < 3) {
      this.error.set('Enter at least 3 characters, then press Search.');
      return;
    }
    this.error.set(null);
    this.searching.set(true);
    this.searches.next(q);
  }

  protected pick(r: GeocodeResult): void {
    if (!r.inCoverage) return;
    this.results.set(null);
    this.chosen.emit({ coordinate: { latitude: r.latitude, longitude: r.longitude }, label: r.displayName });
  }

  protected change(): void {
    this.chosen.emit(null);
  }

  protected text(e: Event): string {
    return (e.target as HTMLInputElement).value;
  }
}
