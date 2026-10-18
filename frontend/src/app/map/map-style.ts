/**
 * Map visual language. Leaflet writes colours as SVG/canvas attributes (CSS variables
 * do not resolve there), so the map palette lives here; the UI chrome uses
 * styles/tokens.scss.
 *
 * Airspace follows aeronautical-chart conventions: what a zone means for the
 * selected flight is shown by colour AND by a fill pattern, a border style and a
 * glyph shape, so it stays readable without colour vision.
 */

import type { ZoneEvaluation } from '../core/airspace';

export const MAP_COLORS = {
  river: '#4a90c8',
  park: '#5a9e5f',
  building: '#9aa3ab',
  tallBuilding: '#3d4a55',
  city: '#263238',
  district: '#6b77a8',
  extent: '#455a64',
  routeStale: '#7b8790',
  halo: '#ffffff',
} as const;

export type ZoneKind = 'prohibited' | 'conditional' | 'unverified' | 'info' | 'inactive';

export interface ZoneKindStyle {
  /** Legend / chip label. */
  label: string;
  /** What it means for the selected flight, in plain words. */
  meaning: string;
  color: string;
  /** SVG pattern id (inside the zone renderer), or null for no fill. */
  pattern: string | null;
  /** Routing treats it as a hard obstacle (plus the 20 m safety margin). */
  obstacle: boolean;
  border: 'ticked' | 'solid' | 'thin' | 'dashed';
}

export const ZONE_KINDS: Record<ZoneKind, ZoneKindStyle> = {
  prohibited: {
    label: 'Prohibited',
    meaning: 'Blocked for this flight. Routes always go around it.',
    color: '#c62828',
    pattern: 'zp-prohibited',
    obstacle: true,
    border: 'ticked',
  },
  conditional: {
    label: 'Authorization or conditions required',
    meaning: 'Needs an authorization or conditions this planner cannot verify, so routes go around it.',
    color: '#c46a00',
    pattern: 'zp-conditional',
    obstacle: true,
    border: 'ticked',
  },
  unverified: {
    label: 'Unverified data',
    meaning: 'Its rules could not be verified, so routes avoid it to be safe.',
    color: '#5f6b76',
    pattern: 'zp-unverified',
    obstacle: true,
    border: 'solid',
  },
  info: {
    label: 'Information',
    meaning: 'Information only. Routes may cross it; read the conditions.',
    color: '#4f6d8f',
    pattern: null,
    obstacle: false,
    border: 'thin',
  },
  inactive: {
    label: 'Not active for this flight',
    meaning: 'Not active at this altitude or time. It does not affect this route.',
    color: '#8a949e',
    pattern: null,
    obstacle: false,
    border: 'dashed',
  },
};

export const ZONE_KIND_ORDER: ZoneKind[] = ['prohibited', 'conditional', 'unverified', 'info', 'inactive'];

/** Visual kind from the backend evaluation for the selected flight. */
export function zoneKind(e: ZoneEvaluation): ZoneKind {
  switch (e.status) {
    case 'BLOCKED':
      return 'prohibited';
    case 'UNAVAILABLE_AUTHORIZATION':
    case 'UNAVAILABLE_TECHNICAL':
    case 'UNAVAILABLE_USPACE':
      return 'conditional';
    case 'UNVERIFIED':
      return 'unverified';
    case 'INFORMATION':
      return e.isObstacle ? 'conditional' : 'info';
    default:
      return 'inactive';
  }
}

/** Path style for the zone polygon (fill = pattern). */
export function zonePathStyle(kind: ZoneKind, highlighted = false) {
  const k = ZONE_KINDS[kind];
  const base = {
    color: k.color,
    fillColor: k.pattern ? `url(#${k.pattern})` : 'transparent',
    fillOpacity: 1,
    opacity: 1,
  };
  if (highlighted) return { ...base, weight: 5, dashArray: undefined as string | undefined };
  switch (k.border) {
    case 'ticked':
    case 'solid':
      return { ...base, weight: 2, dashArray: undefined as string | undefined };
    case 'thin':
      return { ...base, weight: 1.5, dashArray: undefined as string | undefined };
    default:
      return { ...base, weight: 1.5, dashArray: '5 5' };
  }
}

/** Chart-style tick marks along the border of zones a route must not enter. */
export function zoneTickStyle(kind: ZoneKind) {
  return { color: ZONE_KINDS[kind].color, weight: 7, opacity: 0.55, dashArray: '1.5 6', fill: false, interactive: false };
}

/** <defs> for the zone fill patterns. Inserted ONCE into the document (MapComponent);
 * the zone renderer and the legend swatches reference them by id. */
export function zonePatternDefs(): string {
  const p = ZONE_KINDS;
  return `
    <pattern id="zp-prohibited" patternUnits="userSpaceOnUse" width="9" height="9" patternTransform="rotate(45)">
      <rect width="9" height="9" fill="${p.prohibited.color}" fill-opacity="0.08"/>
      <rect width="2.5" height="9" fill="${p.prohibited.color}" fill-opacity="0.5"/>
    </pattern>
    <pattern id="zp-conditional" patternUnits="userSpaceOnUse" width="10" height="10">
      <rect width="10" height="10" fill="${p.conditional.color}" fill-opacity="0.07"/>
      <circle cx="5" cy="5" r="1.8" fill="${p.conditional.color}" fill-opacity="0.75"/>
    </pattern>
    <pattern id="zp-unverified" patternUnits="userSpaceOnUse" width="8" height="8">
      <rect width="8" height="8" fill="${p.unverified.color}" fill-opacity="0.08"/>
      <path d="M0 8L8 0M0 0L8 8" stroke="${p.unverified.color}" stroke-opacity="0.5" stroke-width="1.2"/>
    </pattern>`;
}

/** Glyph shape + symbol per kind (no glyph for inactive zones). */
export function zoneGlyphSvg(kind: ZoneKind, size = 22): string {
  const c = ZONE_KINDS[kind].color;
  const shapes: Record<ZoneKind, string> = {
    prohibited: `<circle cx="12" cy="12" r="10" fill="#fff" stroke="${c}" stroke-width="2.5"/><rect x="6" y="10.5" width="12" height="3" fill="${c}"/>`,
    conditional: `<path d="M12 2.5L22 20.5H2z" fill="#fff" stroke="${c}" stroke-width="2.2" stroke-linejoin="round"/><path d="M12 9v5.5M12 17.2v.3" stroke="${c}" stroke-width="2.4" stroke-linecap="round"/>`,
    unverified: `<rect x="2.5" y="2.5" width="19" height="19" rx="3" fill="#fff" stroke="${c}" stroke-width="2.2"/><path d="M9.3 9.4a2.8 2.8 0 1 1 3.9 2.6c-.8.4-1.2 1-1.2 1.8M12 16.8v.3" stroke="${c}" stroke-width="2.2" fill="none" stroke-linecap="round"/>`,
    info: `<circle cx="12" cy="12" r="9.5" fill="#fff" stroke="${c}" stroke-width="2"/><path d="M12 10.5v6M12 7.4v.3" stroke="${c}" stroke-width="2.4" stroke-linecap="round"/>`,
    inactive: '',
  };
  return shapes[kind]
    ? `<svg viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true">${shapes[kind]}</svg>`
    : '';
}

/** Small legend swatch showing the pattern and border of a kind. */
export function zoneSwatchSvg(kind: ZoneKind): string {
  const k = ZONE_KINDS[kind];
  const dash = k.border === 'dashed' ? 'stroke-dasharray="3 3"' : '';
  const ticks =
    k.border === 'ticked'
      ? `<rect x="2" y="2" width="24" height="14" rx="1" fill="none" stroke="${k.color}" stroke-width="5" stroke-opacity="0.5" stroke-dasharray="1.2 4"/>`
      : '';
  return `<svg viewBox="0 0 28 18" width="28" height="18" aria-hidden="true">
    <rect x="2" y="2" width="24" height="14" rx="1" fill="${k.pattern ? `url(#${k.pattern})` : 'none'}"
          stroke="${k.color}" stroke-width="${k.border === 'thin' || k.border === 'dashed' ? 1.5 : 2}" ${dash}/>${ticks}
  </svg>`;
}
