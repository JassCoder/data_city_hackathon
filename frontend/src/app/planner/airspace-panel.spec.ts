import { TestBed, ComponentFixture } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { HarnessLoader } from '@angular/cdk/testing';
import { TestbedHarnessEnvironment } from '@angular/cdk/testing/testbed';
import { MatCheckboxHarness } from '@angular/material/checkbox/testing';
import { API_BASE_URL } from '../core/api';
import { AirspaceService } from '../core/airspace';
import { PlannerStore } from '../core/planner.store';
import { BOUNDARY, COVERAGE, LAYERS, PROFILES, SCENARIOS, ZONES } from '../../testing/fixtures';
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
    expect(src).toContain('DEMO: synthetic, not official');
    expect(src).toContain('version v1');
    expect(src).toContain('NOT official PAŻP');
  });

  it('lists zones with their evaluation for the planned flight', async () => {
    await flushZones();
    const list = q('zone-list')!.textContent!;
    expect(list).toContain('DRA-P · Blocked');
    expect(list).toContain('Unavailable for this route: authorization required');
    expect(list).toContain('Not applicable at the selected altitude');
    expect(el.querySelectorAll('.dot-red.obstacle').length).toBe(1);
  });

  it('filters zones by DRA category (display only)', async () => {
    await flushZones();
    const service = TestBed.inject(AirspaceService);
    const p = await loader.getHarness(MatCheckboxHarness.with({ label: /DRA-P prohibited/ }));
    expect(await p.getLabelText()).toContain('(1)');
    await p.uncheck();
    expect(service.visibleZones().some((z) => z.draCategory === 'DRA-P')).toBe(false);
    expect(service.zones().length).toBe(ZONES.zones.length); // routing data untouched
    expect(q('zone-list')!.textContent).not.toContain('Sejm');
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

  it('focuses a zone on the map when clicked', async () => {
    await flushZones();
    el.querySelector<HTMLButtonElement>('[data-zone-id="DEMO-RM-PKIN"]')!.click();
    expect(TestBed.inject(AirspaceService).focusZoneId()).toBe('DEMO-RM-PKIN');
  });
});
