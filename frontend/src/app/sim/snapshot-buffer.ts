/**
 * Frames received from the API, sorted by time, for interpolation and trails (pure).
 * Live steps append; history windows merge in; old frames are trimmed.
 */

import { Frame } from './sim-models';

export interface Bracket {
  a: Frame;
  b: Frame;
  /** Position of t between a.t and b.t, in [0, 1]. */
  alpha: number;
}

export class FrameBuffer {
  private frames: Frame[] = [];

  constructor(private readonly capacity = 5000) {}

  get size(): number {
    return this.frames.length;
  }

  get first(): Frame | undefined {
    return this.frames[0];
  }

  get last(): Frame | undefined {
    return this.frames[this.frames.length - 1];
  }

  clear(): void {
    this.frames = [];
  }

  /** Adds frames; a frame for a time already present replaces it (history and steps agree). */
  push(frames: readonly Frame[]): void {
    if (!frames.length) return;
    const last = this.last;
    const ordered = frames.every((f, i) => i === 0 || f.t > frames[i - 1].t);
    if (ordered && (!last || frames[0].t > last.t)) {
      this.frames.push(...frames);
    } else {
      const byTime = new Map(this.frames.map((f) => [f.t, f]));
      for (const f of frames) byTime.set(f.t, f);
      this.frames = [...byTime.values()].sort((x, y) => x.t - y.t);
    }
    if (this.frames.length > this.capacity) this.frames.splice(0, this.frames.length - this.capacity);
  }

  /** True if t lies within the buffered frames. */
  covers(t: number): boolean {
    return !!this.first && this.first.t <= t && t <= this.last!.t;
  }

  /** The two frames around t (clamped to the ends), or null when empty. */
  bracket(t: number): Bracket | null {
    const fs = this.frames;
    if (!fs.length) return null;
    if (t <= fs[0].t) return { a: fs[0], b: fs[0], alpha: 0 };
    const end = fs[fs.length - 1];
    if (t >= end.t) return { a: end, b: end, alpha: 0 };
    let lo = 0;
    let hi = fs.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (fs[mid].t <= t) lo = mid;
      else hi = mid;
    }
    const a = fs[lo];
    const b = fs[hi];
    return { a, b, alpha: (t - a.t) / (b.t - a.t) };
  }

  /** Frames with t0 <= t <= t1 (for trails). */
  between(t0: number, t1: number): Frame[] {
    return this.frames.filter((f) => f.t >= t0 && f.t <= t1);
  }

  /** Drops frames before t but keeps the last one at or before it, so bracket(t) still works. */
  trimBefore(t: number): void {
    let keep = 0;
    while (keep + 1 < this.frames.length && this.frames[keep + 1].t <= t) keep++;
    if (keep > 0) this.frames.splice(0, keep);
  }
}
