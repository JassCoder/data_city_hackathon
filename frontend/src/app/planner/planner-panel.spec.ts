import { TestBed, ComponentFixture } from '@angular/core/testing';
import { HttpInterceptorFn, HttpResponse, provideHttpClient, withInterceptors } from '@angular/common/http';
import { of } from 'rxjs';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { HarnessLoader } from '@angular/cdk/testing';
import { TestbedHarnessEnvironment } from '@angular/cdk/testing/testbed';
import { MatButtonToggleHarness } from '@angular/material/button-toggle/testing';
import { MatSliderHarness } from '@angular/material/slider/testing';
import { API_BASE_URL } from '../core/api';
import { LayersService } from '../core/layers';
import { WeatherInfo } from '../core/models';
import { PlannerStore } from '../core/planner.store';
import { CENTRALNA, _WEATHER, KOPERNIK, routeResponse, settle } from '../../testing/fixtures';
import { PlannerPanelComponent } from './planner-panel';

const ROUTE_URL = `${API_BASE_URL}/routes/calculate`;

const LIVE: WeatherInfo = {
  ..._WEATHER, mode: 'LIVE', source: 'OPEN_METEO', liveAvailable: true, windSpeedKmh: 17.3, windDirectionDeg: 240,
  windGustKmh: 29, observedAt: '2026-10-18T14:00Z', message: 'Open-Meteo forecast',
};
let liveResponse: WeatherInfo = LIVE;

/** The weather readout refetches whenever altitude or mode changes: answer it at once. */
const weatherStub: HttpInterceptorFn = (req, next) =>
  req.url.startsWith(`${API_BASE_URL}/weather`)
    ? of(new HttpResponse({ status: 200, body: req.urlWithParams.includes('mode=LIVE') ? liveResponse : _WEATHER }))
    : next(req);

describe('PlannerPanelComponent', () => {
  let fixture: ComponentFixture<PlannerPanelComponent>;
  let http: HttpTestingController;
  let store: PlannerStore;
  let loader: HarnessLoader;
  let el: HTMLElement;

  async function create() {
    fixture = TestBed.createComponent(PlannerPanelComponent);
    fixture.detectChanges();
    await settle(http, fixture);
    fixture.detectChanges();
    loader = TestbedHarnessEnvironment.loader(fixture);
    el = fixture.nativeElement;
  }

  function configure() {
    TestBed.configureTestingModule({
      imports: [PlannerPanelComponent],
      providers: [provideHttpClient(withInterceptors([weatherStub])), provideHttpClientTesting()],
    });
    http = TestBed.inject(HttpTestingController);
    store = TestBed.inject(PlannerStore);
    TestBed.inject(LayersService).resource.value();
  }

  beforeEach(async () => {
    liveResponse = LIVE;
    configure();
    await create();
  });

  afterEach(() => http.verify());

  const q = <T extends HTMLElement = HTMLElement>(sel: string) => el.querySelector<T>(`[data-testid="${sel}"]`)!;
  const calculateButton = () => q<HTMLButtonElement>('calculate');

  async function render() {
    fixture.detectChanges();
    await fixture.whenStable();
  }

  it('shows only the simplified controls: no scenarios, departure picker or profile dropdown', () => {
    const text = el.textContent!;
    expect(text).toContain('Starting address');
    expect(text).toContain('Destination address');
    expect(text).not.toContain('Point A');
    expect(text).not.toContain('Point B');
    expect(text).toContain('Select on map');
    expect(text).not.toContain('sample profile');
    expect(text).not.toContain('Minimises flight time');
    for (const label of ['Flight Altitude', 'Flight Mode', 'Route Optimisation', 'Drone Profile: Standard Drone', 'Weather',
      'Find Route', 'Start Simulation', 'Clear Route']) {
      expect(text).toContain(label);
    }
    expect(el.querySelector('[data-testid="scenarios"]')).toBeNull();
    expect(text).not.toContain('Routing scenario');
    expect(text).not.toContain('Blood Delivery');
    expect(text).not.toContain('Avoid Prohibited Zone');
    expect(el.querySelector('[data-testid="departure-time"]')).toBeNull();
    expect(text).not.toContain('Planned departure');
    expect(el.querySelector('mat-select')).toBeNull(); // no drone profile dropdown
    expect(el.querySelector('[data-testid="fixtures-toggle"]')).toBeNull();
  });

  it('disables Find Route until both points are resolved', async () => {
    expect(calculateButton().disabled).toBe(true);
    expect(q('missing').textContent).toContain('select the starting address, select the destination address');
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

  it('numeric altitude input syncs with the slider, validates and invalidates the route', async () => {
    store.setLocation('start', CENTRALNA);
    store.setLocation('destination', KOPERNIK);
    store.calculate();
    http.expectOne(ROUTE_URL).flush(routeResponse(store.request()!));
    const input = q<HTMLInputElement>('altitude-input');
    input.value = '45';
    input.dispatchEvent(new Event('input'));
    await render();
    expect(store.altitude()).toBe(45);
    expect(store.route().phase).toBe('stale');
    expect(await (await (await loader.getHarness(MatSliderHarness)).getEndThumb()).getValue()).toBe(45);
    input.value = '47';
    input.dispatchEvent(new Event('input'));
    await render();
    expect(q('altitude-error').textContent).toContain('20–120 m in 5 m steps');
    expect(calculateButton().disabled).toBe(true);
  });

  it('flight mode: Normal / Emergency', async () => {
    await (await loader.getHarness(MatButtonToggleHarness.with({ text: 'Emergency' }))).check();
    expect(store.mode()).toBe('EMERGENCY');
    expect(el.textContent).not.toContain('More direct paths'); // no explanatory text under the buttons
    await (await loader.getHarness(MatButtonToggleHarness.with({ text: 'Normal' }))).check();
    expect(store.mode()).toBe('NORMAL');
  });

  it('route optimisation: Smart Route first and selected by default, then Fastest and Shortest', async () => {
    const labels = Array.from(q('objective').querySelectorAll('mat-button-toggle')).map((t) => t.textContent!.trim());
    expect(labels).toEqual(['Smart Route', 'Fastest', 'Shortest']);
    store.setLocation('start', CENTRALNA);
    store.setLocation('destination', KOPERNIK);
    expect(store.request()?.optimization).toBe('BALANCED');
    await (await loader.getHarness(MatButtonToggleHarness.with({ text: 'Fastest' }))).check();
    expect(store.request()?.optimization).toBe('FASTEST');
    await (await loader.getHarness(MatButtonToggleHarness.with({ text: 'Shortest' }))).check();
    expect(store.request()?.optimization).toBe('SHORTEST');
    await (await loader.getHarness(MatButtonToggleHarness.with({ text: 'Smart Route' }))).check();
    expect(store.request()?.optimization).toBe('BALANCED');
    expect(el.querySelector('[data-testid="objective-hint"]')).toBeNull();
  });

  it('shows the Standard Drone read-only and uses its profile id', () => {
    expect(q('drone-profile').textContent).toContain('Drone Profile: Standard Drone');
    expect(q('profile-details').textContent).toContain('15 m/s');
    expect(store.droneProfileId()).toBe('DEMO_DRONE_01');
  });

  it('weather is LIVE by default and shows the Open-Meteo values and forecast time', async () => {
    expect(store.weatherMode()).toBe('LIVE');
    await render();
    const info = q('weather-info').textContent!;
    expect(info).toContain('LIVE · Open-Meteo');
    expect(info).toContain('17.3 km/h');
    expect(info).toContain('gusts 29 km/h');
    expect(q('weather-time').textContent).toContain('Forecast for');
  });

  it('a failed LIVE request is shown as not live (never silently relabelled)', async () => {
    fixture.destroy();
    TestBed.resetTestingModule();
    liveResponse = { ...LIVE, source: 'SAMPLE_FALLBACK', liveAvailable: false, observedAt: null,
      message: 'Live weather is not available (ConnectError) and nothing recent is cached.' };
    configure();
    await create();
    await render();
    const info = q('weather-info');
    expect(info.textContent).toContain('Live weather unavailable – sample wind, NOT live data');
    expect(info.classList.contains('fallback')).toBe(true);
  });

  it('Find Route posts the simplified contract and shows loading', async () => {
    store.setLocation('start', CENTRALNA);
    store.setLocation('destination', KOPERNIK);
    await render();
    calculateButton().click();
    await render();
    expect(calculateButton().textContent).toContain('Calculating');
    const req = http.expectOne(ROUTE_URL);
    expect(req.request.body).toEqual({
      start: CENTRALNA.coordinate,
      destination: KOPERNIK.coordinate,
      mode: 'NORMAL',
      optimization: 'BALANCED',
      flightAltitudeMeters: 80,
      droneProfileId: 'DEMO_DRONE_01',
      weatherMode: 'LIVE',
    });
    req.flush(routeResponse(req.request.body));
    await render();
    expect(calculateButton().textContent).toContain('Find Route');
  });

  it('Start Simulation stays disabled until a valid route exists, then shows the flight controls', async () => {
    const startSim = () => q<HTMLButtonElement>('start-simulation');
    expect(startSim().textContent).toContain('Start Simulation');
    expect(startSim().disabled).toBe(true);
    store.setLocation('start', CENTRALNA);
    store.setLocation('destination', KOPERNIK);
    await render();
    expect(startSim().disabled).toBe(true); // points alone are not a route
    calculateButton().click();
    http.expectOne(ROUTE_URL).flush(routeResponse(store.request()!));
    await render();
    expect(startSim().disabled).toBe(false);
    startSim().click();
    const back = http.expectOne(ROUTE_URL); // return leg B → A
    expect(back.request.body.start).toEqual(KOPERNIK.coordinate);
    back.flush(routeResponse(back.request.body));
    await render();
    expect(q('sim-phase').textContent).toContain('Outbound');
    expect(startSim().disabled).toBe(true); // no second loop while flying
    for (const id of ['sim-pause', 'sim-stop', 'sim-restart', 'sim-progress-bar', 'sim-speed', 'sim-travelled',
      'sim-remaining', 'sim-elapsed', 'sim-time-left', 'sim-location']) {
      expect(el.querySelector(`[data-testid="${id}"]`)).not.toBeNull();
    }
    expect(q('sim-speed-toggle').textContent!.replace(/\s+/g, '')).toBe('1×2×5×10×');
    q('sim-pause').click();
    await render();
    expect(q('sim-resume')).not.toBeNull();
    q('sim-stop').click();
    await render();
    expect(el.querySelector('[data-testid="simulation-panel"]')).toBeNull();
    expect(startSim().disabled).toBe(false);
  });

  it('Clear Route keeps points; Reset restores defaults', async () => {
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
});
