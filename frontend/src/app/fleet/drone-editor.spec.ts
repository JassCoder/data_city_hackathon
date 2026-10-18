import { TestBed, ComponentFixture } from '@angular/core/testing';
import { ApplicationRef } from '@angular/core';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { FleetStore } from '../core/fleet.store';
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

  const q = (testid: string) => el.querySelector<HTMLElement>(`[data-testid="${testid}"]`);
  const radio = (group: string, value: string) =>
    q(group)!.querySelector<HTMLInputElement>(`input[value="${value}"]`)!;

  it('lists what is missing and keeps Calculate disabled until the drone is valid', async () => {
    expect(q('drone-issues')!.textContent).toContain('Set Point A.');
    expect((q('calculate') as HTMLButtonElement).disabled).toBe(true);
    fleet.setLocation(id, 'start', CENTRALNA);
    fleet.setLocation(id, 'destination', KOPERNIK);
    await render();
    expect(q('drone-issues')).toBeNull();
    expect((q('calculate') as HTMLButtonElement).disabled).toBe(false);
  });

  it('offers only Normal and Emergency, with no mission sub-options', async () => {
    const modes = [...q('mode')!.querySelectorAll('span')].map((s) => s.textContent?.trim());
    expect(modes).toEqual(['Normal', 'Emergency']);
    radio('mode', 'EMERGENCY').click();
    await render();
    expect(q('mission')).toBeNull();
    expect(fleet.drones()[0].mode).toBe('EMERGENCY');
  });

  it('keeps the optimisation free in both modes', async () => {
    radio('mode', 'EMERGENCY').click();
    await render();
    expect(radio('optimisation', 'SAFEST').disabled).toBe(false);
    radio('optimisation', 'LOWEST_ENERGY').click();
    await render();
    expect(fleet.drones()[0]).toMatchObject({ mode: 'EMERGENCY', optimisation: 'LOWEST_ENERGY' });
  });

  it('shows no explanatory texts, drone profile or payload', () => {
    for (const id of ['zone-rule', 'mode-help', 'optimisation-help', 'profile']) expect(q(id)).toBeNull();
    expect(el.textContent).not.toMatch(/always avoided|Standard flight with|Prefers the Vistula|profile|payload/i);
  });
});
