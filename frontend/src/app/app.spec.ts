import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { App } from './app';
import { API_BASE_URL } from './core/api';
import { BOUNDARY, COVERAGE, LAYERS, ZONES } from '../testing/fixtures';
import { stubCanvas } from '../testing/canvas-stub';

describe('App', () => {
  beforeAll(() => stubCanvas());

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [App],
      providers: [provideHttpClient(), provideHttpClientTesting()],
    }).compileComponents();
  });

  it('shows one compact demo badge whose popover holds the full disclaimer', () => {
    const fixture = TestBed.createComponent(App);
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    const badge = el.querySelector('[data-testid="demo-badge"]')!;
    expect(badge.textContent).toContain('Demo data');
    expect(badge.getAttribute('popovertarget')).toBe('demo-disclaimer');
    const text = el.querySelector('[data-testid="demo-disclaimer"]')?.textContent ?? '';
    expect(text).toContain('not mean a route is legal or authorized');
    expect(text).toContain('operation category and the airspace');
    expect(text).toContain('PANSA DroneMap and DroneTower');
  });

  it('loads health, layers, zones and the Warsaw boundary once', async () => {
    const fixture = TestBed.createComponent(App);
    fixture.detectChanges();
    const http = TestBed.inject(HttpTestingController);
    http.expectOne(`${API_BASE_URL}/health`).flush({
      status: 'ok',
      version: '0.1.0',
      mapCenter: [52.2297, 21.0122],
      coverageAvailable: true,
      riskDataAvailable: true,
    });
    http.expectOne(`${API_BASE_URL}/layers`).flush(LAYERS);
    http.expectOne(`${API_BASE_URL}/map/warsaw-boundary`).flush(BOUNDARY);
    http.expectOne(`${API_BASE_URL}/map/coverage`).flush(COVERAGE);
    http.expectOne(`${API_BASE_URL}/zones?altitudeM=80`).flush(ZONES);
    await fixture.whenStable();
    http.verify();

    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('[data-testid="backend-status"]')?.textContent).toContain('online');
    expect(el.querySelectorAll('.station-icon.station-depot').length).toBe(1);
    expect(el.querySelector('[data-testid="fleet-empty"]')?.textContent).toContain('No drones yet');
    expect(el.querySelector('[data-testid="add-drone"]')).not.toBeNull();
    expect(el.querySelector('[data-testid="drawer"]')?.hasAttribute('inert')).toBe(true); // closed until a result
    // One Layers panel and one legend, both collapsed by default; no airspace banner over the map.
    expect(el.querySelector('[data-testid="layers-toggle"]')?.getAttribute('aria-expanded')).toBe('false');
    expect(el.querySelector('[data-testid="legend-toggle"]')?.getAttribute('aria-expanded')).toBe('false');
    expect(el.querySelector('.airspace-banner')).toBeNull();
    expect(el.querySelector('[data-testid="show-warsaw"]')).not.toBeNull();
  });
});
