import { Component, OnDestroy, computed, effect, inject, signal, untracked } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import type * as L from 'leaflet';

import { AirspaceService } from '../core/airspace';
import { FleetStore } from '../core/fleet.store';
import { LayersService } from '../core/layers';
import { MapDataService } from '../core/map-data';
import { MapLayersService } from '../core/map-layers';
import { SheetState } from '../core/ui-state';
import { LayersPanelComponent, isSmallScreen } from '../map/layers-panel';
import { MapComponent } from '../map/map';
import { MapLegendComponent } from '../map/map-legend';
import { IconComponent } from '../ui/icon';
import { fleetToScenario } from './fleet-scenario';
import { PlaybackBarComponent } from './playback-bar';
import { SimLayerComponent } from './sim-layer';
import { TelemetryListComponent } from './telemetry-list';
import { EventPanelComponent } from './event-panel';
import { DroneDetailsComponent } from './drone-details';
import { SimSession } from './sim-session';
import { SimStartComponent, StartChoice } from './sim-start';

const NEXT_SHEET: Record<SheetState, SheetState> = { peek: 'half', half: 'full', full: 'peek' };
/** Keys that belong to the focused control, not to the playback shortcuts. */
const TYPING = 'input:not([type="range"]):not([type="radio"]):not([type="checkbox"]), textarea, select, [contenteditable]';
const ACTIVATES_ON_SPACE = 'button, a[href], summary, [role="button"], input[type="checkbox"]';

/** The simulation view: scenario picker or live panels, the map with drones, the playback bar. */
@Component({
  selector: 'app-sim-page',
  imports: [MapComponent, LayersPanelComponent, MapLegendComponent, IconComponent, PlaybackBarComponent, SimStartComponent, SimLayerComponent, TelemetryListComponent, EventPanelComponent, DroneDetailsComponent],
  providers: [SimSession],
  host: { '(document:keydown)': 'onKey($event)' },
  styleUrl: './sim-page.scss',
  templateUrl: './sim-page.html',
})
export class SimPage implements OnDestroy {
  protected readonly sim = inject(SimSession);
  protected readonly layers = inject(LayersService);
  protected readonly airspace = inject(AirspaceService);
  protected readonly mapData = inject(MapDataService);
  protected readonly mapLayers = inject(MapLayersService);
  private readonly fleet = inject(FleetStore);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);

  protected readonly sheet = signal<SheetState>('half');
  protected readonly drawerOpen = signal(false);
  protected readonly flightLabel = computed(() => `a flight at ${this.airspace.altitude()} m AGL`);
  protected readonly sheetLabel = computed(() => (this.sheet() === 'full' ? 'Collapse the panel' : 'Expand the panel'));
  protected readonly map = signal<L.Map | undefined>(undefined);

  constructor() {
    // Small screens: lower the sheet once a simulation runs, so the map shows.
    effect(() => {
      if (this.sim.phase() === 'ready' && isSmallScreen()) untracked(() => this.sheet.set('peek'));
    });
    if (this.route.snapshot.queryParamMap.get('from') === 'plan') {
      const built = fleetToScenario(this.fleet.drones(), new Date());
      if (built) this.sim.start({ scenario: built.scenario });
      void this.router.navigate([], { queryParams: {}, replaceUrl: true });
    } else {
      this.sim.resume();
    }
  }

  protected start(choice: StartChoice): void {
    const { seed, ...source } = choice;
    this.sim.start(source as { scenarioId: string } | { scenario: unknown }, seed);
  }

  /** After a fatal error: the same scenario again if it was a file, else back to the picker. */
  protected startAgain(): void {
    const info = this.sim.info();
    if (info?.scenario.id) this.sim.start({ scenarioId: info.scenario.id }, info.seed);
    else this.sim.close();
  }

  protected onMapReady(map: L.Map): void {
    this.map.set(map);
  }

  /** A telemetry row was picked: details on desktop, the map (following the drone) on phones. */
  protected onPicked(): void {
    if (isSmallScreen()) this.sheet.set('peek');
    else this.drawerOpen.set(true);
  }

  /** An event was clicked: show the map on phones. */
  protected onJumped(): void {
    if (isSmallScreen()) this.sheet.set('peek');
  }

  /** A drone marker was clicked: select it and show its details. */
  protected openDrone(id: string): void {
    this.sim.select(id);
    if (!isSmallScreen()) this.drawerOpen.set(true);
  }

  protected cycleSheet(): void {
    this.sheet.update((s) => NEXT_SHEET[s]);
  }

  protected onKey(e: KeyboardEvent): void {
    if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || this.sim.phase() !== 'ready') return;
    const target = e.target instanceof Element ? e.target : null;
    if (target?.closest(TYPING)) return;
    if (e.key === ' ') {
      if (target?.closest(ACTIVATES_ON_SPACE)) return; // the focused control handles Space itself
      e.preventDefault();
      this.sim.togglePlay();
    } else if (e.key === '.') {
      this.sim.stepOnce();
    } else if (e.key === 'l' || e.key === 'L') {
      this.sim.goLive();
    }
  }

  ngOnDestroy(): void {
    this.map.set(undefined);
  }
}
