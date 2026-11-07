import { randomBytes, randomInt } from 'node:crypto';
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types';
import type * as Y from 'yjs';
import { creatorOf, withCreator, type Creator } from './creator';
import { arrowPoints, outlineOf } from './geometry';
import { fractionalIndex, indicesOver, indicesUnder } from './order';
import { DEFAULT_FONT, DEFAULT_STYLE, FONT_FAMILY, LISTED_POINTS, type BoardShape, type FontName, type Place, type Shape } from './shapes';
import { convertSkeletons, loadExcalidraw, type ConvertedElement, type Excalidraw, type Skeleton } from './skeleton';

/** The shared map that holds the board's elements by id, as the page keeps them. */
export const ELEMENTS = 'elements';

/** The kinds of shape that an arrow of add_shapes binds to. */
const BINDABLE: ReadonlySet<Shape['type']> = new Set<Shape['type']>(['rectangle', 'ellipse', 'diamond', 'text']);

/** The kinds of shape whose points get_board lists. */
const STROKES: ReadonlySet<string> = new Set(['line', 'arrow', 'freedraw']);

/** A point, as [x, y]: how far right of and below an element's x and y it lies. */
type Point = [number, number];

type Freedraw = Extract<Shape, { type: 'freedraw' }>;
type Arrow = Extract<Shape, { type: 'arrow' }>;

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
  strokeColor: string | undefined;
  backgroundColor: string | undefined;
  strokeWidth: number | undefined;
  strokeStyle: string | undefined;
  fillStyle: string | undefined;
  roughness: number | undefined;
  opacity: number | undefined;
  fontFamily: number | undefined;
  textAlign: string | undefined;
  groups: string[];
}

/**
 * The board's shapes from back to front, as get_board answers them. A text bound to a shape is
 * that shape's label, an arrow's start and end are the shapes its ends are bound to, and a shape
 * an agent added lists the agent as its creator. A shape in a group lists each group it is in, the
 * innermost first. A line's or an arrow's width and height say how
 * far its last point lies right of and below its first, which is where the pages draw it to. A
 * line, an arrow or a freehand stroke lists its points, and a stroke that holds more than
 * LISTED_POINTS lists LISTED_POINTS of them, evenly spaced, with the count of all. Each shape
 * answers its stroke and background colors, and each style field and its text's font and
 * alignment that aren't Excalidraw's defaults. Deleted elements, and values that aren't
 * elements, are left out.
 */
export function readBoard(values: Iterable<unknown>): BoardShape[] {
  const elements = new Map<string, BoardElement>();
  for (const value of values) {
    const element = boardElement(value);
    if (element !== null) elements.set(element.id, element);
  }

  const labels = new Map<string, BoardElement>();
  const labelIds = new Set<string>();
  for (const element of elements.values()) {
    if (element.type !== 'text' || element.containerId === null || element.text === undefined) continue;
    const container = elements.get(element.containerId);
    if (container === undefined || container.type === 'text') continue;
    labels.set(container.id, element);
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
    const text = element.type === 'text' ? element : labels.get(element.id);
    if (text?.text !== undefined) shape.label = text.text;
    if (element.start !== undefined && listed.has(element.start)) shape.start = element.start;
    if (element.end !== undefined && listed.has(element.end)) shape.end = element.end;
    if (element.creator !== undefined) shape.creator = element.creator;
    if (element.points !== null) Object.assign(shape, listedPoints(element.points));
    addStyle(shape, element, text);
    if (element.groups.length > 0) shape.groups = element.groups;
    return shape;
  });
}

/**
 * Sets on `shape` the stroke and background colors of `element`, each style field of `element`
 * that isn't Excalidraw's default, and the font and alignment of `text`, the element's text or its
 * label, that aren't Excalidraw's defaults: a text aligns left, and a label centers.
 */
function addStyle(shape: BoardShape, element: BoardElement, text: BoardElement | undefined): void {
  if (element.strokeColor !== undefined) shape.strokeColor = element.strokeColor;
  if (element.backgroundColor !== undefined) shape.backgroundColor = element.backgroundColor;
  if (element.strokeWidth !== undefined && element.strokeWidth !== DEFAULT_STYLE.strokeWidth) shape.strokeWidth = element.strokeWidth;
  if (element.strokeStyle !== undefined && element.strokeStyle !== DEFAULT_STYLE.strokeStyle) shape.strokeStyle = element.strokeStyle;
  if (element.fillStyle !== undefined && element.fillStyle !== DEFAULT_STYLE.fillStyle) shape.fillStyle = element.fillStyle;
  if (element.roughness !== undefined && element.roughness !== DEFAULT_STYLE.roughness) shape.roughness = element.roughness;
  if (element.opacity !== undefined && element.opacity !== DEFAULT_STYLE.opacity) shape.opacity = element.opacity;
  if (text === undefined) return;
  const font = fontName(text.fontFamily);
  if (font !== undefined && font !== DEFAULT_FONT) shape.fontFamily = font;
  const align = text === element ? 'left' : 'center';
  if (text.textAlign !== undefined && text.textAlign !== align) shape.textAlign = text.textAlign;
}

/** A random id for a new element: 20 characters of base64url, as Excalidraw's are. */
export function newId(): string {
  return randomBytes(15).toString('base64url');
}

/**
 * Adds `shapes`, in Excalidraw's skeleton format, to the board that `doc` holds, in one transaction,
 * and returns each shape's id in the order of `shapes`. The shapes go to `where` in the board's
 * stacking order, in front of every element unless `where` says otherwise, each in front of the
 * shapes before it in `shapes`, as indicesAt places them. A shape keeps the id it sets, and a shape
 * that leaves it out gets a random one. Each element it adds, a shape's label among them, records
 * `creator`, where given, as its creator, and goes into the group `group`, where given, as
 * Excalidraw groups elements. An arrow that sets start and end and none of width, height and points
 * runs between those two shapes, as laidBetween lays it out, whatever its x and y. Throws a
 * ShapeError, and adds nothing, where two shapes set one id, a shape sets an id the board holds
 * already, an arrow's start or end isn't a rectangle, an ellipse, a diamond or a text of the same
 * call, a line or an arrow sets both points and a width or a height, a closed line has fewer than
 * three points, an arrow leaves out its x or its y and doesn't run between two shapes, the two
 * shapes an arrow runs between have one center, or `where` names a shape that indicesAt refuses.
 */
export async function addShapes(
  doc: Y.Doc,
  shapes: readonly Shape[],
  creator?: Creator,
  group?: string,
  where: Place = 'front',
): Promise<string[]> {
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
    if (shape.type === 'arrow' && !between(shape) && (shape.x === undefined || shape.y === undefined)) {
      throw new ShapeError(
        `shapes[${place}] leaves out ${shape.x === undefined ? 'x' : 'y'}: an arrow needs its x and y, unless it sets start and end and none of width, height and points, so that it runs between those two shapes.`,
      );
    }
    if (shape.type === 'line' && shape.closed === true && (shape.points?.length ?? 0) < 3) {
      throw new ShapeError(
        `shapes[${place}].closed is true, and the line has fewer than three points: a closed line needs points, three or more, that enclose the shape it fills.`,
      );
    }
  });

  const excalidraw = await loadExcalidraw();
  const skeletons = shapes.map((shape, place) => skeleton(shape, ids[place], excalidraw));
  const converted = await convertSkeletons(skeletons, { regenerateIds: false });
  for (const id of ids) {
    if (!converted.some((element) => element.id === id)) {
      throw new Error(`convertToExcalidrawElements didn't make the shape ${id}: ${JSON.stringify(converted)}`);
    }
  }
  const elements = await laidBetween(shapes, ids, skeletons, converted);
  const indices = indicesAt(shared, where, elements.length);
  doc.transact(() => {
    elements.forEach((element, place) => {
      const copy = { ...structuredClone(element), index: indices[place] };
      const placed = group === undefined ? copy : { ...copy, groupIds: [group] };
      shared.set(element.id, creator === undefined ? placed : withCreator(placed, creator));
    });
  });
  return ids;
}

/**
 * The skeleton that `convertToExcalidrawElements` reads for `shape`, with the id `id`. A freehand
 * stroke's skeleton is the whole element, which convertToExcalidrawElements adds as it is. A text's
 * and a label's font is the number Excalidraw's element holds instead of the font's name. An arrow
 * that runs between its start and end, as `between` says, binds to neither here, at its x and y or
 * at 0 where it leaves them out: laidBetween lays it out and binds it once its shapes are
 * converted, since convertToExcalidrawElements moves a text that an arrow binds to by its id.
 */
function skeleton(shape: Shape, id: string, excalidraw: Excalidraw): Skeleton {
  if (shape.type === 'freedraw') return freedraw(shape, id, excalidraw) as unknown as Skeleton;
  if (shape.type === 'line') {
    const { points, closed = false, ...line } = shape;
    return { ...line, ...linear(line, points, closed), id } as unknown as Skeleton;
  }
  const font = shape.type === 'text' ? fontNumber(shape) : {};
  const label = 'label' in shape && shape.label !== undefined ? { label: { ...shape.label, ...fontNumber(shape.label) } } : {};
  if (shape.type !== 'arrow') return { ...shape, ...font, ...label, id } as unknown as Skeleton;
  const { start, end, points, ...arrow } = shape;
  const ends = between(shape)
    ? {}
    : { ...(start === undefined ? {} : { start: { id: start } }), ...(end === undefined ? {} : { end: { id: end } }) };
  return {
    ...arrow,
    ...label,
    ...linear({ ...arrow, x: arrow.x ?? 0, y: arrow.y ?? 0 }, points, false),
    id,
    ...ends,
  } as unknown as Skeleton;
}

/**
 * Whether the arrow `shape` runs between the shapes its start and end name, from the edge of one
 * to the edge of the other, as connect draws an arrow: where it sets start and end and none of
 * width, height and points.
 */
function between(shape: Shape): shape is Arrow & { start: string; end: string } {
  return (
    shape.type === 'arrow' &&
    shape.start !== undefined &&
    shape.end !== undefined &&
    shape.width === undefined &&
    shape.height === undefined &&
    shape.points === undefined
  );
}

/**
 * `elements`, which convertToExcalidrawElements made of `skeletons`, the skeletons of `shapes` with
 * the ids `ids`, with each arrow that runs between its start and end, as `between` says, laid out
 * as connect lays out its arrow: along the line between the centers of its two shapes, from GAP
 * beyond the outline of its start to GAP short of the outline of its end, bound to both, with its
 * label in its middle. The arrow and its label take the places of the ones `elements` holds, and
 * each of the two shapes lists the arrow among its bound elements. Throws a ShapeError where the
 * two shapes have one center, so that the arrow has no direction.
 */
async function laidBetween(
  shapes: readonly Shape[],
  ids: readonly string[],
  skeletons: readonly Skeleton[],
  elements: readonly ConvertedElement[],
): Promise<ConvertedElement[]> {
  let laid = [...elements];
  for (const [place, shape] of shapes.entries()) {
    if (!between(shape)) continue;
    const id = ids[place];
    const start = laid.find((element) => element.id === shape.start);
    const end = laid.find((element) => element.id === shape.end);
    if (start === undefined || end === undefined) continue;
    const segment = arrowPoints(outlineOf(start), outlineOf(end));
    if (segment === null) {
      throw new ShapeError(
        `shapes[${place}] starts at "${shape.start}" and ends at "${shape.end}", which have one center, so an arrow between them has no direction: give the arrow its x and y, and a width and a height or points.`,
      );
    }
    const { from, to } = segment;
    const arrow = {
      ...skeletons[place],
      x: from.x,
      y: from.y,
      width: Math.abs(to.x - from.x),
      height: Math.abs(to.y - from.y),
      points: [
        [0, 0],
        [to.x - from.x, to.y - from.y],
      ],
      start: { id: start.id },
      end: { id: end.id },
    };
    // Copies of the two shapes' outlines, which the converter binds the arrow to, as connect's are.
    const copies = [start, end].map((bound) => ({ ...outlineOf(bound), id: bound.id }));
    const relaid = await convertSkeletons([arrow, ...copies] as unknown as Skeleton[], { regenerateIds: false });
    laid = laid.flatMap((element): ConvertedElement[] => {
      if (element.id === id) return relaid.filter((drawn) => drawn.id === id);
      if (isLabelOf(element, id)) return relaid.filter((drawn) => isLabelOf(drawn, id));
      if (element.id !== start.id && element.id !== end.id) return [element];
      return [{ ...element, boundElements: [...(element.boundElements ?? []), { id, type: 'arrow' as const }] } as ConvertedElement];
    });
  }
  return laid;
}

/** Whether `element` is the label of the element with the id `id`. */
function isLabelOf(element: ConvertedElement, id: string): boolean {
  return element.type === 'text' && 'containerId' in element && element.containerId === id;
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

/** The number of the font that `fields` names, as Excalidraw's element holds it, where it names one. */
function fontNumber(fields: { fontFamily?: FontName }): { fontFamily?: number } {
  return fields.fontFamily === undefined ? {} : { fontFamily: FONT_FAMILY[fields.fontFamily] };
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
    strokeColor: stringOf(fields.strokeColor),
    backgroundColor: stringOf(fields.backgroundColor),
    strokeWidth: numberOf(fields.strokeWidth),
    strokeStyle: stringOf(fields.strokeStyle),
    fillStyle: stringOf(fields.fillStyle),
    roughness: numberOf(fields.roughness),
    opacity: numberOf(fields.opacity),
    fontFamily: numberOf(fields.fontFamily),
    textAlign: stringOf(fields.textAlign),
    groups: groupsOf(fields.groupIds),
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

/** The ids of the groups an element is in, as its `groupIds` lists them, the innermost first. */
export function groupsOf(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((group): group is string => typeof group === 'string') : [];
}

function numberOf(value: unknown): number | undefined {
  return finite(value) ? value : undefined;
}

/** The name of the font whose number `family` is, where Excalidraw has a font of that number. */
function fontName(family: number | undefined): FontName | undefined {
  return (Object.keys(FONT_FAMILY) as FontName[]).find((name) => FONT_FAMILY[name] === family);
}

/** The id of the element that the binding of an arrow's end names. */
export function boundTo(binding: unknown): string | undefined {
  if (typeof binding !== 'object' || binding === null) return undefined;
  return stringOf((binding as { elementId?: unknown }).elementId);
}

/**
 * `count` fractional indices, in order, for elements that go to `place` in the stacking order of
 * the board that `shared` holds: in front of every element for front, behind every element for
 * back, just below the shape that `place.below` names, or just above the shape that `place.above`
 * names and its label. The elements that `moving` names, which a move takes from where they are,
 * are passed over. Throws a ShapeError where `place` names an id that isn't a shape on the board,
 * is a label, or doesn't have an index in the board's stacking order.
 */
export function indicesAt(
  shared: Y.Map<unknown>,
  place: Place,
  count: number,
  moving: ReadonlySet<string> = new Set(),
): string[] {
  const values = [...shared.entries()].filter(([id]) => !moving.has(id)).map(([, value]) => value);
  if (place === 'front') return indicesUnder(values, null, count);
  if (place === 'back') return indicesOver(values, null, count);
  if ('below' in place) return indicesUnder(values, placedIndex(shared, 'below', place.below), count);
  return indicesOver(values, placedIndex(shared, 'above', place.above), count);
}

/**
 * The index that a place takes from the shape `id`: that shape's index for below, and the highest
 * index of that shape and its label for above. Throws a ShapeError as indicesAt says.
 */
function placedIndex(shared: Y.Map<unknown>, side: 'below' | 'above', id: string): string {
  const element = liveElement(shared.get(id));
  if (element === undefined || typeof element.type !== 'string') {
    throw new ShapeError(`place.${side} is "${id}", which isn't the id of a shape on the board: get_board lists each shape's id.`);
  }
  const containerId = element.type === 'text' ? stringOf(element.containerId) : undefined;
  const container = containerId === undefined ? undefined : liveElement(shared.get(containerId));
  if (container !== undefined && container.type !== 'text') {
    throw new ShapeError(
      `place.${side} is "${id}", the label of the shape "${containerId}", which get_board lists with its label: place the shapes ${side} "${containerId}".`,
    );
  }
  const own = fractionalIndex(element);
  if (own === null) {
    throw new ShapeError(
      `place.${side} is "${id}", which doesn't have an index in the board's stacking order: place the shapes at the front or the back.`,
    );
  }
  let index = own;
  if (side === 'above') {
    for (const value of shared.values()) {
      const label = liveElement(value);
      if (label?.type !== 'text' || label.containerId !== id) continue;
      const labelIndex = fractionalIndex(label);
      if (labelIndex !== null && labelIndex > index) index = labelIndex;
    }
  }
  return index;
}

/** `value`, an element of the board, where it is one and isn't deleted. */
function liveElement(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const element = value as Record<string, unknown>;
  return element.isDeleted === true ? undefined : element;
}

/** An element's id and its fractional index, which place it in the board's stacking order. */
export interface Stacked {
  id: string;
  index: string | null;
}

/** Back to front, as the page orders the board: by fractional index, an element without one last, then by id. */
export function backToFront(a: Stacked, b: Stacked): number {
  if (a.index !== b.index) {
    if (a.index === null) return 1;
    if (b.index === null) return -1;
    return a.index < b.index ? -1 : 1;
  }
  if (a.id === b.id) return 0;
  return a.id < b.id ? -1 : 1;
}
