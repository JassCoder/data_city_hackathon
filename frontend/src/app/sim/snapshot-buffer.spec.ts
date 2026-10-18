import { cruiseFrame } from '../../testing/sim-fixtures';
import { FrameBuffer } from './snapshot-buffer';

const times = (b: FrameBuffer, t0 = -Infinity, t1 = Infinity) => b.between(t0, t1).map((f) => f.t);

describe('FrameBuffer', () => {
  it('appends frames in time order', () => {
    const b = new FrameBuffer();
    expect(b.bracket(5)).toBeNull();
    b.push([cruiseFrame(0), cruiseFrame(5)]);
    b.push([cruiseFrame(10)]);
    expect(times(b)).toEqual([0, 5, 10]);
    expect(b.first?.t).toBe(0);
    expect(b.last?.t).toBe(10);
  });

  it('merges out-of-order and overlapping frames; a newer copy of a time replaces the old one', () => {
    const b = new FrameBuffer();
    b.push([cruiseFrame(10), cruiseFrame(20)]);
    b.push([cruiseFrame(0), cruiseFrame(10, 5), cruiseFrame(15)]);
    expect(times(b)).toEqual([0, 10, 15, 20]);
    expect(b.between(10, 10)[0]).toEqual(cruiseFrame(10, 5));
  });

  it('finds the frames around a time, clamped at both ends', () => {
    const b = new FrameBuffer();
    b.push([cruiseFrame(0), cruiseFrame(4), cruiseFrame(8)]);
    const mid = b.bracket(5)!;
    expect([mid.a.t, mid.b.t]).toEqual([4, 8]);
    expect(mid.alpha).toBeCloseTo(0.25);
    expect(b.bracket(4)).toMatchObject({ alpha: 0 });
    expect(b.bracket(4)!.a.t).toBe(4);
    expect(b.bracket(-3)).toMatchObject({ alpha: 0, a: { t: 0 }, b: { t: 0 } });
    expect(b.bracket(99)).toMatchObject({ alpha: 0, a: { t: 8 }, b: { t: 8 } });
    expect(b.covers(8)).toBe(true);
    expect(b.covers(8.1)).toBe(false);
  });

  it('trims old frames but keeps the one the playhead still interpolates from', () => {
    const b = new FrameBuffer();
    b.push([0, 2, 4, 6, 8].map((t) => cruiseFrame(t)));
    b.trimBefore(5);
    expect(times(b)).toEqual([4, 6, 8]);
    b.trimBefore(0);
    expect(times(b)).toEqual([4, 6, 8]);
    expect(b.bracket(5)!.a.t).toBe(4);
  });

  it('keeps at most `capacity` frames (the newest)', () => {
    const b = new FrameBuffer(3);
    b.push([0, 1, 2, 3, 4].map((t) => cruiseFrame(t)));
    expect(times(b)).toEqual([2, 3, 4]);
    b.clear();
    expect(b.size).toBe(0);
  });
});
