import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Subject, catchError, map, of, switchMap } from 'rxjs';
import { describeHttpError } from '../core/api';
import { FleetStore } from '../core/fleet.store';
import { GeocodeResult, PointRole, SelectedLocation } from '../core/models';
import { PlaceSuggestions, Suggestion, parseCoordinates } from '../core/place-suggestions';
import { PlannerApi } from '../core/planner-api';
import { IconComponent } from '../ui/icon';

type Option =
  | { kind: 'local'; s: Suggestion }
  | { kind: 'search'; query: string }
  | { kind: 'address'; r: GeocodeResult };

type SearchOutcome = { ok: true; results: GeocodeResult[]; attribution: string } | { ok: false; message: string };

const KIND_LABEL: Record<Suggestion['kind'], string> = {
  coordinates: 'Coordinates',
  recent: 'Recent',
  station: 'Station',
  district: 'District',
};

let fieldSeq = 0;

/**
 * One point (A or B) of a drone: address search, local suggestions, typed coordinates
 * and map picking. Only points inside the Warsaw polygon are accepted (FleetStore).
 */
@Component({
  selector: 'app-point-field',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent],
  template: `
    <div class="pf" [attr.data-testid]="'point-' + role()">
      <span class="pin" [style.background]="color()" aria-hidden="true">{{ letter() }}</span>
      <div class="combo">
        <label class="visually-hidden" [for]="inputId">Point {{ letter() }}, {{ roleLabel() }}</label>
        <input
          [id]="inputId"
          class="input"
          role="combobox"
          aria-autocomplete="list"
          autocomplete="off"
          spellcheck="false"
          [attr.aria-expanded]="listOpen()"
          [attr.aria-controls]="listId"
          [attr.aria-activedescendant]="active() >= 0 ? listId + '-' + active() : null"
          [attr.aria-invalid]="!!error()"
          [attr.aria-describedby]="error() ? errorId : null"
          [placeholder]="'Address, station or 52.23, 21.01…'"
          [value]="query()"
          (input)="onInput($event)"
          (keydown)="onKey($event)"
          (focus)="focused.set(true)"
          (blur)="focused.set(false)"
          data-testid="point-input"
        />
        @if (value(); as v) {
          <button type="button" class="clear" (click)="clear()" [attr.aria-label]="'Clear point ' + letter()">
            <app-icon name="close" />
          </button>
        }
        @if (listOpen()) {
          <ul class="list" role="listbox" [id]="listId" [attr.aria-label]="'Suggestions for point ' + letter()">
            @for (o of options(); track $index; let i = $index) {
              @switch (o.kind) {
                @case ('local') {
                  <li role="option" [id]="listId + '-' + i" [attr.aria-selected]="i === active()" [class.active]="i === active()"
                      (mousedown)="$event.preventDefault(); choose(o)" data-testid="suggestion">
                    <span class="name">{{ o.s.label }}</span>
                    <span class="meta">{{ kindLabel[o.s.kind] }} · {{ o.s.detail }}</span>
                  </li>
                }
                @case ('search') {
                  <li role="option" class="search" [id]="listId + '-' + i" [attr.aria-selected]="i === active()"
                      [class.active]="i === active()" (mousedown)="$event.preventDefault(); choose(o)"
                      data-testid="search-option">
                    <app-icon name="pin" /><span class="name">Search addresses for “{{ o.query }}”</span>
                  </li>
                }
                @case ('address') {
                  <li role="option" [id]="listId + '-' + i" [attr.aria-selected]="i === active()"
                      [attr.aria-disabled]="!o.r.inCoverage" [class.active]="i === active()" [class.disabled]="!o.r.inCoverage"
                      (mousedown)="$event.preventDefault(); choose(o)" data-testid="address-result">
                    <span class="name">{{ o.r.displayName }}</span>
                    <span class="meta">{{ o.r.inCoverage ? 'Address' : 'Outside Warsaw, cannot be used' }}</span>
                  </li>
                }
              }
            }
            @if (searching()) {
              <li class="note" role="presentation"><span class="spinner"></span> Searching addresses…</li>
            }
            @if (results()?.length === 0 && !searching()) {
              <li class="note" role="presentation">No matching places in Warsaw. Try a fuller address, pick on the map or type coordinates.</li>
            }
            @if (attribution() && results()?.length) {
              <li class="note attribution" role="presentation">{{ attribution() }}</li>
            }
          </ul>
        }
      </div>
      <button type="button" class="icon-btn" [attr.aria-pressed]="picking()" (click)="togglePick()"
              [attr.aria-label]="'Pick point ' + letter() + ' on the map'" [title]="'Pick point ' + letter() + ' on the map'"
              data-testid="pick">
        <app-icon name="crosshair" />
      </button>
    </div>
    @if (value(); as v) {
      <p class="selected num" data-testid="point-coords">{{ v.coordinate.latitude.toFixed(5) }}, {{ v.coordinate.longitude.toFixed(5) }}</p>
    }
    <p class="field-error" [id]="errorId" role="alert" aria-live="polite">{{ error() ?? '' }}</p>
  `,
  styles: `
    :host {
      display: block;
    }
    .pf {
      display: flex;
      align-items: center;
      gap: var(--sp-2);
    }
    .pin {
      display: grid;
      place-items: center;
      flex: none;
      width: 22px;
      height: 22px;
      border-radius: 50%;
      color: #fff;
      font-size: var(--fs-12);
      font-weight: var(--fw-bold);
    }
    .combo {
      position: relative;
      flex: 1;
      min-width: 0;
    }
    .combo .input {
      padding-right: 28px;
      text-overflow: ellipsis;
    }
    .clear {
      position: absolute;
      right: 2px;
      top: 50%;
      transform: translateY(-50%);
      display: grid;
      place-items: center;
      width: 26px;
      height: 26px;
      border: 0;
      border-radius: var(--radius-s);
      background: transparent;
      color: var(--c-muted);
    }
    .clear:hover {
      color: var(--c-text);
    }
    .list {
      position: absolute;
      z-index: 20;
      top: calc(100% + 4px);
      left: 0;
      right: 0;
      max-height: 280px;
      overflow-y: auto;
      overscroll-behavior: contain;
      margin: 0;
      padding: var(--sp-1);
      list-style: none;
      border: 1px solid var(--c-line);
      border-radius: var(--radius-m);
      background: var(--c-surface);
      box-shadow: var(--shadow-float);
    }
    li[role='option'] {
      display: grid;
      gap: 1px;
      padding: var(--sp-1) var(--sp-2);
      border-radius: var(--radius-s);
      cursor: pointer;
    }
    li.active,
    li[role='option']:hover {
      background: var(--c-accent-soft);
    }
    li.search {
      display: flex;
      align-items: center;
      gap: var(--sp-2);
      color: var(--c-accent);
      font-weight: var(--fw-medium);
    }
    li.disabled {
      cursor: not-allowed;
      opacity: 0.55;
    }
    .name {
      overflow: hidden;
      font-size: var(--fs-13);
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .meta,
    .note {
      font-size: var(--fs-11);
      color: var(--c-muted);
    }
    .note {
      padding: var(--sp-1) var(--sp-2);
    }
    .selected {
      margin: 2px 0 0 30px;
      font-size: var(--fs-11);
      color: var(--c-muted);
    }
    .field-error {
      margin-left: 30px;
    }
    .field-error:empty {
      display: none;
    }
  `,
})
export class PointFieldComponent {
  readonly droneId = input.required<string>();
  readonly role = input.required<PointRole>();
  readonly color = input('#1e2a33');

  private readonly fleet = inject(FleetStore);
  private readonly api = inject(PlannerApi);
  private readonly places = inject(PlaceSuggestions);

  protected readonly inputId = `pf-${++fieldSeq}`;
  protected readonly listId = `${this.inputId}-list`;
  protected readonly errorId = `${this.inputId}-error`;
  protected readonly kindLabel = KIND_LABEL;

  protected readonly letter = computed(() => (this.role() === 'start' ? 'A' : 'B'));
  protected readonly roleLabel = computed(() => (this.role() === 'start' ? 'start' : 'destination'));
  protected readonly drone = computed(() => this.fleet.drones().find((d) => d.id === this.droneId()));
  protected readonly value = computed(() => this.drone()?.[this.role()] ?? null);
  protected readonly picking = computed(() => {
    const t = this.fleet.pickTarget();
    return t?.droneId === this.droneId() && t.role === this.role();
  });

  protected readonly query = signal('');
  protected readonly focused = signal(false);
  protected readonly active = signal(-1);
  protected readonly searching = signal(false);
  protected readonly searchError = signal<string | null>(null);
  protected readonly results = signal<GeocodeResult[] | null>(null);
  protected readonly attribution = signal<string | null>(null);
  /** The query differs from the selected label: the user is typing. */
  private readonly typing = signal(false);

  protected readonly error = computed(() => this.searchError() ?? this.drone()?.notices[this.role()] ?? null);

  protected readonly options = computed<Option[]>(() => {
    if (!this.typing()) return [];
    const q = this.query().trim();
    const out: Option[] = this.places.suggest(q).map((s) => ({ kind: 'local' as const, s }));
    if (q.length >= 3 && !parseCoordinates(q)) out.push({ kind: 'search', query: q });
    for (const r of this.results() ?? []) out.push({ kind: 'address', r });
    return out;
  });
  protected readonly listOpen = computed(
    () => this.focused() && (this.options().length > 0 || this.searching() || this.results() !== null),
  );

  private readonly searches = new Subject<string>();

  constructor() {
    // The field shows the selected place; a map click or drag updates it.
    effect(() => {
      const v = this.value();
      untracked(() => {
        this.query.set(v?.label ?? '');
        this.typing.set(false);
        this.results.set(null);
      });
    });
    // Explicit searches only; switchMap drops superseded ones.
    this.searches
      .pipe(
        switchMap((q) =>
          this.api.searchAddress(q).pipe(
            map((res): SearchOutcome => ({ ok: true, results: res.results, attribution: res.attribution })),
            catchError((err) => of<SearchOutcome>({ ok: false, message: describeHttpError(err, 'Address search failed') })),
          ),
        ),
        takeUntilDestroyed(),
      )
      .subscribe((outcome) => {
        this.searching.set(false);
        if (outcome.ok) {
          this.results.set(outcome.results);
          this.attribution.set(outcome.attribution);
          const first = this.options().findIndex((o) => o.kind === 'address');
          this.active.set(first);
        } else {
          this.searchError.set(outcome.message);
        }
      });
  }

  protected onInput(event: Event): void {
    this.query.set((event.target as HTMLInputElement).value);
    this.typing.set(true);
    this.results.set(null);
    this.searchError.set(null);
    this.active.set(-1);
  }

  protected onKey(event: KeyboardEvent): void {
    const n = this.options().length;
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        this.typing.set(true);
        if (n) this.active.set((this.active() + 1) % n);
        break;
      case 'ArrowUp':
        event.preventDefault();
        if (n) this.active.set(this.active() <= 0 ? n - 1 : this.active() - 1);
        break;
      case 'Enter': {
        event.preventDefault();
        const o = this.options()[this.active()];
        if (o) this.choose(o);
        else this.search();
        break;
      }
      case 'Escape':
        if (this.listOpen()) {
          event.stopPropagation();
          this.typing.set(false);
          this.results.set(null);
          this.query.set(this.value()?.label ?? '');
        }
        break;
    }
  }

  protected choose(o: Option): void {
    switch (o.kind) {
      case 'local':
        this.select({
          coordinate: o.s.coordinate,
          label: o.s.kind === 'coordinates' ? `Coordinates ${o.s.label}` : o.s.label,
          source: o.s.kind === 'coordinates' ? 'MANUAL' : 'SUGGESTION',
        });
        break;
      case 'search':
        this.search();
        break;
      case 'address':
        if (o.r.inCoverage) {
          this.select({ coordinate: { latitude: o.r.latitude, longitude: o.r.longitude }, label: o.r.displayName, source: 'SEARCH' });
        }
        break;
    }
  }

  /** Explicit address search (Enter or the "Search addresses" option). */
  protected search(): void {
    const q = this.query().trim();
    const coord = parseCoordinates(q);
    if (coord) {
      this.select({ coordinate: coord, label: `Coordinates ${coord.latitude.toFixed(5)}, ${coord.longitude.toFixed(5)}`, source: 'MANUAL' });
      return;
    }
    if (q.length < 3) {
      this.searchError.set('Type at least 3 characters, then press Enter to search addresses.');
      return;
    }
    this.searchError.set(null);
    this.searching.set(true);
    this.results.set(null);
    this.searches.next(q);
  }

  private select(loc: SelectedLocation): void {
    if (this.fleet.setLocation(this.droneId(), this.role(), loc)) {
      this.places.remember(loc);
      this.typing.set(false);
      this.results.set(null);
      this.query.set(loc.label);
    }
  }

  protected clear(): void {
    this.fleet.setLocation(this.droneId(), this.role(), null);
    this.query.set('');
    this.searchError.set(null);
  }

  protected togglePick(): void {
    this.fleet.pick(this.droneId(), this.role());
  }
}
