import { Type } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';

import { ManualScheduler, sessionInfo, simEvent, stepResponse } from '../../testing/sim-fixtures';
import { API_BASE_URL } from '../core/api';
import { DroneDetailsComponent } from './drone-details';
import { EventPanelComponent } from './event-panel';
import { DroneDetail } from './sim-models';
import { FRAME_SCHEDULER, SimSession } from './sim-session';
import { TelemetryListComponent } from './telemetry-list';

const BASE = `${API_BASE_URL}/simulations`;

describe('simulation panels', () => {
  let session: SimSession;
  let http: HttpTestingController;
  let clock: ManualScheduler;

  beforeEach(() => {
    sessionStorage.clear();
    clock = new ManualScheduler();
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting(), SimSession, { provide: FRAME_SCHEDULER, useValue: clock }],
    });
    session = TestBed.inject(SimSession);
    http = TestBed.inject(HttpTestingController);
    session.start({ scenarioId: 'basic' });
    http.expectOne(BASE).flush(sessionInfo());
  });

  function render<T>(type: Type<T>) {
    const fixture = TestBed.createComponent(type);
    fixture.detectChanges();
    return { fixture, el: fixture.nativeElement as HTMLElement };
  }

  it('lists live telemetry and selects and follows a drone on click', () => {
    const { fixture, el } = render(TelemetryListComponent);
    const row = el.querySelector<HTMLButtonElement>('[data-testid="tl-d1"]')!;
    expect(row.textContent).toContain('Courier 1');
    expect(row.textContent).toContain('Cruising');
    expect(row.textContent).toContain('10.0 m/s');
    expect(row.textContent).toContain('80 m');
    expect(row.textContent).toContain('ETA 3:20');
    expect(row.querySelector<HTMLElement>('.tl-progress i')!.style.width).toBe('0%');
    expect(el.querySelector('[data-testid="tl-d2"]')!.textContent).not.toContain('m/s'); // on the ground
    let picked = '';
    fixture.componentInstance.picked.subscribe((id) => (picked = id));
    row.click();
    fixture.detectChanges();
    expect(session.selectedId()).toBe('d1');
    expect(session.follow()).toBe(true);
    expect(picked).toBe('d1');
    expect(row.getAttribute('aria-pressed')).toBe('true');
    el.querySelector<HTMLButtonElement>('[data-testid="follow-toggle"]')!.click();
    expect(session.follow()).toBe(false);
  });

  it('shows events up to the playhead, filters them and jumps on click', () => {
    session.events.set([
      simEvent(0, 0, 'STATE_CHANGED', { from: 'IDLE', to: 'LOADING' }, 'd1'),
      simEvent(1, 0, 'BATTERY_WARNING', { levelPct: 40 }, 'd2'),
      simEvent(2, 0, 'EMERGENCY', { site: 'East pad', reason: 'low battery' }, 'd2'),
      simEvent(3, 50, 'DELIVERED', {}, 'd1'), // not yet at the playhead
    ]);
    const { fixture, el } = render(EventPanelComponent);
    const items = () => [...el.querySelectorAll('[data-testid="feed-item"]')].map((x) => x.textContent!.replace(/\s+/g, ' ').trim());
    expect(items().length).toBe(3);
    expect(items()[0]).toContain('Courier 2 Emergency landing: East pad');
    expect(el.querySelector('.ef-toggle')!.textContent).toContain('1 critical');
    expect(el.querySelector('[data-testid="feed-announcer"]')!.textContent).toContain('Courier 2: Emergency landing: East pad');

    el.querySelector<HTMLButtonElement>('[data-testid="feed-info"]')!.click();
    fixture.detectChanges();
    expect(items().length).toBe(2);
    const select = el.querySelector<HTMLSelectElement>('[data-testid="feed-drone"]')!;
    select.value = 'd1';
    select.dispatchEvent(new Event('change'));
    fixture.detectChanges();
    expect(items().length).toBe(0);
    expect(el.querySelector('.ef-list .state')!.textContent).toContain('No events match');

    select.value = '';
    select.dispatchEvent(new Event('change'));
    fixture.detectChanges();
    el.querySelector<HTMLButtonElement>('[data-testid="feed-item"]')!.click();
    expect(session.selectedId()).toBe('d2');
    expect(session.focus()?.droneId).toBe('d2');

    el.querySelector<HTMLButtonElement>('[data-testid="feed-toggle"]')!.click();
    fixture.detectChanges();
    expect(el.querySelector('#ef-body')).toBeNull(); // collapsed
  });

  it('compares planned and actual energy and lists the cost of each leg', () => {
    session.select('d1');
    const { fixture, el } = render(DroneDetailsComponent);
    expect(el.textContent).toContain('Loading details');
    clock.advance(16);
    const detail: Partial<DroneDetail> = {
      drone: { id: 'd1', name: 'Courier 1', state: 'CRUISE', batteryPct: 90, leg: null },
      missionActive: true,
      mission: {
        id: 'm1', status: 'OUTBOUND', mode: 'NORMAL', routeObjective: 'SAFEST', altitudeM: 80, payloadKg: 0.5,
        afterDelivery: 'NEAREST_STATION', returnTarget: { label: 'East pad' }, plannedEnergyWh: 40, energyUsedWh: 12, faultLossWh: 0,
        start: { label: 'West pad', latitude: 0, longitude: 0, stationId: 'st-west' },
        destination: { label: 'Point B', latitude: 0, longitude: 0, stationId: null },
        breakdowns: {
          outbound: { totalCost: 2500, lengthM: 2000, energyWh: 22, verticalEnergyWh: 3, flightTimeS: 200, note: 'DEMO',
            terms: [{ term: 'population', weight: 4, mean: 0.1, cost: 400 }, { term: 'noise', weight: 0, mean: 0.2, cost: 0 }] },
          return: { totalCost: 900, lengthM: 800, energyWh: 9, verticalEnergyWh: 2, flightTimeS: 80, note: 'DEMO', terms: [] },
        },
      },
      energy: { missionId: 'm1', current: true, plannedWh: 40, usedWh: 12, faultLossWh: 0, toFinishWh: 32, projectedWh: 44, batteryWh: 78, reserveWh: 20 },
      missions: [{ id: 'm1', status: 'OUTBOUND', plannedEnergyWh: 40, energyUsedWh: 12 }],
    };
    http.expectOne(`${BASE}/sess1/drones/d1`).flush(detail);
    fixture.detectChanges();
    expect(el.textContent).toContain('Mission m1');
    expect(el.textContent).toContain('Flying to Point B');
    expect(el.textContent).toContain('East pad'); // where it goes afterwards
    expect(el.textContent).toContain('Normal, Safest');
    const text = el.querySelector('[data-testid="dd-energy-text"]')!;
    expect(text.textContent).toContain('Used 12 Wh, about 32 Wh still needed.');
    expect(text.textContent).toContain('About 10 % more than planned.');
    expect(text.classList.contains('over')).toBe(true);
    expect(el.querySelector<HTMLElement>('.bar .planned')!.style.width).toBe(`${(40 / 44) * 100}%`);
    expect(el.querySelector('[data-testid="dd-leg-outbound"]')!.textContent).toContain('Crowds (estimated)');
    expect(el.querySelector('[data-testid="dd-leg-return"]')).not.toBeNull();
    expect(el.querySelector('[data-testid="dd-leg-divert"]')).toBeNull();
  });

  it('says when details are from the newest time while replaying', () => {
    session.setSpeed(60);
    session.play();
    clock.advance(16);
    http.expectOne(`${BASE}/sess1/step`).flush(stepResponse(0, 30, 1));
    session.pause();
    session.clockT = 30;
    clock.advance(300);
    session.select('d1');
    session.seek(10);
    const { el } = render(DroneDetailsComponent);
    expect(el.querySelector('[data-testid="dd-replay-note"]')!.textContent).toContain('Replaying T+0:10');
    http.match(() => true).forEach((r) => r.flush({}));
  });
});
