import { Injectable, computed, inject, signal } from '@angular/core';

import { Coordinate } from '../core/models';
import { SETTINGS } from '../core/settings';
import { zoneCommand } from './commands';
import { SimSession } from './sim-session';

/**
 * The restricted zone being drawn: corners clicked on the map, altitude cap and duration.
 * Finishing builds and sends a zone command (validated first, so mistakes are explained
 * before anything is sent). Provided by the simulation page.
 */
@Injectable()
export class ZoneDraft {
  private readonly sim = inject(SimSession);

  readonly active = signal(false);
  readonly points = signal<Coordinate[]>([]);
  readonly name = signal('');
  readonly upperM = signal<number>(SETTINGS.sim.zoneDefaults.upperM);
  readonly durationMin = signal<number>(SETTINGS.sim.zoneDefaults.durationMin);
  readonly error = signal<string | null>(null);
  readonly sending = signal(false);
  /** Plain confirmation of the last zone sent. */
  readonly sent = signal<{ zoneId: string; text: string } | null>(null);
  readonly canFinish = computed(() => this.points().length >= 3 && !this.sending());

  start(): void {
    this.sim.catchUp(); // draw on the drones where the engine has them
    this.points.set([]);
    this.error.set(null);
    this.sent.set(null);
    this.active.set(true);
  }

  add(c: Coordinate): void {
    if (!this.active()) return;
    this.error.set(null);
    this.points.update((ps) => [...ps, c]);
  }

  undo(): void {
    this.points.update((ps) => ps.slice(0, -1));
  }

  cancel(): void {
    this.active.set(false);
    this.points.set([]);
    this.error.set(null);
  }

  async finish(): Promise<void> {
    const info = this.sim.info();
    if (!info || !this.active() || this.sending()) return;
    const built = zoneCommand(this.points(), { upperM: this.upperM(), durationMin: this.durationMin(), name: this.name() }, info.limits);
    if (!built.ok) {
      this.error.set(built.error);
      return;
    }
    this.sending.set(true);
    try {
      const res = await this.sim.inject(built.command);
      const zone = res.zone;
      this.sent.set(
        zone
          ? { zoneId: zone.id, text: `${zone.name} is active from the next tick for ${this.durationMin()} min, up to ${zone.upperM} m.` }
          : null,
      );
      this.active.set(false);
      this.points.set([]);
      this.name.set('');
    } catch (e) {
      this.error.set((e as Error).message);
    } finally {
      this.sending.set(false);
    }
  }
}
