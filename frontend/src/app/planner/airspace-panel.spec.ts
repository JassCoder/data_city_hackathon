import { TestBed, ComponentFixture } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { HarnessLoader } from '@angular/cdk/testing';
import { TestbedHarnessEnvironment } from '@angular/cdk/testing/testbed';
import { API_BASE_URL } from '../core/api';
import { AirspaceService } from '../core/airspace';
import { PlannerStore } from '../core/planner.store';
import { BOUNDARY, COVERAGE, DIAGNOSTICS, LAYERS, PROFILES, SCENARIOS, ZONES } from '../../testing/fixtures';
import { AirspacePanelComponent } from './airspace-panel';

describe('AirspacePanelComponent', () => {
  let fixture: ComponentFixture<AirspacePanelComponent>;
  let http: HttpTestingController;
  let el: HTMLElement;
  let loader: HarnessLoader;

  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [AirspacePanelComponent],
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    http = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(AirspacePanelComponent);
    fixture.detectChanges();
    el = fixture.nativeElement;
    loader = TestbedHarnessEnvironment.loader(fixture);
  });

  async function flushZones(body: object = ZONES, opts?: { status: number; statusText: string }) {
    http.expectOne((r) => r.url.startsWith(`${API_BASE_URL}/zones`)).flush(body, opts);
    // The planner store behind the service also loads layers and profiles.
    for (const r of http.match(`${API_BASE_URL}/layers`)) r.flush(LAYERS);
    for (const r of http.match(`${API_BASE_URL}/drone-profiles`)) r.flush(PROFILES);
    for (const r of http.match(`${API_BASE_URL}/scenarios`)) r.flush(SCENARIOS);
    for (const r of http.match(`${API_BASE_URL}/map/warsaw-boundary`)) r.flush(BOUNDARY);
    for (const r of http.match(`${API_BASE_URL}/map/coverage`)) r.flush(COVERAGE);
    fixture.detectChanges();
    await fixture.whenStable();
  }

  const q = (sel: string) => el.querySelector(`[data-testid="${sel}"]`);

  it('shows the data source and verification label', async () => {
    await flushZones();
    const src = q('airspace-source')!.textContent!;
    expect(src).toContain('No airspace data loaded');
    expect(src).toContain('version v1');
    expect(src).toContain('Unknown airspace is not unrestricted airspace.');
  });

  it('lists zones with their evaluation for the planned flight', async () => {
    await flushZones();
    const list = q('zone-list')!.textContent!;
    expect(list).toContain('DRA-P · Blocked');
    expect(list).toContain('Unavailable for this route: authorization required');
    expect(list).toContain('Not applicable at the selected altitude');
    expect(el.querySelectorAll('.dot-red.obstacle').length).toBe(2); // prohibited + restricted
  });

  it('zone list follows the DRA category filters set in the Layers panel (display only)', async () => {
    await flushZones();
    const service = TestBed.inject(AirspaceService);
    service.toggleFilter('P', false);
    fixture.detectChanges();
    expect(service.visibleZones().some((z) => z.draCategory === 'DRA-P')).toBe(false);
    expect(service.zones().length).toBe(ZONES.zones.length); // routing data untouched
    expect(q('zone-list')!.textContent).not.toContain('Sejm');
    expect(el.querySelector('[data-testid="zone-filters"]')).toBeNull(); // the checkboxes live in Layers now
  });

  it('shows airspace loading errors', async () => {
    await flushZones({ detail: 'Airspace file not found' }, { status: 500, statusText: 'Server Error' });
    expect(q('airspace-error')!.textContent).toContain('Airspace file not found');
  });

  it('re-evaluates zones when the planned altitude changes', async () => {
    await flushZones();
    TestBed.inject(PlannerStore).setAltitude(40);
    fixture.detectChanges();
    http.expectOne(`${API_BASE_URL}/zones?altitudeM=40`).flush(ZONES);
  });

  it('reports partial airspace coverage prominently', async () => {
    await flushZones();
    const c = q('airspace-completeness')!;
    expect(c.classList.contains('warn')).toBe(true);
    expect(c.textContent).toContain('PARTIAL AIRSPACE DATA');
  });

  it('shows a loading indicator while zones are re-evaluated', async () => {
    await flushZones();
    expect(q('airspace-loading')).toBeNull();
    TestBed.inject(PlannerStore).setAltitude(100);
    fixture.detectChanges();
    expect(q('airspace-loading')).not.toBeNull();
    expect(q('zone-list')).not.toBeNull(); // the previous zones stay visible meanwhile
    http.expectOne(`${API_BASE_URL}/zones?altitudeM=100`).flush(ZONES);
    fixture.detectChanges();
    await fixture.whenStable();
    expect(q('airspace-loading')).toBeNull();
  });

  it('shows data freshness and flags old source data', async () => {
    await flushZones({ ...ZONES, source: { ...ZONES.source, sourceTimestamp: new Date().toISOString() } });
    expect(q('airspace-freshness')!.textContent).toContain('0 days old');
    expect(q('airspace-freshness')!.classList.contains('stale')).toBe(false);
    TestBed.inject(PlannerStore).setAltitude(100);
    fixture.detectChanges();
    http.expectOne(`${API_BASE_URL}/zones?altitudeM=100`).flush({ ...ZONES, source: { ...ZONES.source, sourceTimestamp: '2020-01-01T00:00:00Z' } });
    fixture.detectChanges();
    await fixture.whenStable();
    expect(q('airspace-freshness')!.classList.contains('stale')).toBe(true);
    expect(q('airspace-freshness')!.textContent).toContain('may be outdated');
  });

  it('coverage diagnostics load on demand and list every district', async () => {
    await flushZones();
    http.expectNone((r) => r.url.includes('/zones/diagnostics'));
    (q('diagnostics-toggle') as HTMLButtonElement).click();
    fixture.detectChanges();
    http.expectOne(`${API_BASE_URL}/zones/diagnostics?altitudeM=80`).flush(DIAGNOSTICS);
    fixture.detectChanges();
    await fixture.whenStable();
    expect(q('diag-blocked')!.textContent).toBe('2');
    expect(q('diag-coverage')!.textContent).toContain('3.3 %');
    const ursynow = el.querySelector('[data-district="Ursynów"]')!;
    expect(ursynow.textContent).toContain('UNAVAILABLE');
    expect(ursynow.classList.contains('st-unavailable')).toBe(true);
    expect(q('diag-warning')!.textContent).toContain('not covered');
  });

  it('counts failed zone requests in the diagnostics', async () => {
    await flushZones({ detail: 'down' }, { status: 503, statusText: 'Unavailable' });
    expect(TestBed.inject(AirspaceService).failedRequests()).toBe(1);
  });

  it('focuses a zone on the map when clicked', async () => {
    await flushZones();
    el.querySelector<HTMLButtonElement>('[data-zone-id="-RM-PKIN"]')!.click();
    expect(TestBed.inject(AirspaceService).focusZoneId()).toBe('-RM-PKIN');
  });
});
