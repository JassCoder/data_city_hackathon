import { TestBed, ComponentFixture } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { API_BASE_URL } from '../core/api';
import { LayersService } from '../core/layers';
import { MapDataService } from '../core/map-data';
import { PlannerStore } from '../core/planner.store';
import { GEOCODE_KOPERNIK, settle } from '../../testing/fixtures';
import { LocationInputComponent } from './location-input';

const SEARCH_URL = `${API_BASE_URL}/geocoding/search`;

describe('LocationInputComponent', () => {
  let fixture: ComponentFixture<LocationInputComponent>;
  let http: HttpTestingController;
  let store: PlannerStore;
  let el: HTMLElement;

  beforeEach(async () => {
    TestBed.configureTestingModule({
      imports: [LocationInputComponent],
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    http = TestBed.inject(HttpTestingController);
    store = TestBed.inject(PlannerStore);
    TestBed.inject(LayersService).resource.value();
    TestBed.inject(MapDataService).boundary.value();
    fixture = TestBed.createComponent(LocationInputComponent);
    fixture.componentRef.setInput('role', 'destination');
    fixture.componentRef.setInput('label', 'Point B: Destination address');
    fixture.detectChanges();
    await settle(http, fixture);
    el = fixture.nativeElement;
  });

  afterEach(() => http.verify());

  const q = (sel: string) => el.querySelector<HTMLElement>(`[data-testid="${sel}"]`)!;
  const qa = (sel: string) => Array.from(el.querySelectorAll<HTMLButtonElement>(`[data-testid="${sel}"]`));

  function type(sel: string, text: string) {
    const input = q(sel) as HTMLInputElement;
    input.value = text;
    input.dispatchEvent(new Event('input'));
  }

  function submitSearch(text: string) {
    type('query', text);
    q('search').click();
    fixture.detectChanges();
  }

  it('searches only when Search is pressed', () => {
    type('query', 'Centrum Nauki Kopernik');
    fixture.detectChanges();
    http.expectNone((r) => r.url.startsWith(SEARCH_URL)); // typing alone: no autocomplete
    q('search').click();
    const req = http.expectOne((r) => r.url === SEARCH_URL);
    expect(req.request.params.get('query')).toBe('Centrum Nauki Kopernik');
    req.flush(GEOCODE_KOPERNIK);
  });

  it('lists matches and does not auto-select the first one', () => {
    submitSearch('Kopernik');
    http.expectOne((r) => r.url === SEARCH_URL).flush(GEOCODE_KOPERNIK);
    fixture.detectChanges();
    const results = qa('result');
    expect(results.length).toBe(2);
    expect(store.destination()).toBeNull();
    expect(results[1].disabled).toBe(true); // airport: outside coverage
    expect(results[1].textContent).toContain('Outside the routing area');
    expect(el.textContent).toContain('OpenStreetMap');
  });

  it('selecting a result stores its coordinates and shows them', () => {
    submitSearch('Kopernik');
    http.expectOne((r) => r.url === SEARCH_URL).flush(GEOCODE_KOPERNIK);
    fixture.detectChanges();
    qa('result')[0].click();
    fixture.detectChanges();
    expect(store.destination()).toEqual({
      coordinate: { latitude: 52.24178, longitude: 21.0286 },
      label: 'Centrum Nauki Kopernik, Powiśle, Warszawa',
      source: 'SEARCH',
      accuracy: null,
      flat: null,
    });
    expect(q('selected').textContent).toContain('52.24178, 21.02860');
    expect(qa('result').length).toBe(0);
  });

  it('rejects too-short searches without calling the API', () => {
    submitSearch('ab');
    http.expectNone((r) => r.url.startsWith(SEARCH_URL));
    expect(q('search-error').textContent).toContain('at least 3 characters');
  });

  it('shows provider failures', () => {
    submitSearch('Kopernik');
    http
      .expectOne((r) => r.url === SEARCH_URL)
      .flush({ detail: 'The geocoding service is temporarily unavailable.' }, { status: 503, statusText: 'Unavailable' });
    fixture.detectChanges();
    expect(q('search-error').textContent).toContain('temporarily unavailable');
  });

  it('ignores the response of a superseded search', () => {
    submitSearch('Stadion');
    const first = http.expectOne((r) => r.url === SEARCH_URL);
    submitSearch('Kopernik');
    expect(first.cancelled).toBe(true);
    http.expectOne((r) => r.params.get('query') === 'Kopernik').flush(GEOCODE_KOPERNIK);
    fixture.detectChanges();
    expect(qa('result')[0].textContent).toContain('Kopernik');
  });

  it('offers no manual coordinate entry (address search or map pick only)', () => {
    expect(el.querySelector('[data-testid="manual-toggle"]')).toBeNull();
    expect(el.textContent).not.toContain('Coordinates');
  });

  it('arms map picking for its point', () => {
    q('pick').click();
    fixture.detectChanges();
    expect(store.pickTarget()).toBe('destination');
    expect(q('pick').textContent).toContain('Click the map');
  });

  it('Reset Planner clears the query and result list', async () => {
    submitSearch('Kopernik');
    http.expectOne((r) => r.url === SEARCH_URL).flush(GEOCODE_KOPERNIK);
    fixture.detectChanges();
    store.reset();
    await fixture.whenStable();
    expect(qa('result').length).toBe(0);
    expect((q('query') as HTMLInputElement).value).toBe('');
  });

  it('address text and selection stay unchanged when a routing scenario is selected', async () => {
    submitSearch('Kopernik');
    http.expectOne((r) => r.url === SEARCH_URL).flush(GEOCODE_KOPERNIK);
    fixture.detectChanges();
    qa('result')[0].click();
    fixture.detectChanges();
    const query = (q('query') as HTMLInputElement).value;
    const selected = q('selected').textContent;
    const before = store.destination();
    for (const id of ['BLOOD_DELIVERY', 'AED_DELIVERY', 'AVOID_PROHIBITED_ZONE', 'EMERGENCY'] as const) {
      store.selectScenario(id); // Point A missing: no request, points untouched
      await fixture.whenStable();
      expect((q('query') as HTMLInputElement).value).toBe(query);
      expect(q('selected').textContent).toBe(selected);
      expect(store.destination()).toBe(before);
    }
  });

  // --- building-level geocoding, flats and entrances ---------------------------------------

  const ADDRESS_HIT = {
    query: 'Puławska 2 m. 15, Warszawa', provider: 'gugik-prg+nominatim', attribution: 'GUGiK PRG · OSM', cached: false,
    parsed: { street: 'Puławska', number: '2', flat: '15', city: 'Warszawa', isCoordinates: false },
    note: 'Flat/apartment 15 is kept with the address, but its location was not resolved: the point is the building.',
    results: [
      { displayName: 'ulica Puławska 2, 02-566 Warszawa', latitude: 52.212643, longitude: 21.020657, placeId: 'prg:1',
        category: 'address/prg', source: 'gugik-prg', inCoverage: true, accuracy: 'ADDRESS' as const, houseNumber: '2',
        flat: '15', flatResolved: false },
      { displayName: 'Puławska, Ursynów, Warszawa', latitude: 52.14, longitude: 21.018, placeId: 'nominatim:9',
        category: 'highway/primary', source: 'nominatim', inCoverage: true, accuracy: 'STREET' as const, flat: '15', flatResolved: false },
    ],
  };
  const ENTRANCES_URL = `${API_BASE_URL}/geocoding/entrances`;

  it('shows the accuracy of each result and the building-number note', () => {
    submitSearch('Marszałkowska 100, Warszawa');
    http.expectOne((r) => r.url === SEARCH_URL).flush({
      ...GEOCODE_KOPERNIK, note: 'Building number 100 was not matched; results are street- or place-level approximations.',
      results: [{ ...GEOCODE_KOPERNIK.results[0], displayName: 'Marszałkowska, Warszawa', accuracy: 'STREET' }],
    });
    fixture.detectChanges();
    expect(q('accuracy').textContent).toContain('Street-level approximation');
    expect(q('search-note').textContent).toContain('Building number 100 was not matched');
  });

  it('a building match keeps the flat, labels the accuracy and offers mapped entrances', () => {
    submitSearch('Puławska 2 m. 15, Warszawa');
    http.expectOne((r) => r.url === SEARCH_URL).flush(ADDRESS_HIT);
    fixture.detectChanges();
    // The single building match is selected automatically; no extra click or map pick is needed.
    expect(qa('result').length).toBe(0);
    expect(q('selected-accuracy').textContent).toContain('Building/address matched');
    expect(q('auto-selected').textContent).toContain('Building selected automatically');
    expect(store.destination()).toMatchObject({ coordinate: { latitude: 52.212643, longitude: 21.020657 }, accuracy: 'ADDRESS', flat: '15' });
    expect(q('flat-note').textContent).toContain('apartment location not resolved');
    const req = http.expectOne((r) => r.url === ENTRANCES_URL);
    expect(req.request.params.get('flat')).toBe('15');
    req.flush({
      building: { id: 'osm_way_1', heightM: 18, heightSource: 'levels_x3' }, source: 'OSM',
      note: 'Mapped OpenStreetMap entrances. Not a drone landing site.',
      entrances: [
        { id: 'node/2', latitude: 52.2127, longitude: 21.0209, entrance: 'staircase', ref: 'B', flats: '11-20', housenumber: null,
          street: null, wheelchair: null, matchesFlat: true },
        { id: 'node/1', latitude: 52.2126, longitude: 21.0204, entrance: 'staircase', ref: 'A', flats: '1-10', housenumber: null,
          street: null, wheelchair: null, matchesFlat: false },
      ],
    });
    fixture.detectChanges();
    expect(qa('entrance').length).toBe(2);
    expect(qa('entrance')[0].textContent).toContain('serves flat 15');
    qa('entrance')[0].click();
    fixture.detectChanges();
    expect(store.destination()).toMatchObject({ coordinate: { latitude: 52.2127, longitude: 21.0209 }, source: 'ENTRANCE', flat: '15' });
    expect(store.destination()?.label).toContain('entrance B');
    expect(el.querySelector('[data-testid="entrances"]')).toBeNull();
  });

  it('street-level results do not look up entrances; none mapped means no chooser', () => {
    submitSearch('Puławska 2 m. 15, Warszawa');
    http.expectOne((r) => r.url === SEARCH_URL).flush(ADDRESS_HIT);
    fixture.detectChanges();
    http.expectOne((r) => r.url === ENTRANCES_URL).flush({ building: null, entrances: [], note: 'n', source: null });
    fixture.detectChanges();
    expect(el.querySelector('[data-testid="entrances"]')).toBeNull();
    q('show-alternatives').click(); // the other matches stay available
    fixture.detectChanges();
    expect(qa('accuracy')[0].textContent).toContain('official PRG address point');
    qa('result')[1].click(); // STREET accuracy
    http.expectNone((r) => r.url === ENTRANCES_URL);
    expect(store.destination()?.accuracy).toBe('STREET');
  });

  it('an unregistered number (171B) selects the nearest registered building, labelled as such', () => {
    submitSearch('Al. Solidarności 171B, 00-877 Warszawa');
    http.expectOne((r) => r.url === SEARCH_URL).flush({
      ...ADDRESS_HIT, query: 'Al. Solidarności 171B, 00-877 Warszawa',
      note: 'Building number 171B is not in the official address register (PRG); the registered building 171 on the same street is used instead.',
      results: [
        { ...ADDRESS_HIT.results[0], displayName: 'Aleja „Solidarności” 171, 00-877 Warszawa', latitude: 52.2361, longitude: 20.9789,
          accuracy: 'NEARBY_BUILDING', houseNumber: '171', flat: null, flatResolved: null },
        { ...ADDRESS_HIT.results[1], flat: null, flatResolved: null },
      ],
    });
    fixture.detectChanges();
    expect(store.destination()).toMatchObject({ coordinate: { latitude: 52.2361, longitude: 20.9789 }, accuracy: 'NEARBY_BUILDING' });
    expect(q('selected-accuracy').textContent).toContain('Nearest registered building');
    expect(q('search-note').textContent).toContain('171B is not in the official address register');
    http.expectOne((r) => r.url === ENTRANCES_URL).flush({ building: null, entrances: [], note: 'n', source: null });
  });

  it('matches inside the same building (PRG point + shops at that address) select the PRG building', () => {
    submitSearch('Al. Jerozolimskie 54, Warszawa');
    const hit = ADDRESS_HIT.results[0];
    http.expectOne((r) => r.url === SEARCH_URL).flush({
      ...ADDRESS_HIT, note: null,
      results: [{ ...hit, flat: null }, { ...hit, placeId: 'nominatim:shop', source: 'nominatim', latitude: 52.2130, flat: null }],
    });
    fixture.detectChanges();
    expect(store.destination()?.coordinate).toEqual({ latitude: 52.212643, longitude: 21.020657 });
    http.expectOne((r) => r.url === ENTRANCES_URL).flush({ building: null, entrances: [], note: 'n', source: null });
  });

  it('several building matches are listed, never guessed', () => {
    submitSearch('Lipowa 5, Warszawa');
    const hit = ADDRESS_HIT.results[0];
    http.expectOne((r) => r.url === SEARCH_URL).flush({
      ...ADDRESS_HIT, note: null,
      results: [{ ...hit, placeId: 'prg:a' }, { ...hit, placeId: 'prg:b', latitude: 52.3 }],
    });
    fixture.detectChanges();
    expect(qa('result').length).toBe(2);
    expect(store.destination()).toBeNull();
    http.expectNone((r) => r.url === ENTRANCES_URL);
  });
});
