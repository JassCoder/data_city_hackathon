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

  it('accepts manual coordinates and validates them', () => {
    q('manual-toggle').click();
    fixture.detectChanges();
    type('lat', 'abc');
    type('lon', '21.03');
    q('manual-set').click();
    fixture.detectChanges();
    expect(el.textContent).toContain('Enter numeric latitude and longitude');
    expect(store.destination()).toBeNull();

    type('lat', '52,2398'); // comma decimal accepted
    q('manual-set').click();
    fixture.detectChanges();
    expect(store.destination()?.coordinate).toEqual({ latitude: 52.2398, longitude: 21.03 });
    expect(store.destination()?.source).toBe('MANUAL');
  });

  it('shows a coverage message for manual points outside the routing area', () => {
    q('manual-toggle').click();
    fixture.detectChanges();
    type('lat', '52.05');
    type('lon', '21.0');
    q('manual-set').click();
    fixture.detectChanges();
    expect(q('notice').textContent).toContain('not inside the official City of Warsaw boundary');
    expect(store.destination()).toBeNull();
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
});
