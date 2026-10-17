import { Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatTooltipModule } from '@angular/material/tooltip';
import { Subject, catchError, map, of, switchMap } from 'rxjs';
import { describeHttpError } from '../core/api';
import { GeocodeResult, GeocodingResponse, PointRole } from '../core/models';
import { PlannerApi } from '../core/planner-api';
import { PlannerStore } from '../core/planner.store';

type SearchOutcome = { ok: true; res: GeocodingResponse } | { ok: false; message: string };

@Component({
  selector: 'app-location-input',
  imports: [
    MatButtonModule,
    MatFormFieldModule,
    MatIconModule,
    MatInputModule,
    MatProgressSpinnerModule,
    MatTooltipModule,
  ],
  templateUrl: './location-input.html',
  styleUrl: './location-input.scss',
})
export class LocationInputComponent {
  readonly role = input.required<PointRole>();
  readonly label = input.required<string>();
  readonly placeholder = input('');

  protected readonly store = inject(PlannerStore);
  private readonly api = inject(PlannerApi);

  protected readonly query = signal('');
  protected readonly searching = signal(false);
  protected readonly searchError = signal<string | null>(null);
  protected readonly results = signal<GeocodeResult[] | null>(null);
  protected readonly attribution = signal<string | null>(null);

  protected readonly manualOpen = signal(false);
  protected readonly manualLat = signal('');
  protected readonly manualLon = signal('');
  protected readonly manualError = signal<string | null>(null);

  protected readonly selected = computed(() =>
    this.role() === 'start' ? this.store.start() : this.store.destination(),
  );
  protected readonly notice = computed(() => this.store.notices()[this.role()]);
  protected readonly picking = computed(() => this.store.pickTarget() === this.role());
  protected readonly letter = computed(() => (this.role() === 'start' ? 'A' : 'B'));

  private readonly searches = new Subject<string>();

  constructor() {
    // Reset Planner also clears this input's local search state.
    effect(() => {
      if (this.store.resetCount() === 0) return;
      untracked(() => {
        this.query.set('');
        this.results.set(null);
        this.searchError.set(null);
        this.searching.set(false);
        this.manualOpen.set(false);
        this.manualError.set(null);
      });
    });
    // switchMap drops responses of superseded searches.
    this.searches
      .pipe(
        switchMap((q) =>
          this.api.searchAddress(q).pipe(
            map((res): SearchOutcome => ({ ok: true, res })),
            catchError((err) =>
              of<SearchOutcome>({ ok: false, message: describeHttpError(err, 'Address search failed') }),
            ),
          ),
        ),
        takeUntilDestroyed(),
      )
      .subscribe((outcome) => {
        this.searching.set(false);
        if (outcome.ok) {
          this.results.set(outcome.res.results);
          this.attribution.set(outcome.res.attribution);
        } else {
          this.searchError.set(outcome.message);
        }
      });
  }

  protected search(event?: Event): void {
    event?.preventDefault();
    const q = this.query().trim();
    this.results.set(null);
    if (q.length < 3) {
      this.searchError.set('Enter at least 3 characters, then press Search.');
      return;
    }
    this.searchError.set(null);
    this.searching.set(true);
    this.searches.next(q);
  }

  protected select(result: GeocodeResult): void {
    if (!result.inCoverage) return;
    const ok = this.store.setLocation(this.role(), {
      coordinate: { latitude: result.latitude, longitude: result.longitude },
      label: result.displayName,
      source: 'SEARCH',
    });
    if (ok) this.results.set(null);
  }

  protected togglePick(): void {
    this.store.pickTarget.set(this.picking() ? null : this.role());
  }

  protected applyManual(event?: Event): void {
    event?.preventDefault();
    const lat = Number(this.manualLat().trim().replace(',', '.'));
    const lon = Number(this.manualLon().trim().replace(',', '.'));
    if (!this.manualLat().trim() || !this.manualLon().trim() || !Number.isFinite(lat) || !Number.isFinite(lon)) {
      this.manualError.set('Enter numeric latitude and longitude, e.g. 52.2297 and 21.0122.');
      return;
    }
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180) {
      this.manualError.set('Latitude must be −90…90 and longitude −180…180.');
      return;
    }
    this.manualError.set(null);
    const ok = this.store.setLocation(this.role(), {
      coordinate: { latitude: lat, longitude: lon },
      label: `Coordinates ${lat.toFixed(5)}, ${lon.toFixed(5)}`,
      source: 'MANUAL',
    });
    if (ok) this.manualOpen.set(false);
  }

  protected clear(): void {
    this.store.setLocation(this.role(), null);
  }

  protected value(event: Event): string {
    return (event.target as HTMLInputElement).value;
  }
}
