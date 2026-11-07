import { randomBytes, randomInt } from 'node:crypto';
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types';
import type * as Y from 'yjs';
import { creatorOf, withCreator, type Creator } from './creator';
import { indicesAbove } from './order';
import { LISTED_POINTS, type BoardShape, type Shape } from './shapes';
import { convertSkeletons, loadExcalidraw, type Excalidraw, type Skeleton } from './skeleton';

/** The shared map that holds the board's elements by id, as the page keeps them. */
export const ELEMENTS = 'elements';

/** The kinds of shape that an arrow of add_shapes binds to. */
const BINDABLE: ReadonlySet<Shape['type']> = new Set<Shape['type']>(['rectangle', 'ellipse', 'diamond', 'text']);

/** The kinds of shape whose points get_board lists. */
const STROKES: ReadonlySet<string> = new Set(['line', 'arrow', 'freedraw']);

/** A point, as [x, y]: how far right of and below an element's x and y it lies. */
type Point = [number, number];

type Freedraw = Extract<Shape, { type: 'freedraw' }>;

/** A refusal of a tool's call on the board's shapes, whose message says what to change. */
export class ShapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ShapeError';
  }
}

/** The fields of an Excalidraw element that get_board reads. */
interface BoardElement {
  id: string;
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  index: string | null;
  containerId: string | null;
  text: string | undefined;
  start: string | undefined;
  end: string | undefined;
  creator: Creator | undefined;
  points: Point[] | null;
}

/**
 * The board's shapes from back to front, as get_board answers them. A text bound to a shape is
 * that shape's label, an arrow's start and end are the shapes its ends are bound to, and a shape
 * an agent added lists the agent as its creator. A line's or an arrow's width and height say how
 * far its last point lies right of and below its first, which is where the pages draw it to. A
 * line, an arrow or a freehand stroke lists its points, and a stroke that holds more than
 * LISTED_POINTS lists LISTED_POINTS of them, evenly spaced, with the count of all. Deleted
 * elements, and values that aren't elements, are left out.
 */
export function readBoard(values: Iterable<unknown>): BoardShape[] {
  const elements = new Map<string, BoardElement>();
  for (const value of values) {
    const element = boardElement(value);
    if (element !== null) elements.set(element.id, element);
  }

  const labels = new Map<string, string>();
  const labelIds = new Set<string>();
  for (const element of elements.values()) {
    if (element.type !== 'text' || element.containerId === null || element.text === undefined) continue;
    const container = elements.get(element.containerId);
    if (container === undefined || container.type === 'text') continue;
    labels.set(container.id, element.text);
    labelIds.add(element.id);
  }

  const shapes = [...elements.values()].filter((element) => !labelIds.has(element.id)).sort(backToFront);
  const listed = new Set(shapes.map((element) => element.id));
  return shapes.map((element) => {
    const shape: BoardShape = {
      id: element.id,
      kind: element.type,
      x: element.x,
      y: element.y,
      width: element.width,
      height: element.height,
    };
    const label = element.type === 'text' ? element.text : labels.get(element.id);
    if (label !== undefined) shape.label = label;
    if (element.start !== undefined && listed.has(element.start)) shape.start = element.start;
    if (element.end !== undefined && listed.has(element.end)) shape.end = element.end;
    if (element.creator !== undefined) shape.creator = element.creator;
    if (element.points !== null) Object.assign(shape, listedPoints(element.points));
    return shape;
  });
}

/** A random id for a new element: 20 characters of base64url, as Excalidraw's are. */
export function newId(): string {
  return randomBytes(15).toString('base64url');
}

/**
 * Adds `shapes`, in Excalidraw's skeleton format, to the board that `doc` holds, above every
 * element on it, in one transaction, and returns each shape's id in the order of `shapes`. A shape
 * keeps the id it sets, and a shape that leaves it out gets a random one. Each element it adds, a
 * shape's label among them, records `creator`, where given, as its creator. Throws a ShapeError,
 * and adds nothing, where two shapes set one id, a shape sets an id the board holds already, an
 * arrow's start or end isn't a rectangle, an ellipse, a diamond or a text of the same call, a line
 * or an arrow sets both points and a width or a height, or a closed line has fewer than three
 * points.
 */
export async function addShapes(doc: Y.Doc, shapes: readonly Shape[], creator?: Creator): Promise<string[]> {
  const shared = doc.getMap<unknown>(ELEMENTS);
  const ids = shapes.map((shape) => shape.id ?? newId());

  const first = new Map<string, number>();
  ids.forEach((id, place) => {
    const earlier = first.get(id);
    if (earlier !== undefined) {
      throw new ShapeError(`shapes[${place}].id is "${id}", which shapes[${earlier}] has too: give each shape its own id.`);
    }
    if (shared.has(id)) {
      throw new ShapeError(
        `shapes[${place}].id is "${id}", which a shape on the board has already, or a deleted one had: give the shape another id, or leave it out.`,
      );
    }
    first.set(id, place);
  });

  const bindable = new Set(ids.filter((_id, place) => BINDABLE.has(shapes[place].type)));
  shapes.forEach((shape, place) => {
    if (shape.type !== 'arrow') return;
    for (const end of ['start', 'end'] as const) {
      const target = shape[end];
      if (target !== undefined && !bindable.has(target)) {
        throw new ShapeError(
          `shapes[${place}].${end} is "${target}", which isn't the id of a rectangle, ellipse, diamond or text that this call adds: an arrow's start and end name shapes of the same call.`,
        );
      }
    }
  });
  shapes.forEach((shape, place) => {
    if (shape.type !== 'line' && shape.type !== 'arrow') return;
    if (shape.points !== undefined && (shape.width !== undefined || shape.height !== undefined)) {
      throw new ShapeError(
        `shapes[${place}] sets both points and ${shape.width === undefined ? 'height' : 'width'}: a line or an arrow through points gets its size from them, so leave out its width and height.`,
      );
    }
    if (shape.type === 'line' && shape.closed === true && (shape.points?.length ?? 0) < 3) {
      throw new ShapeError(
        `shapes[${place}].closed is true, and the line has fewer than three points: a closed line needs points, three or more, that enclose the shape it fills.`,
      );
    }
  });

  const excalidraw = await loadExcalidraw();
  const elements = await convertSkeletons(
    shapes.map((shape, place) => skeleton(shape, ids[place], excalidraw)),
    { regenerateIds: false },
  );
  for (const id of ids) {
    if (!elements.some((element) => element.id === id)) {
      throw new Error(`convertToExcalidrawElements didn't make the shape ${id}: ${JSON.stringify(elements)}`);
    }
  }
  const indices = indicesAbove(shared.values(), elements.length);
  doc.transact(() => {
    elements.forEach((element, place) => {
      const copy = { ...structuredClone(element), index: indices[place] };
      shared.set(element.id, creator === undefined ? copy : withCreator(copy, creator));
    });
  });
  return ids;
}

/**
 * The skeleton that `convertToExcalidrawElements` reads for `shape`, with the id `id`. A freehand
 * stroke's skeleton is the whole element, which convertToExcalidrawElements adds as it is.
 */
function skeleton(shape: Shape, id: string, excalidraw: Excalidraw): Skeleton {
  if (shape.type === 'freedraw') return freedraw(shape, id, excalidraw) as unknown as Skeleton;
  if (shape.type === 'line') {
    const { points, closed = false, ...line } = shape;
    return { ...line, ...linear(line, points, closed), id } as unknown as Skeleton;
  }
  if (shape.type !== 'arrow') return { ...shape, id } as unknown as Skeleton;
  const { start, end, points, ...arrow } = shape;
  return {
    ...arrow,
    ...linear(arrow, points, false),
    id,
    ...(start === undefined ? {} : { start: { id: start } }),
    ...(end === undefined ? {} : { end: { id: end } }),
  } as unknown as Skeleton;
}

/** The width and height that convertToExcalidrawElements uses for a line or an arrow that leaves either out. */
const DEFAULT_LINE = { width: 100, height: 0 };

/** Where a line, an arrow or a freehand stroke goes, as Excalidraw keeps it. */
interface Placed {
  /** The x and y of its first point. */
  x: number;
  y: number;
  /** The size of its points' bounds. */
  width: number;
  height: number;
  /** Its points, each from its first, which is [0, 0]. */
  points: Point[];
}

/**
 * Where the line or the arrow `shape` goes. Through `points`, where it sets them, and back to its
 * first point where `closed` is true and the last point isn't the first, so that Excalidraw reads
 * the line as a loop, which its background color fills. Otherwise straight, to `width` right of
 * its first point and `height` below it, with Excalidraw's default for each one left out.
 * convertToExcalidrawElements reads a width or a height of 0 as left out: it would draw a line of
 * width 0 to a point 100 right of its first point, while the element keeps width 0. The points
 * say where the line goes, and the width and height are the size of their bounds, as Excalidraw
 * keeps them.
 */
function linear(
  shape: { x: number; y: number; width?: number; height?: number },
  points: readonly (readonly number[])[] | undefined,
  closed: boolean,
): Placed {
  if (points === undefined) {
    const { width = DEFAULT_LINE.width, height = DEFAULT_LINE.height } = shape;
    return {
      x: shape.x,
      y: shape.y,
      width: Math.abs(width),
      height: Math.abs(height),
      points: [
        [0, 0],
        [width, height],
      ],
    };
  }
  const line = placed(shape.x, shape.y, points);
  const [lastX, lastY] = line.points[line.points.length - 1];
  if (closed && (lastX !== 0 || lastY !== 0)) line.points.push([0, 0]);
  return line;
}

/**
 * Where a shape through `points`, each [x, y] from `x` and `y`, goes, as Excalidraw keeps a line,
 * an arrow or a freehand stroke: its x and y move to its first point, and its points are each
 * from that one.
 */
function placed(x: number, y: number, points: readonly (readonly number[])[]): Placed {
  const [firstX, firstY] = points[0];
  const moved = points.map(([pointX, pointY]): Point => [pointX - firstX, pointY - firstY]);
  let left = 0;
  let top = 0;
  let right = 0;
  let bottom = 0;
  for (const [pointX, pointY] of moved) {
    left = Math.min(left, pointX);
    top = Math.min(top, pointY);
    right = Math.max(right, pointX);
    bottom = Math.max(bottom, pointY);
  }
  return { x: x + firstX, y: y + firstY, width: right - left, height: bottom - top, points: moved };
}

/**
 * The freehand stroke `shape`, with the id `id`, as a whole element: convertToExcalidrawElements
 * adds a freehand stroke as it is, so restoreElements fills in each field the stroke leaves out.
 * The stroke simulates the pen's pressure, as a stroke of the mouse does, and has a random seed,
 * as each new element of Excalidraw's has, where restoreElements would set the seed 1.
 */
function freedraw(shape: Freedraw, id: string, { restoreElements }: Excalidraw): ExcalidrawElement {
  const { points, ...stroke } = shape;
  const partial = {
    ...stroke,
    ...placed(stroke.x, stroke.y, points),
    id,
    pressures: [],
    simulatePressure: true,
    seed: randomInt(2 ** 31),
  };
  const element = restoreElements([partial as unknown as ExcalidrawElement], null).find((candidate) => candidate.id === id);
  if (element === undefined || element.type !== 'freedraw') {
    throw new Error(`restoreElements didn't make the freehand stroke ${id}: ${JSON.stringify(partial)}`);
  }
  return element;
}

function boardElement(value: unknown): BoardElement | null {
  if (typeof value !== 'object' || value === null) return null;
  const fields = value as Record<string, unknown>;
  const { id, type, x, y, width, height } = fields;
  if (fields.isDeleted === true || typeof id !== 'string' || typeof type !== 'string') return null;
  if (!finite(x) || !finite(y) || !finite(width) || !finite(height)) return null;
  const drawn = type === 'line' || type === 'arrow' ? offsetOf(fields.points) : null;
  return {
    id,
    type,
    x,
    y,
    width: drawn?.width ?? width,
    height: drawn?.height ?? height,
    index: typeof fields.index === 'string' ? fields.index : null,
    containerId: typeof fields.containerId === 'string' ? fields.containerId : null,
    text: stringOf(fields.originalText) ?? stringOf(fields.text),
    start: boundTo(fields.startBinding),
    end: boundTo(fields.endBinding),
    creator: creatorOf(value),
    points: STROKES.has(type) ? pointsOf(fields.points) : null,
  };
}

/**
 * How far the last of `points` lies right of and below the first, which is where Excalidraw draws
 * a line or an arrow to, whatever its width and height fields say; null where `points` doesn't
 * hold two points.
 */
function offsetOf(points: unknown): { width: number; height: number } | null {
  if (!Array.isArray(points) || points.length < 2) return null;
  const first = pointOf(points[0]);
  const last = pointOf(points[points.length - 1]);
  if (first === null || last === null) return null;
  return { width: last[0] - first[0], height: last[1] - first[1] };
}

/** A point of a line, an arrow or a freehand stroke, as Excalidraw holds it. */
function pointOf(value: unknown): Point | null {
  if (!Array.isArray(value)) return null;
  const [x, y]: unknown[] = value;
  return finite(x) && finite(y) ? [x, y] : null;
}

/**
 * The points of a line, an arrow or a freehand stroke, as Excalidraw holds them; null where it
 * holds none, or one of them isn't a point.
 */
function pointsOf(value: unknown): Point[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const points = (value as unknown[]).map((point) => pointOf(point));
  return points.every((point): point is Point => point !== null) ? points : null;
}

/**
 * The points get_board lists of a stroke that holds `points`: all of them, or, where it holds more
 * than LISTED_POINTS, LISTED_POINTS of them, evenly spaced from its first to its last, with the
 * count of all.
 */
function listedPoints(points: Point[]): Pick<BoardShape, 'points' | 'pointCount'> {
  if (points.length <= LISTED_POINTS) return { points };
  const last = points.length - 1;
  return {
    points: Array.from({ length: LISTED_POINTS }, (_, place) => points[Math.round((place * last) / (LISTED_POINTS - 1))]),
    pointCount: points.length,
  };
}

export function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

export function stringOf(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** The id of the element that the binding of an arrow's end names. */
export function boundTo(binding: unknown): string | undefined {
  if (typeof binding !== 'object' || binding === null) return undefined;
  return stringOf((binding as { elementId?: unknown }).elementId);
}

/** Back to front, as the page orders the board: by fractional index, an element without one last, then by id. */
function backToFront(a: BoardElement, b: BoardElement): number {
  if (a.index !== b.index) {
    if (a.index === null) return 1;
    if (b.index === null) return -1;
    return a.index < b.index ? -1 : 1;
  }
  if (a.id === b.id) return 0;
  return a.id < b.id ? -1 : 1;
}
