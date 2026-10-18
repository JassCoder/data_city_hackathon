import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import * as L from 'leaflet';

import { stubCanvas } from '../../testing/canvas-stub';
import { ManualScheduler, code, cruiseFrame, frame, row, sessionInfo, simEvent, stepResponse } from '../../testing/sim-fixtures';
import { API_BASE_URL } from '../core/api';
import { SimLayerComponent } from './sim-layer';
import { FRAME_SCHEDULER, SimSession } from './sim-session';

const BASE = `${API_BASE_URL}/simulations`;
const ZONE = {
  id: 'drawn-1',
  name: 'Drawn zone 1',
  category: 'DRA-R',
  lowerM: 0,
  upperM: 120,
  drawn: true,
  geometry: { type: 'Polygon' as const, coordinates: [[[21.0, 52.23], [21.01, 52.23], [21.01, 52.24], [21.0, 52.23]]] },
};

describe('SimLayerComponent', () => {
  beforeAll(() => stubCanvas());

  let fixture: ComponentFixture<SimLayerComponent>;
  let session: SimSession;
  let http: HttpTestingController;
  let clock: ManualScheduler;
  let map: L.Map;
  let host: HTMLElement;

  beforeEach(() => {
    sessionStorage.clear();
    clock = new ManualScheduler();
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting(), SimSession, { provide: FRAME_SCHEDULER, useValue: clock }],
    });
    host = document.createElement('div');
    document.body.appendChild(host);
    map = L.map(host).setView([52.235, 21.01], 14);
    map.createPane('zonePane');
    session = TestBed.inject(SimSession);
    http = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(SimLayerComponent);
    fixture.componentRef.setInput('map', map);
    fixture.detectChanges();
  });

  afterEach(() => {
    fixture.destroy();
    map.remove();
    host.remove();
  });

  function start(over = {}): void {
    session.start({ scenarioId: 'basic' });
    http.expectOne(BASE).flush(sessionInfo(over));
    fixture.detectChanges();
    clock.advance(16); // first animation frame
  }

  const drone = (i: number) => host.querySelectorAll<HTMLElement>('.sim-drone')[i];

  it('draws one marker per drone, rotated to its heading, with its state and name', () => {
    start();
    expect(host.querySelectorAll('.sim-drone').length).toBe(2);
    expect(drone(0).dataset['state']).toBe('CRUISE');
    expect(drone(0).querySelector<SVGElement>('.sd-arrow')!.style.transform).toBe('rotate(90.0deg)');
    expect(drone(0).querySelector('.sd-name')!.textContent).toBe('Courier 1');
    expect(drone(0).querySelector('.sd-state')!.textContent).toBe('Cruising');
    expect(drone(1).classList.contains('ground')).toBe(true);
    const icon = drone(0).closest('.sim-drone-icon')!;
    expect(icon.getAttribute('aria-label')).toBe('Courier 1: Cruising, battery 90 %');
    expect(icon.getAttribute('tabindex')).toBe('0'); // reachable by keyboard
  });

  it('moves markers every frame and updates the battery bar only when it changes', () => {
    start();
    session.setSpeed(5);
    session.play();
    clock.advance(16);
    http.expectOne(`${BASE}/sess1/step`).flush(stepResponse(0, 30));
    const marker = () => {
      const st = (drone(0).closest('.sim-drone-icon') as HTMLElement).style;
      return st.transform || `${st.left},${st.top}`; // jsdom: Leaflet positions with left/top
    };
    const before = marker();
    for (let i = 0; i < 30; i++) clock.advance(16);
    expect(marker()).not.toBe(before);
    expect(drone(0).querySelector<HTMLElement>('.sd-bat i')!.style.width).toBe('90%');
  });

  it('marks holding, emergency and failed drones with their own state', () => {
    const states = ['HOLDING', 'EMERGENCY_LANDING', 'FAILED'] as const;
    for (const s of states) {
      fixture.destroy();
      fixture = TestBed.createComponent(SimLayerComponent);
      fixture.componentRef.setInput('map', map);
      fixture.detectChanges();
      session.start({ scenarioId: 'basic' });
      http.expectOne(BASE).flush(sessionInfo({ frame: frame(0, [row({ state: code(s), batteryPct: 15 }), row()]) }));
      fixture.detectChanges();
      clock.advance(16);
      const el = host.querySelectorAll<HTMLElement>('.sim-drone');
      expect(el[el.length - 2].dataset['state']).toBe(s);
      expect(el[el.length - 2].querySelector('.sd-glyph svg')).not.toBeNull(); // a glyph, not only a colour
      expect(el[el.length - 2].querySelector<HTMLElement>('.sd-bat')!.dataset['level']).toBe('critical');
    }
  });

  it('highlights the selected drone', () => {
    start();
    session.select('d2');
    fixture.detectChanges();
    expect(drone(1).classList.contains('selected')).toBe(true);
    expect(drone(0).classList.contains('selected')).toBe(false);
  });

  it('emits the drone id when a marker is clicked', () => {
    start();
    let clicked: string | null = null;
    fixture.componentInstance.droneClick.subscribe((id) => (clicked = id));
    (drone(1).closest('.sim-drone-icon') as HTMLElement).click();
    expect(clicked).toBe('d2');
  });

  it('rings a landing station while a drone charges there', () => {
    const pad = sessionInfo().stations[0];
    start({ frame: frame(0, [cruiseFrame(0).d[0], row({ longitude: pad.longitude, latitude: pad.latitude, state: code('CHARGING') })]) });
    clock.advance(200); // routes and stations refresh at 10 Hz
    expect(host.querySelectorAll('.sim-station-charging').length).toBe(1);
  });

  it('draws temporary zones only while they are active', () => {
    start({ zones: [ZONE] });
    expect(map.getPane('zonePane')!.querySelectorAll('path').length).toBe(0);
    session.events.set([simEvent(0, 0, 'SCENARIO_EVENT', { kind: 'zone_activate', zoneId: 'drawn-1' }, null)]);
    fixture.detectChanges();
    clock.advance(300);
    fixture.detectChanges();
    const paths = map.getPane('zonePane')!.querySelectorAll('path');
    expect(paths.length).toBe(2); // the zone and its ticked border
    expect(paths[0].getAttribute('fill')).toBe('url(#zp-conditional)');
  });

  it('collapses name tags at low zoom', () => {
    start();
    map.setZoom(11, { animate: false });
    expect(host.classList.contains('sim-zoom-low')).toBe(true);
    map.setZoom(15, { animate: false });
    expect(host.classList.contains('sim-zoom-low')).toBe(false);
  });
});
