import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { App } from './app';
import { API_BASE_URL } from './core/api';
import { DEMO_WEATHER, LAYERS, PROFILES, ZONES } from '../testing/fixtures';
import { stubCanvas } from '../testing/canvas-stub';

describe('App', () => {
  beforeAll(() => stubCanvas());

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [App],
      providers: [provideHttpClient(), provideHttpClientTesting()],
    }).compileComponents();
  });

  it('shows the DEMO DATA label', () => {
    const fixture = TestBed.createComponent(App);
    fixture.detectChanges();
    expect((fixture.nativeElement as HTMLElement).textContent).toContain('DEMO DATA');
  });

  it('loads health, layers, profiles and weather once and renders the summary', async () => {
    const fixture = TestBed.createComponent(App);
    fixture.detectChanges();
    const http = TestBed.inject(HttpTestingController);
    http.expectOne(`${API_BASE_URL}/health`).flush({
      status: 'ok',
      version: '0.1.0',
      mapCenter: [52.2297, 21.0122],
      demoBbox: LAYERS.bbox,
    });
    http.expectOne(`${API_BASE_URL}/layers`).flush(LAYERS);
    http.expectOne(`${API_BASE_URL}/drone-profiles`).flush(PROFILES);
    http.expectOne(`${API_BASE_URL}/weather?mode=DEMO`).flush(DEMO_WEATHER);
    http.expectOne(`${API_BASE_URL}/zones?altitudeM=80`).flush(ZONES);
    await fixture.whenStable();
    http.verify();

    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('[data-testid="backend-status"]')?.textContent).toContain('online');
    const summary = el.querySelector('[data-testid="layer-summary"]')?.textContent ?? '';
    expect(summary).toContain('Buildings (OSM)');
    expect(el.querySelectorAll('.station-icon.station-depot').length).toBe(1);
    expect(el.querySelector('[data-testid="route-idle"]')).not.toBeNull();
    expect(el.querySelector('[data-testid="location-start"]')).not.toBeNull();
    expect(el.querySelector('[data-testid="airspace-source"]')?.textContent).toContain('DEMO');
    expect(el.querySelector('.airspace-banner')?.textContent).toContain('not official');
  });
});
