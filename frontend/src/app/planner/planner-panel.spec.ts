import { TestBed, ComponentFixture } from '@angular/core/testing';
import { HttpInterceptorFn, HttpResponse, provideHttpClient, withInterceptors } from '@angular/common/http';
import { of } from 'rxjs';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { HarnessLoader } from '@angular/cdk/testing';
import { TestbedHarnessEnvironment } from '@angular/cdk/testing/testbed';
import { MatButtonToggleHarness } from '@angular/material/button-toggle/testing';
import { MatSelectHarness } from '@angular/material/select/testing';
import { MatSliderHarness } from '@angular/material/slider/testing';
import { API_BASE_URL } from '../core/api';
import { LayersService } from '../core/layers';
import { PlannerStore } from '../core/planner.store';
import { CENTRALNA, DEMO_WEATHER, KOPERNIK, routeResponse, settle } from '../../testing/fixtures';
import { PlannerPanelComponent } from './planner-panel';

const ROUTE_URL = `${API_BASE_URL}/routes/calculate`;

/** The weather readout refetches whenever the altitude changes: answer it at once. */
const weatherStub: HttpInterceptorFn = (req, next) =>
  req.url.startsWith(`${API_BASE_URL}/weather`)
    ? of(new HttpResponse({ status: 200, body: req.urlWithParams.includes('mode=LIVE') ? LIVE_FALLBACK : DEMO_WEATHER }))
    : next(req);
const LIVE_FALLBACK = {
  ...DEMO_WEATHER,
  mode: 'LIVE',
  source: 'DEMO_FALLBACK',
  liveAvailable: false,
  message: 'Live weather is not available (ConnectError). Using DEMO wind instead.',
};

describe('PlannerPanelComponent', () => {
  let fixture: ComponentFixture<PlannerPanelComponent>;
  let http: HttpTestingController;
  let store: PlannerStore;
  let loader: HarnessLoader;
  let el: HTMLElement;

  beforeEach(async () => {
    TestBed.configureTestingModule({
      imports: [PlannerPanelComponent],
      providers: [provideHttpClient(withInterceptors([weatherStub])), provideHttpClientTesting()],
    });
    http = TestBed.inject(HttpTestingController);
    store = TestBed.inject(PlannerStore);
    TestBed.inject(LayersService).resource.value();
    fixture = TestBed.createComponent(PlannerPanelComponent);
    fixture.detectChanges();
    await settle(http, fixture);
    loader = TestbedHarnessEnvironment.loader(fixture);
    el = fixture.nativeElement;
  });

  afterEach(() => http.verify());

  const q = <T extends HTMLElement = HTMLElement>(sel: string) => el.querySelector<T>(`[data-testid="${sel}"]`)!;
  const calculateButton = () => q<HTMLButtonElement>('calculate');

  async function render() {
    fixture.detectChanges();
    await fixture.whenStable();
  }

  it('disables Calculate Route until both points are resolved', async () => {
    expect(calculateButton().disabled).toBe(true);
    expect(q('missing').textContent).toContain('select Point A, select Point B');
    store.setLocation('start', CENTRALNA);
    await render();
    expect(calculateButton().disabled).toBe(true);
    store.setLocation('destination', KOPERNIK);
    await render();
    expect(calculateButton().disabled).toBe(false);
  });

  it('flight altitude slider defaults to 80 m and updates state', async () => {
    const slider = await loader.getHarness(MatSliderHarness);
    expect(await slider.getMinValue()).toBe(20);
    expect(await slider.getMaxValue()).toBe(120);
    expect(await slider.getStep()).toBe(5);
    const thumb = await slider.getEndThumb();
    expect(await thumb.getValue()).toBe(80);
    await thumb.setValue(100);
    expect(store.altitude()).toBe(100);
    expect(q('altitude').textContent).toContain('100 m');
    expect(q<HTMLInputElement>('altitude-input').value).toBe('100');
  });

  it('numeric altitude input syncs with the slider and validates', async () => {
    store.setLocation('start', CENTRALNA);
    store.setLocation('destination', KOPERNIK);
    const input = q<HTMLInputElement>('altitude-input');
    input.value = '45';
    input.dispatchEvent(new Event('input'));
    await render();
    expect(store.altitude()).toBe(45);
    expect(await (await (await loader.getHarness(MatSliderHarness)).getEndThumb()).getValue()).toBe(45);

    input.value = '47';
    input.dispatchEvent(new Event('input'));
    await render();
    expect(q('altitude-error').textContent).toContain('20–120 m in 5 m steps');
    expect(calculateButton().disabled).toBe(true);
  });

  it('mode selector sends the API enum values', async () => {
    const group = await loader.getHarness(MatButtonToggleHarness.with({ text: 'EMERGENCY' }));
    await group.check();
    expect(store.mode()).toBe('EMERGENCY');
    expect(el.textContent).toContain('never enters no-fly or restricted zones');
    await (await loader.getHarness(MatButtonToggleHarness.with({ text: 'NORMAL' }))).check();
    expect(store.mode()).toBe('NORMAL');
  });

  it('drone profile dropdown lists backend profiles and updates state', async () => {
    const select = await loader.getHarness(MatSelectHarness);
    expect(await select.getValueText()).toBe('Standard Drone: DEMO_DRONE_01');
    await select.open();
    const options = await select.getOptions();
    expect(await Promise.all(options.map((o) => o.getText()))).toEqual([
      'Standard Drone: DEMO_DRONE_01',
      'Delivery Drone: DEMO_DRONE_02',
    ]);
    await options[1].click();
    expect(store.droneProfileId()).toBe('DEMO_DRONE_02');
    expect(q('profile-details').textContent).toContain('18 m/s');
  });

  it('weather selector switches to LIVE and shows when live data is unavailable', async () => {
    // Native click: a harness would wait for stability, which the pending weather request prevents.
    el.querySelector<HTMLButtonElement>('[data-testid="weather"] mat-button-toggle[value="LIVE"] button')!.click();
    fixture.detectChanges();
    expect(store.weatherMode()).toBe('LIVE');
    await render();
    expect(q('weather-info').textContent).toContain('Live weather is not available');
  });

  it('Calculate Route posts the current state and shows loading', async () => {
    store.setLocation('start', CENTRALNA);
    store.setLocation('destination', KOPERNIK);
    await render();
    calculateButton().click();
    await render();
    expect(calculateButton().textContent).toContain('Calculating');
    expect(calculateButton().disabled).toBe(true);
    const req = http.expectOne(ROUTE_URL);
    expect(req.request.body).toEqual({
      start: CENTRALNA.coordinate,
      destination: KOPERNIK.coordinate,
      mode: 'NORMAL',
      flightAltitudeMeters: 80,
      droneProfileId: 'DEMO_DRONE_01',
      weatherMode: 'DEMO',
      routeObjective: 'CORRIDORS',
      scenario: 'NORMAL',
    });
    req.flush(routeResponse(req.request.body));
    await render();
    expect(calculateButton().textContent).toContain('Calculate Route');
  });

  it('Reset Planner restores defaults; Clear Route keeps points', async () => {
    store.setLocation('start', CENTRALNA);
    store.setLocation('destination', KOPERNIK);
    store.setAltitude(110);
    store.calculate();
    http.expectOne(ROUTE_URL).flush(routeResponse(store.request()!));
    q('clear-route').click();
    expect(store.route().phase).toBe('idle');
    expect(store.start()).not.toBeNull();

    q('reset').click();
    await render();
    expect(store.start()).toBeNull();
    expect(store.altitude()).toBe(80);
    expect(calculateButton().disabled).toBe(true);
  });

  it('demo fixtures are behind an explicit "Load demo fixture" toggle', async () => {
    expect(q('fixture-depot-hospital')).toBeNull();
    q('fixtures-toggle').click();
    await render();
    q('fixture-sejm').click();
    await render();
    expect(q('fixture-label').textContent).toContain('Across the Sejm zone');
    const req = http.expectOne(ROUTE_URL);
    expect(req.request.body).toMatchObject({ start: { latitude: 52.2255, longitude: 21.0205 }, scenario: 'NORMAL' });
    req.flush(routeResponse(req.request.body));
  });

  it.each(['BLOOD_DELIVERY', 'AED_DELIVERY', 'AVOID_PROHIBITED_ZONE', 'EMERGENCY'])(
    'clicking %s keeps both points, highlights it and recalculates with the same coordinates',
    async (id) => {
      store.setLocation('start', CENTRALNA);
      store.setLocation('destination', KOPERNIK);
      await render();
      q(`scenario-${id}`).click();
      await render();
      expect(q(`scenario-${id}`).classList.contains('active')).toBe(true);
      expect(q(`scenario-${id}`).getAttribute('aria-pressed')).toBe('true');
      expect(store.start()).toEqual(CENTRALNA);
      expect(store.destination()).toEqual(KOPERNIK);
      const req = http.expectOne(ROUTE_URL);
      expect(req.request.body.start).toEqual(CENTRALNA.coordinate);
      expect(req.request.body.destination).toEqual(KOPERNIK.coordinate);
      expect(req.request.body.scenario).toBe(id);
      req.flush(routeResponse(req.request.body));
    },
  );

  it('asks for both points instead of loading fallback coordinates', async () => {
    q('scenario-BLOOD_DELIVERY').click();
    await render();
    expect(q('scenario-notice').textContent).toContain(
      'Please select both the starting point and destination before calculating a route.',
    );
    expect(store.start()).toBeNull();
    http.expectNone(ROUTE_URL);
  });

  it('route optimisation selector sends CORRIDORS / SHORTEST / FASTEST / SAFEST', async () => {
    store.setLocation('start', CENTRALNA);
    store.setLocation('destination', KOPERNIK);
    expect(store.routeObjective()).toBe('CORRIDORS');
    await (await loader.getHarness(MatButtonToggleHarness.with({ text: 'Fastest' }))).check();
    expect(store.routeObjective()).toBe('FASTEST');
    expect(q('objective-hint').textContent).toContain('wind at your altitude');
    await (await loader.getHarness(MatButtonToggleHarness.with({ text: 'Shortest' }))).check();
    expect(store.request()?.routeObjective).toBe('SHORTEST');
    await (await loader.getHarness(MatButtonToggleHarness.with({ text: 'Safest' }))).check();
    expect(store.request()?.routeObjective).toBe('SAFEST');
    expect(q('objective-hint').textContent).toContain('not census');
  });
});
