import { describe, expect, it } from 'vitest';
import { arrowPoints, boardPoints, centerOf, GAP, reach, type Outline, type Point } from './geometry';

function outline(type: Outline['type'], x: number, y: number, width: number, height: number, angle = 0): Outline {
  return { type, x, y, width, height, angle };
}

function expectPoint(actual: Point | undefined, expected: Point): void {
  expect(actual?.x).toBeCloseTo(expected.x, 9);
  expect(actual?.y).toBeCloseTo(expected.y, 9);
}

describe('reach', () => {
  const box = outline('rectangle', 0, 0, 100, 50);

  it("reaches a rectangle's sides and corners", () => {
    expect(reach(box, 1, 0)).toBeCloseTo(50, 9);
    expect(reach(box, 0, -3)).toBeCloseTo(25, 9);
    expect(reach(box, 1, 1)).toBeCloseTo(25 * Math.SQRT2, 9);
  });

  it("reaches an ellipse's and a diamond's outline", () => {
    expect(reach(outline('ellipse', 0, 0, 100, 50), 1, 1)).toBeCloseTo(Math.sqrt(1000), 9);
    expect(reach(outline('diamond', 0, 0, 100, 100), -1, 1)).toBeCloseTo(25 * Math.SQRT2, 9);
  });

  it("turns the direction into a rotated shape's own frame", () => {
    expect(reach(outline('rectangle', 0, 0, 100, 50, Math.PI / 2), 1, 0)).toBeCloseTo(25, 9);
  });

  it('is 0 for a shape without a size, and for a direction of no length', () => {
    expect(reach(outline('rectangle', 0, 0, 0, 50), 1, 0)).toBe(0);
    expect(reach(box, 0, 0)).toBe(0);
  });
});

describe('arrowPoints', () => {
  const box = outline('rectangle', 0, 0, 100, 50);

  it('runs between two centers, GAP beyond each outline', () => {
    expect(GAP).toBe(5);
    const segment = arrowPoints(box, outline('ellipse', 300, 0, 100, 50));
    expectPoint(segment?.from, { x: 105, y: 25 });
    expectPoint(segment?.to, { x: 295, y: 25 });
  });

  it('starts at a free point itself', () => {
    const segment = arrowPoints({ x: -100, y: 25 }, box);
    expectPoint(segment?.from, { x: -100, y: 25 });
    expectPoint(segment?.to, { x: -5, y: 25 });
  });

  it('runs from center to center between shapes that overlap', () => {
    const segment = arrowPoints(box, outline('rectangle', 60, 0, 100, 50));
    expectPoint(segment?.from, { x: 50, y: 25 });
    expectPoint(segment?.to, { x: 110, y: 25 });
  });

  it('is null between two shapes of one center', () => {
    expect(arrowPoints(box, outline('rectangle', 25, 0, 50, 50))).toBeNull();
  });
});

describe('centerOf and boardPoints', () => {
  it("is a shape's center, or the point itself", () => {
    expect(centerOf(outline('diamond', 10, 20, 100, 50))).toEqual({ x: 60, y: 45 });
    expect(centerOf({ x: 3, y: 4 })).toEqual({ x: 3, y: 4 });
  });

  it("places a line's points from its x and y", () => {
    const [first, last] = boardPoints({ x: 10, y: 20 }, [
      [0, 0],
      [30, 40],
    ], 0);
    expectPoint(first, { x: 10, y: 20 });
    expectPoint(last, { x: 40, y: 60 });
  });

  it("rotates a line's points about the middle of their bounds", () => {
    const [first, last] = boardPoints({ x: 0, y: 0 }, [
      [0, 0],
      [100, 0],
    ], Math.PI / 2);
    expectPoint(first, { x: 50, y: -50 });
    expectPoint(last, { x: 50, y: 50 });
  });
});
