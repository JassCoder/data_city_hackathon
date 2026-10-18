import { TestBed, ComponentFixture } from '@angular/core/testing';
import { ApplicationRef } from '@angular/core';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { FleetStore } from '../core/fleet.store';
import { PlannerApi } from '../core/planner-api';
import { MapDataService } from '../core/map-data';
import { LayersService } from '../core/layers';
import { HealthService } from '../core/health';
import { CENTRALNA, KOPERNIK, settle } from '../../testing/fixtures';
import { DroneEditorComponent } from './drone-editor';

describe('DroneEditorComponent', () => {
  let fixture: ComponentFixture<DroneEditorComponent>;
  let fleet: FleetStore;
  let el: HTMLElement;
  let id: string;

  beforeEach(async () => {
    localStorage.clear();
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
    fleet = TestBed.inject(FleetStore);
    const http = TestBed.inject(HttpTestingController);
    TestBed.inject(PlannerApi).profiles.value();
    TestBed.inject(PlannerApi).scenarios.value();
    TestBed.inject(MapDataService).boundary.value();
    TestBed.inject(LayersService).resource.value();
    TestBed.inject(HealthService).resource.value();
    await settle(http, TestBed.inject(ApplicationRef));
    id = fleet.addDrone().id;
    fixture = TestBed.createComponent(DroneEditorComponent);
    fixture.componentRef.setInput('droneId', id);
    await render();
    el = fixture.nativeElement;
  });

  async function render() {
    fixture.detectChanges();
    await fixture.whenStable();
  }

  const q = (testid: string) => el.querySelector<HTMLElement>(`[data-testid="${testid}"]`)!;
  const radio = (group: string, value: string) =>
    q(group).querySelector<HTMLInputElement>(`input[value="${value}"]`)!;

  it('lists what is missing and keeps Calculate disabled until the drone is valid', async () => {
    expect(q('drone-issues').textContent).toContain('Set Point A.');
    expect((q('calculate') as HTMLButtonElement).disabled).toBe(true);
    fleet.setLocation(id, 'start', CENTRALNA);
    fleet.setLocation(id, 'destination', KOPERNIK);
    await render();
    expect(el.querySelector('[data-testid="drone-issues"]')).toBeNull();
    expect((q('calculate') as HTMLButtonElement).disabled).toBe(false);
  });

  it('emergency mode offers the mission types, and a mission locks the optimisation', async () => {
    radio('mode', 'EMERGENCY').click();
    await render();
    const missions = [...q('mission').querySelectorAll('span')].map((s) => s.textContent?.trim());
    expect(missions).toEqual(['General emergency', 'Blood delivery', 'AED / first aid']);
    expect(q('mode-help').textContent).toContain('grants no airspace permission');

    radio('mission', 'BLOOD_DELIVERY').click();
    await render();
    expect(radio('optimisation', 'FASTEST').checked).toBe(true);
    expect(radio('optimisation', 'SAFEST').disabled).toBe(true);
    expect(q('optimisation-help').textContent).toContain('Fastest, set by the blood delivery mission');
    expect(q('mission-help').textContent).toContain('Minimises delivery time');
  });

  it('back in normal mode the optimisation is free again', async () => {
    radio('mode', 'EMERGENCY').click();
    await render();
    radio('mode', 'NORMAL').click();
    await render();
    radio('optimisation', 'LOWEST_ENERGY').click();
    await render();
    expect(fleet.drones()[0]).toMatchObject({ mode: 'NORMAL', mission: 'GENERAL', optimisation: 'LOWEST_ENERGY' });
    expect(q('optimisation-help').textContent).toContain('Least battery use');
  });
});
