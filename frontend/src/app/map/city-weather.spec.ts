import { TestBed, ComponentFixture } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { API_BASE_URL } from '../core/api';
import { CITY_WEATHER } from '../../testing/fixtures';
import { CityWeatherComponent } from './city-weather';

const URL = `${API_BASE_URL}/city-weather`;

describe('CityWeatherComponent (Open Data Warsaw)', () => {
  let fixture: ComponentFixture<CityWeatherComponent>;
  let http: HttpTestingController;
  let el: HTMLElement;

  beforeEach(() => {
    TestBed.configureTestingModule({ imports: [CityWeatherComponent], providers: [provideHttpClient(), provideHttpClientTesting()] });
    http = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(CityWeatherComponent);
    fixture.detectChanges();
    TestBed.tick();
    el = fixture.nativeElement;
  });

  afterEach(() => http.verify());

  const q = (id: string) => el.querySelector<HTMLElement>(`[data-testid="${id}"]`);
  /** Lets the flushed response reach the resource, then renders. */
  const render = async () => {
    await fixture.whenStable();
    fixture.detectChanges();
  };

  it('shows the live city average, conditions and the Open Data Warsaw source', async () => {
    http.expectOne(URL).flush(CITY_WEATHER);
    await render();
    expect(q('city-weather-temp')!.textContent).toContain('7.1 °C');
    expect(q('city-weather-status')!.textContent).toContain('LIVE');
    expect(q('city-weather-summary')!.textContent).toContain('Humidity 98%');
    expect(q('city-weather-summary')!.textContent).toContain('wind up to 1.9 m/s');
    expect(q('city-weather-summary')!.textContent).toContain('1 station reporting rain');
    expect(q('city-weather-meta')!.textContent).toContain('2 stations · measured 18.10 10:10');
    expect(q('city-weather-refresh')!.textContent).toContain('Updated every 24 h');
    expect(el.textContent).toContain('Open Data Warsaw');
    expect(el.querySelector('a')!.getAttribute('href')).toBe(CITY_WEATHER.datasetUrl);
  });

  it('lists every station when expanded', async () => {
    http.expectOne(URL).flush(CITY_WEATHER);
    await render();
    expect(q('city-weather-stations')).toBeNull();
    q('city-weather-toggle')!.click();
    await render();
    const rows = q('city-weather-stations')!.querySelectorAll('li');
    expect(rows.length).toBe(2);
    expect(rows[0].textContent).toContain('Bielany');
    expect(rows[1].textContent).toContain('8.1 °C');
  });

  it('shows the age of the saved daily snapshot', async () => {
    http.expectOne(URL).flush({ ...CITY_WEATHER, status: 'SAVED', ageS: 3 * 3600 + 25 * 60 });
    await render();
    expect(q('city-weather-status')!.textContent).toContain('SAVED');
    expect(q('city-weather-meta')!.textContent).toContain('saved 3 h 25 min ago');
  });

  it('labels cached data as not live and shows why data is unavailable', async () => {
    http.expectOne(URL).flush({ ...CITY_WEATHER, status: 'CACHED' });
    await render();
    expect(q('city-weather-status')!.textContent).toContain('CACHED');
    expect(q('city-weather-meta')!.textContent).toContain('not live');
  });

  it('shows the backend reason when the open data is unavailable (no invented values)', async () => {
    http.expectOne(URL).flush({ ...CITY_WEATHER, status: 'UNAVAILABLE', summary: null, stations: [],
      message: 'Open Data Warsaw API key is not configured (set SKYROUTE_WARSAW_API_KEY).' });
    await render();
    expect(q('city-weather-temp')).toBeNull();
    expect(q('city-weather-message')!.textContent).toContain('API key is not configured');
  });
});
