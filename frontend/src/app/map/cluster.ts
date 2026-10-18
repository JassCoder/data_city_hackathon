import * as L from 'leaflet';

/** Groups points that fall into the same screen-space cell at the current zoom. */
export function clusterPoints<T>(
  points: { lat: number; lng: number; data: T }[],
  project: (lat: number, lng: number) => { x: number; y: number },
  cellPx: number,
): { lat: number; lng: number; items: T[] }[] {
  const cells = new Map<string, { lat: number; lng: number; items: T[] }>();
  for (const p of points) {
    const { x, y } = project(p.lat, p.lng);
    const key = `${Math.floor(x / cellPx)}:${Math.floor(y / cellPx)}`;
    const c = cells.get(key);
    if (c) {
      c.items.push(p.data);
      c.lat += (p.lat - c.lat) / c.items.length; // running mean
      c.lng += (p.lng - c.lng) / c.items.length;
    } else {
      cells.set(key, { lat: p.lat, lng: p.lng, items: [p.data] });
    }
  }
  return [...cells.values()];
}

/**
 * Lightweight marker clustering (no plugin): rebuilt on zoom; below `maxClusterZoom`
 * nearby points merge into a count bubble that zooms in when clicked.
 */
export class ClusterLayer<T> extends L.LayerGroup {
  private points: { lat: number; lng: number; data: T }[] = [];
  private host?: L.Map;
  private readonly onZoom = () => this.rebuild();

  constructor(
    private readonly marker: (item: T) => L.Marker,
    private readonly opts: { cellPx?: number; maxClusterZoom?: number; className: string },
  ) {
    super();
  }

  setPoints(points: { lat: number; lng: number; data: T }[]): void {
    this.points = points;
    this.rebuild();
  }

  override onAdd(map: L.Map): this {
    super.onAdd(map);
    this.host = map;
    map.on('zoomend', this.onZoom);
    this.rebuild();
    return this;
  }

  override onRemove(map: L.Map): this {
    map.off('zoomend', this.onZoom);
    this.host = undefined;
    return super.onRemove(map);
  }

  /** Clusters currently shown (for tests and diagnostics). */
  clusterCount = 0;

  private rebuild(): void {
    this.clearLayers();
    const map = this.host;
    this.clusterCount = 0;
    if (!map) return;
    const zoom = map.getZoom();
    if (zoom >= (this.opts.maxClusterZoom ?? 15)) {
      for (const p of this.points) this.addLayer(this.marker(p.data));
      return;
    }
    const groups = clusterPoints(this.points, (lat, lng) => map.project([lat, lng], zoom), this.opts.cellPx ?? 56);
    for (const g of groups) {
      if (g.items.length === 1) {
        this.addLayer(this.marker(g.items[0]));
        continue;
      }
      this.clusterCount++;
      const size = g.items.length < 10 ? 30 : g.items.length < 100 ? 36 : 44;
      const m = L.marker([g.lat, g.lng], {
        icon: L.divIcon({
          className: '',
          html: `<div class="cluster ${this.opts.className}" style="width:${size}px;height:${size}px">${g.items.length}</div>`,
          iconSize: [size, size],
          iconAnchor: [size / 2, size / 2],
        }),
        title: `${g.items.length} locations – click to zoom in`,
      });
      m.on('click', () => map.setView([g.lat, g.lng], Math.min(zoom + 2, 18)));
      this.addLayer(m);
    }
  }
}
