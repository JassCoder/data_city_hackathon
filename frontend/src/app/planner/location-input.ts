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
import { Entrance, GeocodeAccuracy, GeocodeResult, GeocodingResponse, PointRole, SelectedLocation } from '../core/models';

/** Accuracy levels shown to the user. */
export const ACCURACY_LABEL: Record<GeocodeAccuracy, string> = {
  ADDRESS: 'Building/address matched',
  NEARBY_BUILDING: 'Nearest registered building (exact number not in register)',
  STREET: 'Street-level approximation',
  PLACE: 'Place-level approximation',
  COORDINATES: 'Coordinates as entered',
};
export const BUILDING_LEVEL: ReadonlySet<GeocodeAccuracy | null | undefined> = new Set(['ADDRESS', 'NEARBY_BUILDING']);
/** Building-level matches this close to the best one are the same building (e.g. shops inside a station). */
export const SAME_BUILDING_M = 75;

export function distanceM(a: GeocodeResult, b: GeocodeResult): number {
  const dy = (a.latitude - b.latitude) * 111_320;
  const dx = (a.longitude - b.longitude) * 111_320 * Math.cos((a.latitude * Math.PI) / 180);
  return Math.hypot(dx, dy);
}
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
  /** e.g. "building number not matched" / "flat not resolved" (from the backend). */
  protected readonly searchNote = signal<string | null>(null);
  /** Matches of the last search after one building was selected automatically (re-shown on request). */
  protected readonly alternatives = signal<GeocodeResult[] | null>(null);
  protected readonly entranceChoice = computed(() => {
    const c = this.store.entranceChoice();
    return c && c.role === this.role() ? c : null;
  });
  protected readonly accuracyLabel = ACCURACY_LABEL;

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
        this.alternatives.set(null);
        this.searchError.set(null);
        this.searching.set(false);
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
          this.searchNote.set(outcome.res.note ?? null);
          // One building in Warsaw matched (results from both providers and POIs inside it count once):
          // select it at once; the other matches stay one click away. Different buildings are never guessed.
          const buildings = outcome.res.results.filter((r) => r.inCoverage && BUILDING_LEVEL.has(r.accuracy));
          const top = buildings[0];
          if (top && buildings.every((r) => distanceM(top, r) <= SAME_BUILDING_M) && this.select(top)) {
            this.alternatives.set(outcome.res.results.length > 1 ? outcome.res.results : null);
          }
        } else {
          this.searchError.set(outcome.message);
        }
      });
  }

  protected search(event?: Event): void {
    event?.preventDefault();
    const q = this.query().trim();
    this.results.set(null);
    this.alternatives.set(null);
    this.searchNote.set(null);
    if (q.length < 3) {
      this.searchError.set('Enter at least 3 characters, then press Search.');
      return;
    }
    this.searchError.set(null);
    this.searching.set(true);
    this.searches.next(q);
  }

  protected showAlternatives(): void {
    this.results.set(this.alternatives());
    this.alternatives.set(null);
  }

  protected select(result: GeocodeResult): boolean {
    if (!result.inCoverage) return false;
    const location: SelectedLocation = {
      coordinate: { latitude: result.latitude, longitude: result.longitude },
      label: result.flat ? `${result.displayName} (flat ${result.flat})` : result.displayName,
      source: 'SEARCH',
      accuracy: result.accuracy ?? null,
      flat: result.flat ?? null,
    };
    const ok = this.store.setLocation(this.role(), location);
    if (!ok) return false;
    this.results.set(null);
    this.alternatives.set(null);
    // Building-level results: offer the building's mapped entrances, if any (never invented).
    if (BUILDING_LEVEL.has(result.accuracy)) {
      const role = this.role();
      this.api.entrances(result.latitude, result.longitude, result.flat).subscribe({
        next: (res) => {
          const still = role === 'start' ? this.store.start() : this.store.destination();
          if (still === location) this.store.offerEntrances(role, location, res.entrances, res.note);
        },
        error: () => undefined, // entrances are optional; the building point stays selected
      });
    }
    return true;
  }

  protected chooseEntrance(e: Entrance): void {
    this.store.chooseEntrance(e);
  }

  protected entranceName(e: Entrance): string {
    const kind = e.entrance && e.entrance !== 'yes' ? e.entrance : 'entrance';
    return e.ref ? `${e.ref} (${kind})` : kind;
  }

  protected togglePick(): void {
    this.store.pickTarget.set(this.picking() ? null : this.role());
  }

  protected clear(): void {
    this.store.setLocation(this.role(), null);
  }

  protected value(event: Event): string {
    return (event.target as HTMLInputElement).value;
  }
}
