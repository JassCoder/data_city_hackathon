import type { MultiPolygon, Polygon } from 'geojson';
import { containsPoint } from './geo';

const square: Polygon = { type: 'Polygon', coordinates: [[[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]] };
const withHole: Polygon = {
  type: 'Polygon',
  coordinates: [square.coordinates[0], [[4, 4], [6, 4], [6, 6], [4, 6], [4, 4]]],
};
// L-shape: inside its bounding box but outside the polygon at (8, 8).
const lShape: Polygon = { type: 'Polygon', coordinates: [[[0, 0], [10, 0], [10, 5], [5, 5], [5, 10], [0, 10], [0, 0]]] };
const multi: MultiPolygon = { type: 'MultiPolygon', coordinates: [square.coordinates, [[[20, 20], [30, 20], [30, 30], [20, 20]]]] };

const at = (longitude: number, latitude: number) => ({ longitude, latitude });

describe('containsPoint', () => {
  it('handles simple polygons', () => {
    expect(containsPoint(square, at(5, 5))).toBe(true);
    expect(containsPoint(square, at(11, 5))).toBe(false);
  });

  it('is a real polygon test, not a bounding box test', () => {
    expect(containsPoint(lShape, at(2, 8))).toBe(true);
    expect(containsPoint(lShape, at(8, 8))).toBe(false);
  });

  it('excludes holes', () => {
    expect(containsPoint(withHole, at(5, 5))).toBe(false);
    expect(containsPoint(withHole, at(2, 2))).toBe(true);
  });

  it('supports MultiPolygons and missing geometry', () => {
    expect(containsPoint(multi, at(28, 22))).toBe(true);
    expect(containsPoint(multi, at(15, 15))).toBe(false);
    expect(containsPoint(null, at(5, 5))).toBe(false);
  });
});
