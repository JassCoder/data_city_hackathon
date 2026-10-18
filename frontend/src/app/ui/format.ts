/** Number formatting for the UI (Intl, not hand-built strings). */

const km = new Intl.NumberFormat('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const whole = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 0 });
const oneDecimal = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 1 });

export function formatDistance(m: number | null | undefined): string {
  if (m === null || m === undefined) return '—';
  return m >= 1000 ? `${km.format(m / 1000)} km` : `${whole.format(m)} m`;
}

export function formatDuration(s: number | null | undefined): string {
  if (s === null || s === undefined) return '—';
  const total = Math.round(s);
  const min = Math.floor(total / 60);
  return min ? `${min} min ${String(total % 60).padStart(2, '0')} s` : `${total} s`;
}

export function formatNumber(v: number | null | undefined, decimals: 0 | 1 = 1): string {
  if (v === null || v === undefined) return '—';
  return (decimals ? oneDecimal : whole).format(v);
}
