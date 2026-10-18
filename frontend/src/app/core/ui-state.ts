import { Injectable, signal } from '@angular/core';

export type DrawerTab = 'route' | 'airspace';
export type SheetState = 'peek' | 'half' | 'full';

/** Layout state shared by the sidebar, map and drawer (not routing state). */
@Injectable({ providedIn: 'root' })
export class UiState {
  readonly drawerOpen = signal(false);
  readonly drawerTab = signal<DrawerTab>('route');
  /** Mobile bottom sheet position (desktop ignores it). */
  readonly sheet = signal<SheetState>('peek');
  /** One-shot request to fit a drone's route/points on the map. */
  readonly focusRequest = signal<{ droneId: string; nonce: number } | null>(null);
  private nonce = 0;

  openDetails(tab: DrawerTab = 'route'): void {
    this.drawerTab.set(tab);
    this.drawerOpen.set(true);
  }

  focusOnMap(droneId: string): void {
    this.focusRequest.set({ droneId, nonce: ++this.nonce });
  }
}
