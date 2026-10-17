/**
 * jsdom has no 2D canvas. Leaflet's canvas renderer only needs the calls to
 * succeed, so every context method becomes a no-op (properties stay assignable).
 */
export function stubCanvas(): void {
  const proto = HTMLCanvasElement.prototype as unknown as { getContext: () => unknown; __stubbed?: boolean };
  if (proto.__stubbed) return;
  proto.__stubbed = true;
  proto.getContext = function () {
    const store: Record<string | symbol, unknown> = { canvas: this };
    return new Proxy(store, {
      get: (t, k) => (k in t ? t[k] : () => undefined),
      set: (t, k, v) => {
        t[k] = v;
        return true;
      },
    });
  };
}
