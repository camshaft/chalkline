// The geometry of an arrow between two shapes: it runs along the line between their centers, and
// stops GAP short of each shape's outline, as Excalidraw draws an arrow bound to a shape.

/** A point on the board. */
export interface Point {
  x: number;
  y: number;
}

/** The outline of a shape that an arrow binds to; any shape other than an ellipse or a diamond counts as a rectangle. */
export interface Outline {
  type: 'rectangle' | 'ellipse' | 'diamond';
  x: number;
  y: number;
  width: number;
  height: number;
  /** The shape's rotation about its center, in radians, as Excalidraw's `angle` holds it. */
  angle: number;
}

/** One end of an arrow: the outline of the shape it is bound to, or a point on the board where it is free. */
export type End = Outline | Point;

/** A straight arrow, from its first point to its last. */
export interface Segment {
  from: Point;
  to: Point;
}

/** How far short of a shape's outline the end of an arrow bound to it stops. */
export const GAP = 5;

/** The fields of an element of the board that its outline reads. */
export interface Shaped {
  type?: unknown;
  x?: unknown;
  y?: unknown;
  width?: unknown;
  height?: unknown;
  angle?: unknown;
}

/**
 * The outline that an arrow bound to `shape`, an element of the board, stops short of: an
 * ellipse's or a diamond's for those, and a rectangle's for any other kind of shape, with each of
 * its x, y, width, height and angle that isn't a finite number read as 0.
 */
export function outlineOf(shape: Shaped): Outline {
  const type: Outline['type'] = shape.type === 'ellipse' ? 'ellipse' : shape.type === 'diamond' ? 'diamond' : 'rectangle';
  return {
    type,
    x: numberOf(shape.x),
    y: numberOf(shape.y),
    width: numberOf(shape.width),
    height: numberOf(shape.height),
    angle: numberOf(shape.angle),
  };
}

/** The center of a shape's outline, or the point itself. */
export function centerOf(end: End): Point {
  return isOutline(end) ? { x: end.x + end.width / 2, y: end.y + end.height / 2 } : { x: end.x, y: end.y };
}

/**
 * How far the outline of `outline` lies from its center in the direction (dx, dy) on the board: 0
 * for a shape without a width or a height, and for a direction of no length.
 */
export function reach(outline: Outline, dx: number, dy: number): number {
  const length = Math.hypot(dx, dy);
  const halfWidth = outline.width / 2;
  const halfHeight = outline.height / 2;
  if (length === 0 || !(halfWidth > 0) || !(halfHeight > 0)) return 0;
  // The direction in the shape's own frame, before its rotation.
  const cos = Math.cos(outline.angle);
  const sin = Math.sin(outline.angle);
  const across = Math.abs((dx * cos + dy * sin) / length);
  const down = Math.abs((-dx * sin + dy * cos) / length);
  switch (outline.type) {
    case 'ellipse':
      return 1 / Math.hypot(across / halfWidth, down / halfHeight);
    case 'diamond':
      return 1 / (across / halfWidth + down / halfHeight);
    case 'rectangle':
      return Math.min(across > 0 ? halfWidth / across : Infinity, down > 0 ? halfHeight / down : Infinity);
  }
}

/**
 * The straight arrow from `start` to `end`: along the line between their centers, from GAP beyond
 * the outline of the shape it starts at to GAP short of the outline of the shape it ends at, and
 * from or to the point itself at a free end. Where the shapes overlap, so that those cuts leave
 * nothing between them, it runs from center to center; where the two centers are one point, it has
 * no direction, and the answer is null.
 */
export function arrowPoints(start: End, end: End): Segment | null {
  const from = centerOf(start);
  const to = centerOf(end);
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = Math.hypot(dx, dy);
  if (length === 0) return null;
  const startCut = isOutline(start) ? reach(start, dx, dy) + GAP : 0;
  const endCut = isOutline(end) ? reach(end, -dx, -dy) + GAP : 0;
  if (startCut + endCut >= length) return { from, to };
  return {
    from: { x: from.x + (dx / length) * startCut, y: from.y + (dy / length) * startCut },
    to: { x: to.x - (dx / length) * endCut, y: to.y - (dy / length) * endCut },
  };
}

/**
 * The board positions of the points of an arrow or a line whose first point is relative to
 * `origin`, its x and y, and which is rotated by `angle` about the middle of its points' bounds, as
 * Excalidraw rotates a linear element.
 */
export function boardPoints(origin: Point, points: readonly (readonly [number, number])[], angle: number): Point[] {
  if (points.length === 0) return [];
  const xs = points.map(([x]) => x);
  const ys = points.map(([, y]) => y);
  const middle = {
    x: origin.x + (Math.min(...xs) + Math.max(...xs)) / 2,
    y: origin.y + (Math.min(...ys) + Math.max(...ys)) / 2,
  };
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return points.map(([px, py]) => {
    const x = origin.x + px - middle.x;
    const y = origin.y + py - middle.y;
    return { x: middle.x + x * cos - y * sin, y: middle.y + x * sin + y * cos };
  });
}

function isOutline(end: End): end is Outline {
  return 'type' in end;
}

function numberOf(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}
