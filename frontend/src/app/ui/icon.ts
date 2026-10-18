import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

/** Stroke icons on a 24 px grid (inline SVG, no icon font). */
export const ICON_PATHS = {
  plus: 'M12 5v14M5 12h14',
  close: 'M6 6l12 12M18 6L6 18',
  refresh: 'M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7',
  swap: 'M7 4v16M7 4L3 8M7 4l4 4M17 20V4M17 20l-4-4M17 20l4-4',
  crosshair: 'M12 3v4M12 17v4M3 12h4M17 12h4M12 8a4 4 0 1 0 0 8a4 4 0 1 0 0-8',
  trash: 'M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3',
  copy: 'M9 9h11v11H9zM5 15H4V4h11v1',
  eye: 'M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12zM12 9a3 3 0 1 0 0 6a3 3 0 1 0 0-6',
  eyeOff: 'M3 3l18 18M10.6 5.1A10 10 0 0 1 12 5c6.4 0 10 7 10 7a17 17 0 0 1-3.2 4.2M6.6 6.6A17 17 0 0 0 2 12s3.6 7 10 7a9.7 9.7 0 0 0 5.4-1.6M9.9 9.9a3 3 0 0 0 4.2 4.2',
  target: 'M12 2v3M12 19v3M2 12h3M19 12h3M12 7a5 5 0 1 0 0 10a5 5 0 1 0 0-10M12 11a1 1 0 1 0 0 2a1 1 0 1 0 0-2',
  edit: 'M4 20h4L19 9l-4-4L4 16zM14 6l4 4',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  layers: 'M12 3l9 5-9 5-9-5zM3 13l9 5 9-5M3 17.5l9 5 9-5',
  legend: 'M4 6h2M10 6h10M4 12h2M10 12h10M4 18h2M10 18h10',
  chevronDown: 'M6 9l6 6 6-6',
  chevronUp: 'M6 15l6-6 6 6',
  chevronRight: 'M9 6l6 6-6 6',
  alert: 'M12 3l10 18H2zM12 10v5M12 18h.01',
  info: 'M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18M12 11v6M12 7.5h.01',
  check: 'M5 12l5 5 9-10',
  route: 'M6 19a2 2 0 1 0 0-4a2 2 0 1 0 0 4M18 9a2 2 0 1 0 0-4a2 2 0 1 0 0 4M6 15V9a3 3 0 0 1 3-3h7M18 9v6a3 3 0 0 1-3 3H8',
  expand: 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5',
  pin: 'M12 21s-7-6.2-7-11.5A7 7 0 0 1 19 9.5C19 14.8 12 21 12 21zM12 7a2.5 2.5 0 1 0 0 5a2.5 2.5 0 1 0 0-5',
  play: 'M7 4.5v15l12-7.5z',
  pause: 'M8 5v14M16 5v14',
  stepForward: 'M6 5v14l9-7zM18 5v14',
  wind: 'M3 8h10a3 3 0 1 0-3-3M3 12h15a3 3 0 1 1-3 3M3 16h7',
  polygon: 'M5 8l7-5 8 6-3 11H7z',
  zap: 'M13 2L4 14h7l-1 8 9-12h-7z',
  battery: 'M3 8h15v8H3zM21 11v2',
  stop: 'M6 6h12v12H6z',
  drive: 'M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18M12 10a2 2 0 1 0 0 4a2 2 0 1 0 0-4M3.5 10.5l6.6 1M13.9 11.5l6.6-1M12 14v7',
  drone: 'M5 5a2 2 0 1 0 0 .01M19 5a2 2 0 1 0 0 .01M5 19a2 2 0 1 0 0 .01M19 19a2 2 0 1 0 0 .01M7 7l3 3M17 7l-3 3M7 17l3-3M17 17l-3-3M10 10h4v4h-4z',
} as const;

export type IconName = keyof typeof ICON_PATHS;

/** SVG markup for Leaflet DOM (outside Angular templates). */
export function iconSvg(name: IconName, cls = 'icon'): string {
  return `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="${ICON_PATHS[name]}"/></svg>`;
}

@Component({
  selector: 'app-icon',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { style: 'display: contents' },
  template: `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path [attr.d]="d()" /></svg>`,
})
export class IconComponent {
  readonly name = input.required<IconName>();
  protected readonly d = computed(() => ICON_PATHS[this.name()]);
}
