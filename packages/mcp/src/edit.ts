// The agent's edits of shapes that are on the board already: connect draws an arrow bound to two
// of them, update_shape moves, resizes, relabels or recolors one, or moves a group of them,
// delete_shapes deletes some, by their ids or by their groups, reorder_shapes moves some forward
// or back, and scale_shapes makes some smaller or larger, by their ids or by their groups.
// Each reads the board as chalkline-mcp's copy holds it, and writes its change in one transaction,
// which reaches the page as any change of the board does. Each element a change writes records
// the agent whose call makes it, where the server passes that agent, as the author of the
// element's new version, with creator.ts's change mark.
import { randomInt } from 'node:crypto';
import type * as Y from 'yjs';
import {
  backToFront,
  boundTo,
  ELEMENTS,
  finite,
  groupsOf,
  indicesAt,
  newId,
  readBoard,
  ShapeError,
  stringOf,
  type Stacked,
} from './board';
import { withChange, withCreator, type Creator } from './creator';
import { arrowPoints, boardPoints, outlineOf, type Point } from './geometry';
import { indicesAbove } from './order';
import type { BoardShape, Connection, Place, Scaling, ShapeChange } from './shapes';
import { convertSkeletons, type Skeleton } from './skeleton';

/** An Excalidraw element, as the board's shared map holds it. */
type Element = Record<string, unknown>;

/** A label in Excalidraw's skeleton format, with the id its text element keeps. */
type LabelSkeleton = Element & { id: string; text: string };

/** The kinds of element that an arrow binds to, as Excalidraw binds them. */
const BINDABLE: ReadonlySet<string> = new Set([
  'rectangle',
  'ellipse',
  'diamond',
  'text',
  'image',
  'frame',
  'magicframe',
  'iframe',
  'embeddable',
]);

/** The fields of a change, besides the id of the shape or the group it changes. */
type Field = Exclude<keyof ShapeChange, 'id' | 'group'>;

/** Each field that update_shape reads. */
const FIELDS: readonly Field[] = ['x', 'y', 'width', 'height', 'label', 'text', 'fontSize', 'strokeColor', 'backgroundColor', 'name'];

const BOX_FIELDS: readonly Field[] = ['x', 'y', 'width', 'height', 'label', 'strokeColor', 'backgroundColor'];

/** The kinds of shape that update_shape changes, by Excalidraw's type, with the fields it changes of each. */
const CHANGES = new Map<string, readonly Field[]>([
  ['rectangle', BOX_FIELDS],
  ['ellipse', BOX_FIELDS],
  ['diamond', BOX_FIELDS],
  ['text', ['x', 'y', 'text', 'fontSize', 'strokeColor']],
  ['arrow', ['x', 'y', 'width', 'height', 'label', 'strokeColor']],
  ['line', ['x', 'y', 'width', 'height', 'strokeColor']],
  ['frame', ['x', 'y', 'name']],
]);

/** The fields of a text that set its style, which a new layout of it keeps. */
const TEXT_STYLE = ['fontSize', 'fontFamily', 'textAlign', 'verticalAlign', 'lineHeight'] as const;

/** The fields of a label that convertToExcalidrawElements lays out on its shape. */
const LABEL_LAYOUT = ['x', 'y', 'width', 'height', 'text', 'originalText'] as const;

/** The fields of a text that convertToExcalidrawElements measures. */
const TEXT_MEASURE = ['width', 'height', 'text', 'originalText', 'fontSize', 'lineHeight'] as const;

/** The fields of an arrow that convertToExcalidrawElements lays out between the shapes it binds. */
const ARROW_LAYOUT = ['x', 'y', 'width', 'height', 'points', 'startBinding', 'endBinding'] as const;

/**
 * Draws a straight arrow from the shape `connection.start` to the shape `connection.end`, bound to
 * both, with the label, the id and the color `connection` sets, above every element on the board,
 * and returns the arrow's id. The arrow runs between the shapes' centers and stops short of each
 * outline, and each of the two shapes lists it among its bound elements. The arrow and its label
 * record `creator`, where given, as their creator. Throws a ShapeError, and changes nothing, where
 * an end isn't a shape on the board, is a label, or is a kind of shape an arrow doesn't bind to,
 * where both ends are one shape or the shapes have one center, or where the id is taken.
 */
export async function connect(doc: Y.Doc, connection: Connection, creator?: Creator): Promise<string> {
  const shared = doc.getMap<unknown>(ELEMENTS);
  const inItsPlace = (container: string) => `connect "${container}" in its place`;
  const start = shapeOf(shared, 'start', connection.start, inItsPlace);
  const end = shapeOf(shared, 'end', connection.end, inItsPlace);
  if (connection.start === connection.end) {
    throw new ShapeError(`start and end are both "${connection.start}": connect draws an arrow between two shapes.`);
  }
  for (const [field, element] of [
    ['start', start],
    ['end', end],
  ] as const) {
    const type = String(element.type);
    if (!BINDABLE.has(type)) {
      throw new ShapeError(
        `${field} is "${String(element.id)}", ${article(type)}, which an arrow doesn't bind to: connect a rectangle, an ellipse, a diamond, a text, an image or a frame.`,
      );
    }
  }
  const id = connection.id ?? newId();
  if (shared.has(id)) {
    throw new ShapeError(
      `id is "${id}", which a shape on the board has already, or a deleted one had: give the arrow another id, or leave it out.`,
    );
  }
  const segment = arrowPoints(outlineOf(start), outlineOf(end));
  if (segment === null) {
    throw new ShapeError(
      `"${connection.start}" and "${connection.end}" have one center, so an arrow between them has no direction: move one of them with update_shape first.`,
    );
  }

  const text = connection.label?.text;
  const laid = await layArrow({
    id,
    ...segment,
    start,
    end,
    strokeColor: connection.strokeColor ?? undefined,
    label: text === undefined ? undefined : { text, id: newId() },
  });
  const writes = new Writes(shared, creator);
  writes.added.push(mark(structuredClone(laid.arrow), creator));
  if (laid.label !== undefined) writes.added.push(mark(structuredClone(laid.label), creator));
  for (const shapeId of [connection.start, connection.end]) {
    const shape = writes.get(shapeId);
    if (shape === undefined) continue;
    const bound = entries(shape.boundElements).filter((entry) => entry.id !== id);
    writes.set(touched(shape, { boundElements: [...bound, { id, type: 'arrow' }] }));
  }
  writes.commit(doc);
  return id;
}

/**
 * Changes the shape `change.id` as `change` says, and returns the shape as get_board lists it
 * after the change; a field `change` leaves out, or gives as null, stays as it is. A rectangle, an
 * ellipse or a diamond moves with its label, a new size or a new label lays its label out again,
 * an empty label removes it, and its color is its label's too. A text is measured again for a new
 * text or font size. A straight arrow or line takes a new end from its width and height. Each
 * straight arrow bound to a shape that moves or changes size is laid out again between the shapes
 * it binds. A label the change adds records `creator`, where given, as its creator, and goes into
 * the groups its shape is in. Throws a ShapeError, and changes nothing, where `change` leaves the
 * id out, where the id isn't a shape on the board, is a label or is a kind of shape update_shape
 * doesn't change, where the change doesn't change anything or sets a field that doesn't apply to
 * the shape, where a size isn't above 0, or where it moves an arrow bound to a shape or gives a
 * width or a height to an arrow or a line of more than two points. A frame moves with every element
 * in it, as changeFrame moves it, and takes a new name.
 */
export async function updateShape(doc: Y.Doc, change: ShapeChange, creator?: Creator): Promise<BoardShape> {
  const shared = doc.getMap<unknown>(ELEMENTS);
  const id = change.id;
  if (!present(id)) throw new ShapeError(NO_SHAPE);
  const shape = shapeOf(shared, 'id', id, (container) => `change it with update_shape, the id "${container}" and label`);
  const type = String(shape.type);
  const fields = CHANGES.get(type);
  if (fields === undefined) {
    throw new ShapeError(
      `"${id}" is ${article(type)}, which update_shape doesn't change: it changes rectangles, ellipses, diamonds, texts, arrows, lines and frames.`,
    );
  }
  const given = FIELDS.filter((field) => present(change[field]));
  if (given.length === 0) {
    throw new ShapeError(`The call doesn't change "${id}": give ${article(type)}'s ${listed(fields)}, or some of them.`);
  }
  const stray = given.find((field) => !fields.includes(field));
  if (stray !== undefined) {
    throw new ShapeError(`${stray} doesn't apply to ${article(type)}, such as "${id}": update_shape changes its ${listed(fields)}.`);
  }

  const writes = new Writes(shared, creator);
  if (type === 'text') await changeText(writes, shape, change);
  else if (type === 'arrow' || type === 'line') await changeLinear(writes, shape, change, creator);
  else if (type === 'frame') await changeFrame(writes, shape, change);
  else await changeBox(writes, shape, change, creator);
  writes.commit(doc);

  const changed = readBoard(shared.values()).find((candidate) => candidate.id === id);
  if (changed === undefined) throw new Error(`get_board doesn't list "${id}" after update_shape changed it`);
  return changed;
}

/** The refusal of an update_shape call that sets neither id nor group. */
const NO_SHAPE = "The call doesn't name a shape: give id, the shape to change, or group, a group to move.";

/**
 * Moves every shape of the group `change.group`, each with its label, so that the group's left
 * edge goes to `change.x` and its top edge to `change.y`, where given, and returns the group's
 * shapes as get_board lists them after the move, from back to front. The group's edges are those
 * of the bounds of its shapes as get_board lists them. Each straight arrow bound to a shape of the
 * group that isn't in the group, and each straight arrow of the group bound to a shape outside it,
 * is laid out again between the shapes it binds; an arrow of more than two points and an elbow
 * arrow move as they are. Throws a ShapeError, and changes nothing, where `change` sets id too,
 * sets a field besides x and y, sets neither, or where no shape on the board is in the group.
 * Each element the move writes records `creator`, where given, as the author of its new version.
 */
export async function moveGroup(doc: Y.Doc, change: ShapeChange, creator?: Creator): Promise<BoardShape[]> {
  const shared = doc.getMap<unknown>(ELEMENTS);
  const { id, group, x, y } = change;
  if (!present(group)) throw new ShapeError(NO_SHAPE);
  if (present(id)) {
    throw new ShapeError(`The call sets id "${id}" and group "${group}": give id to change one shape, or group to move a group.`);
  }
  const stray = FIELDS.find((field) => field !== 'x' && field !== 'y' && present(change[field]));
  if (stray !== undefined) {
    throw new ShapeError(
      `${stray} doesn't apply to a group, such as "${group}": update_shape moves a group by x and y, and changes each of its shapes by that shape's id.`,
    );
  }
  if (!present(x) && !present(y)) {
    throw new ShapeError(`The call doesn't move the group "${group}": give its x, its y or both.`);
  }
  const members = inGroup(readBoard(shared.values()), group);
  if (members.length === 0) {
    throw new ShapeError(`group is "${group}", which no shape on the board is in: get_board lists each shape's groups.`);
  }
  const { x: left, y: top } = edgesOf(members);
  const dx = present(x) ? x - left : 0;
  const dy = present(y) ? y - top : 0;

  // The group's shapes and their labels move together, and keep where each lies from the others.
  const moved = withLabels(shared, members.map((shape) => shape.id));
  const writes = new Writes(shared, creator);
  for (const elementId of moved) {
    const element = writes.get(elementId);
    if (element !== undefined) writes.set(touched(element, { x: numberOf(element.x) + dx, y: numberOf(element.y) + dy }));
  }
  // An arrow between a shape that moved and one that didn't is laid out again between them.
  await followMoved(writes, moved);
  writes.commit(doc);
  return inGroup(readBoard(shared.values()), group);
}

/**
 * Moves the frame `frame` so that its left edge goes to `change.x` and its top edge to `change.y`,
 * where given, with every element in it, each label among them, as Excalidraw moves a frame, and
 * gives it the name `change.name`, where given. Each straight arrow bound to an element that moves
 * and to one that doesn't is laid out again between the shapes it binds, as followMoved lays it out.
 */
async function changeFrame(writes: Writes, frame: Element, change: ShapeChange): Promise<void> {
  const frameId = String(frame.id);
  const dx = present(change.x) ? change.x - numberOf(frame.x) : 0;
  const dy = present(change.y) ? change.y - numberOf(frame.y) : 0;
  const moves = dx !== 0 || dy !== 0;
  const moved = withLabels(writes.shared, [frameId, ...inFrame(writes.shared, frameId)]);
  for (const elementId of moved) {
    const element = writes.get(elementId);
    if (element === undefined) continue;
    const changes: Element = moves ? { x: numberOf(element.x) + dx, y: numberOf(element.y) + dy } : {};
    if (elementId === frameId && present(change.name)) changes.name = change.name;
    if (Object.keys(changes).length > 0) writes.set(touched(element, changes));
  }
  if (moves) await followMoved(writes, moved);
}

/** The ids of the elements on the board that are in the frame `frameId`, as each one's frameId says. */
function inFrame(shared: Y.Map<unknown>, frameId: string): string[] {
  const ids: string[] = [];
  for (const [elementId, value] of shared.entries()) {
    const element = elementOf(value);
    if (element !== undefined && element.isDeleted !== true && element.frameId === frameId) ids.push(elementId);
  }
  return ids;
}

/** The shapes of `shapes` that are in the group `group`, in their order. */
function inGroup(shapes: readonly BoardShape[], group: string): BoardShape[] {
  return shapes.filter((shape) => shape.groups?.includes(group) === true);
}

/**
 * The left and top edges of the bounds of `shapes`, as get_board lists them: the least x and y of
 * the shapes, each point of a line, an arrow or a freehand stroke among them.
 */
function edgesOf(shapes: readonly BoardShape[]): Point {
  const corners = shapes.flatMap((shape) =>
    (shape.points ?? [[0, 0], [shape.width, shape.height]]).map((point) => ({
      x: shape.x + (point[0] ?? 0),
      y: shape.y + (point[1] ?? 0),
    })),
  );
  return { x: Math.min(...corners.map((corner) => corner.x)), y: Math.min(...corners.map((corner) => corner.y)) };
}

/** The ids `ids` of shapes, with the id of each label on the board whose shape is one of them. */
export function withLabels(shared: Y.Map<unknown>, ids: Iterable<string>): Set<string> {
  const chosen = new Set(ids);
  for (const [elementId, value] of shared.entries()) {
    const element = elementOf(value);
    if (element === undefined || element.isDeleted === true) continue;
    if (element.type === 'text' && typeof element.containerId === 'string' && chosen.has(element.containerId)) {
      chosen.add(elementId);
    }
  }
  return chosen;
}

/**
 * Lays out again, between the shapes it binds, each straight arrow that binds an element of
 * `moved`, as the change writes it, to a shape outside `moved`: an arrow outside `moved` bound to
 * a shape of it, and an arrow of `moved` bound to a shape outside it. An arrow of more than two
 * points and an elbow arrow stay as the change writes them.
 */
async function followMoved(writes: Writes, moved: ReadonlySet<string>): Promise<void> {
  for (const elementId of moved) {
    const element = writes.get(elementId);
    if (element === undefined) continue;
    if (element.type !== 'arrow') {
      await relayArrows(writes, element, (arrow) => moved.has(arrow));
      continue;
    }
    for (const end of [boundTo(element.startBinding), boundTo(element.endBinding)]) {
      const shape = end === undefined || moved.has(end) ? undefined : writes.get(end);
      if (shape !== undefined) await relayArrows(writes, shape, (arrow) => arrow !== elementId);
    }
  }
}

/**
 * Deletes the shapes `ids`, and every shape of each group of `groups`, from the board, each with
 * its label, in one transaction, and returns the ids it deleted: `ids`, then each group's shapes
 * that `ids` and an earlier group leave out, from back to front. An arrow bound to a deleted shape
 * stays, with that end free, and each shape that lists a deleted arrow among its bound elements no
 * longer does. Throws a ShapeError, and deletes nothing, where neither lists anything, where `ids`
 * holds one id twice, or an id that isn't a shape on the board or is a label, or where `groups`
 * holds one group twice, or a group that no shape on the board is in.
 * Each element the deletion writes records `creator`, where given, as the author of its new
 * version.
 */
export function deleteShapes(doc: Y.Doc, ids: readonly string[], groups: readonly string[] = [], creator?: Creator): string[] {
  const shared = doc.getMap<unknown>(ELEMENTS);
  if (ids.length === 0 && groups.length === 0) {
    throw new ShapeError("The call doesn't name a shape to delete: give ids, groups or both.");
  }
  const deleted = selected(
    shared,
    ids,
    groups,
    (container) => `delete "${container}", or remove its label with update_shape and an empty label`,
  );

  doc.transact(() => {
    const board = [...shared.entries()].flatMap(([id, value]): [string, Element][] => {
      const element = elementOf(value);
      return element === undefined || element.isDeleted === true ? [] : [[id, element]];
    });
    const gone = new Set(deleted);
    for (const [id, element] of board) {
      if (element.type === 'text' && typeof element.containerId === 'string' && gone.has(element.containerId)) gone.add(id);
    }
    for (const [id, element] of board) {
      if (gone.has(id)) {
        shared.set(id, changedBy(touched(element, { isDeleted: true }), creator));
        continue;
      }
      const fields: Element = {};
      for (const binding of ['startBinding', 'endBinding'] as const) {
        const bound = boundTo(element[binding]);
        if (bound !== undefined && gone.has(bound)) fields[binding] = null;
      }
      const bound = entries(element.boundElements);
      const kept = bound.filter((entry) => !gone.has(entry.id));
      if (kept.length !== bound.length) fields.boundElements = kept;
      if (Object.keys(fields).length > 0) shared.set(id, changedBy(touched(element, fields), creator));
    }
  });
  return deleted;
}

/**
 * The ids of the shapes a call names by `ids` and by `groups`, each once: `ids`, then each group's
 * shapes that `ids` and an earlier group leave out, from back to front. Throws a ShapeError where
 * `ids` holds one id twice, or an id that isn't a shape on the board or is a label, whose refusal
 * ends with `forLabel` of the label's shape, or where `groups` holds one group twice, or a group
 * that no shape on the board is in.
 */
export function selected(
  shared: Y.Map<unknown>,
  ids: readonly string[],
  groups: readonly string[],
  forLabel: (container: string) => string,
): string[] {
  const first = new Map<string, number>();
  ids.forEach((id, place) => {
    const earlier = first.get(id);
    if (earlier !== undefined) {
      throw new ShapeError(`ids[${place}] is "${id}", which ids[${earlier}] is too: list each shape once.`);
    }
    first.set(id, place);
    shapeOf(shared, `ids[${place}]`, id, forLabel);
  });

  const chosen = [...ids];
  if (groups.length > 0) {
    const shapes = readBoard(shared.values());
    const taken = new Set(ids);
    const firstGroup = new Map<string, number>();
    groups.forEach((group, place) => {
      const earlier = firstGroup.get(group);
      if (earlier !== undefined) {
        throw new ShapeError(`groups[${place}] is "${group}", which groups[${earlier}] is too: list each group once.`);
      }
      firstGroup.set(group, place);
      const members = inGroup(shapes, group);
      if (members.length === 0) {
        throw new ShapeError(
          `groups[${place}] is "${group}", which no shape on the board is in: get_board lists each shape's groups.`,
        );
      }
      for (const shape of members) {
        if (taken.has(shape.id)) continue;
        taken.add(shape.id);
        chosen.push(shape.id);
      }
    });
  }
  return chosen;
}

/**
 * Scales the shapes `scaling.ids`, and every shape of each group of `scaling.groups`, each with
 * its label, by `scaling.factor` around the point `scaling.about`, in one transaction, and returns
 * them as get_board lists them after the change, from back to front. Each one's distance from
 * that point, its width and its height, the points of a line, an arrow or a freehand stroke, and
 * the font size of a text or a label scale by the factor; where `scaling.about` is left out, the
 * left and top edges of the shapes' bounds, as get_board lists them, stay where they are. An arrow
 * that scales keeps its binding to each shape that scales with it, with the binding's gap scaled,
 * and each straight arrow between a shape that scales and one that doesn't is laid out again
 * between them. Throws a ShapeError, and changes nothing, where neither `scaling.ids` nor
 * `scaling.groups` lists anything, where `scaling.ids` holds one id twice, or an id that isn't a
 * shape on the board or is a label, or where `scaling.groups` holds one group twice, or a group
 * that no shape on the board is in. Each element the scale writes records `creator`, where given,
 * as the author of its new version.
 */
export async function scaleShapes(doc: Y.Doc, scaling: Scaling, creator?: Creator): Promise<BoardShape[]> {
  const shared = doc.getMap<unknown>(ELEMENTS);
  const ids = scaling.ids ?? [];
  const groups = scaling.groups ?? [];
  if (ids.length === 0 && groups.length === 0) {
    throw new ShapeError("The call doesn't name a shape to scale: give ids, groups or both.");
  }
  const chosen = new Set(selected(shared, ids, groups, (container) => `scale "${container}", and its label scales with it`));
  const chosenShapes = () => readBoard(shared.values()).filter((shape) => chosen.has(shape.id));
  const about = scaling.about ?? edgesOf(chosenShapes());
  const scaled = withLabels(shared, chosen);
  const writes = new Writes(shared, creator);
  for (const elementId of scaled) {
    const element = writes.get(elementId);
    if (element !== undefined) writes.set(touched(element, scaledFields(element, about, scaling.factor, scaled)));
  }
  // An arrow between a shape that scaled and one that didn't is laid out again between them.
  await followMoved(writes, scaled);
  writes.commit(doc);
  return chosenShapes();
}

/**
 * The fields of `element` that scale by `factor` around `about`: its place, its size, its points,
 * its font size, and the gap of each binding to a shape of `scaled`, which scales with it.
 */
function scaledFields(element: Element, about: Point, factor: number, scaled: ReadonlySet<string>): Element {
  const fields: Element = {
    x: about.x + (numberOf(element.x) - about.x) * factor,
    y: about.y + (numberOf(element.y) - about.y) * factor,
    width: numberOf(element.width) * factor,
    height: numberOf(element.height) * factor,
  };
  const points = pointsOf(element);
  if (points.length > 0) fields.points = points.map(([x, y]) => [x * factor, y * factor]);
  const fontSize = element.fontSize;
  if (finite(fontSize)) fields.fontSize = fontSize * factor;
  for (const key of ['startBinding', 'endBinding'] as const) {
    const binding = elementOf(element[key]);
    const bound = boundTo(element[key]);
    const gap = binding?.gap;
    if (binding !== undefined && bound !== undefined && scaled.has(bound) && finite(gap)) {
      fields[key] = { ...binding, gap: gap * factor };
    }
  }
  return fields;
}

/**
 * Moves the shapes `ids` to `place` in the board's stacking order, each with its label just above
 * it, in one transaction, and returns `ids` back to front, as get_board then lists them. The shapes
 * keep their order among themselves, whatever order `ids` lists them in, and each element moved
 * gets a new version, so that each page takes the move. Throws a ShapeError, and moves nothing,
 * where `ids` holds one id twice, or an id that isn't a shape on the board or is a label, or where
 * `place` names a shape that `ids` moves too, or one that indicesAt refuses. Each element the move
 * writes records `creator`, where given, as the author of its new version.
 */
export function reorderShapes(doc: Y.Doc, ids: readonly string[], place: Place, creator?: Creator): string[] {
  const shared = doc.getMap<unknown>(ELEMENTS);
  const first = new Map<string, number>();
  const shapes = ids.map((id, n) => {
    const earlier = first.get(id);
    if (earlier !== undefined) {
      throw new ShapeError(`ids[${n}] is "${id}", which ids[${earlier}] is too: list each shape once.`);
    }
    first.set(id, n);
    return stacking(id, shapeOf(shared, `ids[${n}]`, id, (container) => `move "${container}", and its label moves with it`));
  });
  if (place !== 'front' && place !== 'back') {
    const [side, target] = 'below' in place ? (['below', place.below] as const) : (['above', place.above] as const);
    const mover = first.get(target);
    if (mover !== undefined) {
      throw new ShapeError(
        `place.${side} is "${target}", which ids[${mover}] moves too: place the shapes ${side} a shape that stays where it is.`,
      );
    }
  }

  // Each shape's label moves with it, just above it, as add_shapes stacks a label on its shape.
  const labels = new Map<string, Stacking[]>();
  for (const [id, value] of shared.entries()) {
    const element = elementOf(value);
    if (element === undefined || element.isDeleted === true) continue;
    const container = containerOf(shared, element);
    if (container !== undefined && first.has(container)) labels.set(container, [...(labels.get(container) ?? []), stacking(id, element)]);
  }
  const order = [...shapes].sort(backToFront);
  const moved = order.flatMap((shape) => [shape, ...(labels.get(shape.id) ?? []).sort(backToFront)]);
  const indices = indicesAt(shared, place, moved.length, new Set(moved.map((entry) => entry.id)));
  doc.transact(() => {
    moved.forEach((entry, n) => shared.set(entry.id, changedBy(touched(entry.element, { index: indices[n] }), creator)));
  });
  return order.map((shape) => shape.id);
}

/** An element that reorder_shapes moves, with its id and its index, which order it on the board. */
interface Stacking extends Stacked {
  element: Element;
}

/** The element `element`, whose id on the board is `id`, as reorder_shapes orders it. */
function stacking(id: string, element: Element): Stacking {
  return { id, index: typeof element.index === 'string' ? element.index : null, element };
}

/** The elements that one change of the board writes, read over the board as it stands. */
class Writes {
  /** The elements on the board that the change writes, by id. */
  readonly changed = new Map<string, Element>();
  /** The elements the change adds, which go above every element on the board, in this order. */
  readonly added: Element[] = [];

  /**
   * `creator`, where given, is the agent whose call makes the change: each element the change
   * writes records it as the author of the element's new version.
   */
  constructor(
    readonly shared: Y.Map<unknown>,
    readonly creator?: Creator,
  ) {}

  /** The element `id`, as the change writes it or as the board holds it; undefined where the board doesn't hold it. */
  get(id: string): Element | undefined {
    return this.changed.get(id) ?? live(this.shared, id);
  }

  set(element: Element): void {
    this.changed.set(String(element.id), element);
  }

  /** Writes the change into `doc`, in one transaction. */
  commit(doc: Y.Doc): void {
    doc.transact(() => {
      for (const [id, element] of this.changed) this.shared.set(id, changedBy(element, this.creator));
      const indices = indicesAbove(this.shared.values(), this.added.length);
      this.added.forEach((element, place) => this.shared.set(String(element.id), { ...element, index: indices[place] }));
    });
  }
}

/** Changes a rectangle, an ellipse or a diamond, and the label and the arrows bound to it. */
async function changeBox(writes: Writes, box: Element, change: ShapeChange, creator: Creator | undefined): Promise<void> {
  const type = String(box.type);
  for (const field of ['width', 'height'] as const) {
    const value = change[field];
    if (present(value) && !(value > 0)) throw new ShapeError(`${field} is ${value}: ${article(type)}'s ${field} is above 0.`);
  }
  const x = change.x ?? numberOf(box.x);
  const y = change.y ?? numberOf(box.y);
  const fields: Element = { x, y, width: change.width ?? numberOf(box.width), height: change.height ?? numberOf(box.height) };
  const strokeColor = change.strokeColor ?? undefined;
  if (strokeColor !== undefined) fields.strokeColor = strokeColor;
  if (present(change.backgroundColor)) fields.backgroundColor = change.backgroundColor;

  const label = labelOf(writes, box);
  const resized = fields.width !== box.width || fields.height !== box.height;
  const text = change.label?.text ?? (resized && label !== undefined ? textOf(label) : undefined);
  if (text === '') {
    if (label !== undefined) {
      writes.set(touched(label, { isDeleted: true }));
      fields.boundElements = entries(box.boundElements).filter((entry) => entry.id !== label.id);
    }
  } else if (text !== undefined) {
    // A new size or a new text lays the label out again, as Excalidraw lays a label out in its shape,
    // which grows the shape where the text doesn't fit.
    const color = strokeColor ?? stringOf(box.strokeColor);
    const labelId = label === undefined ? newId() : String(label.id);
    const laid = await layLabelled(
      {
        type,
        id: String(box.id),
        x,
        y,
        width: fields.width,
        height: fields.height,
        ...(color === undefined ? {} : { strokeColor: color }),
      },
      { ...(label === undefined ? {} : pick(label, TEXT_STYLE)), text, id: labelId },
    );
    fields.width = laid.container.width;
    fields.height = laid.container.height;
    const layout = { ...pick(laid.label, LABEL_LAYOUT), angle: numberOf(box.angle) };
    if (label === undefined) {
      writes.added.push(mark({ ...structuredClone(laid.label), ...layout, groupIds: groupsOf(box.groupIds) }, creator));
      fields.boundElements = [...entries(box.boundElements), { id: labelId, type: 'text' }];
    } else {
      writes.set(touched(label, { ...layout, ...(strokeColor === undefined ? {} : { strokeColor }) }));
    }
  } else if (label !== undefined && (x !== box.x || y !== box.y || strokeColor !== undefined)) {
    writes.set(
      touched(label, {
        x: numberOf(label.x) + x - numberOf(box.x),
        y: numberOf(label.y) + y - numberOf(box.y),
        ...(strokeColor === undefined ? {} : { strokeColor }),
      }),
    );
  }

  const changed = touched(box, fields);
  writes.set(changed);
  if (movedOrResized(box, changed)) await relayArrows(writes, changed);
}

/** Changes a text that isn't a label, and the arrows bound to it. */
async function changeText(writes: Writes, text: Element, change: ShapeChange): Promise<void> {
  const fields: Element = {};
  if (present(change.x)) fields.x = change.x;
  if (present(change.y)) fields.y = change.y;
  if (present(change.strokeColor)) fields.strokeColor = change.strokeColor;
  if (present(change.text) || present(change.fontSize)) {
    const [measured] = await convert(
      [
        {
          ...pick(text, TEXT_STYLE),
          ...(present(change.fontSize) ? { fontSize: change.fontSize } : {}),
          type: 'text',
          x: 0,
          y: 0,
          text: change.text ?? textOf(text),
        },
      ],
      true,
    );
    if (measured === undefined) throw new Error(`convertToExcalidrawElements didn't measure the text of "${String(text.id)}"`);
    Object.assign(fields, pick(measured, TEXT_MEASURE), { autoResize: true });
  }
  const changed = touched(text, fields);
  writes.set(changed);
  if (movedOrResized(text, changed)) await relayArrows(writes, changed);
}

/** Changes an arrow or a line, and an arrow's label. */
async function changeLinear(writes: Writes, line: Element, change: ShapeChange, creator: Creator | undefined): Promise<void> {
  const type = String(line.type);
  const id = String(line.id);
  const moves = [change.x, change.y, change.width, change.height].some((value) => present(value));
  const bound = [...new Set([boundTo(line.startBinding), boundTo(line.endBinding)])].filter(
    (shape): shape is string => shape !== undefined,
  );
  if (moves && bound.length > 0) {
    throw new ShapeError(
      `"${id}" follows the shapes it is bound to, ${listed(bound.map((shape) => `"${shape}"`))}: move them, or delete the ${type} and connect the shapes again.`,
    );
  }
  const points = pointsOf(line);
  const reshapes = present(change.width) || present(change.height);
  if (reshapes && points.length !== 2) {
    throw new ShapeError(
      `width and height change a straight ${type} of two points, and "${id}" has ${points.length}: move it with x and y.`,
    );
  }

  const fields: Element = {};
  if (present(change.x)) fields.x = change.x;
  if (present(change.y)) fields.y = change.y;
  const strokeColor = change.strokeColor ?? undefined;
  if (strokeColor !== undefined) fields.strokeColor = strokeColor;
  let laidPoints = points;
  if (reshapes) {
    const [[x0, y0], [x1, y1]] = points;
    const dx = change.width ?? x1 - x0;
    const dy = change.height ?? y1 - y0;
    laidPoints = [
      [x0, y0],
      [x0 + dx, y0 + dy],
    ];
    Object.assign(fields, { points: laidPoints, width: Math.abs(dx), height: Math.abs(dy) });
  }

  const label = type === 'arrow' ? labelOf(writes, line) : undefined;
  const text = change.label?.text ?? (moves && label !== undefined ? textOf(label) : undefined);
  if (text === '') {
    if (label !== undefined) {
      writes.set(touched(label, { isDeleted: true }));
      fields.boundElements = entries(line.boundElements).filter((entry) => entry.id !== label.id);
    }
  } else if (text !== undefined) {
    // The label goes to the middle of the arrow as it stands after the change.
    const color = strokeColor ?? stringOf(line.strokeColor);
    const labelId = label === undefined ? newId() : String(label.id);
    const laid = await layLabelled(
      {
        type: 'arrow',
        id,
        x: fields.x ?? line.x,
        y: fields.y ?? line.y,
        width: fields.width ?? line.width,
        height: fields.height ?? line.height,
        points: laidPoints,
        ...(color === undefined ? {} : { strokeColor: color }),
      },
      { ...(label === undefined ? {} : pick(label, TEXT_STYLE)), text, id: labelId },
    );
    const layout = { ...pick(laid.label, LABEL_LAYOUT), angle: 0 };
    if (label === undefined) {
      writes.added.push(mark({ ...structuredClone(laid.label), ...layout, groupIds: groupsOf(line.groupIds) }, creator));
      fields.boundElements = [...entries(line.boundElements), { id: labelId, type: 'text' }];
    } else {
      writes.set(touched(label, { ...layout, ...(strokeColor === undefined ? {} : { strokeColor }) }));
    }
  } else if (label !== undefined && strokeColor !== undefined) {
    writes.set(touched(label, { strokeColor }));
  }
  writes.set(touched(line, fields));
}

/**
 * Lays out again each straight arrow bound to `shape`, as the change writes it, between the
 * shapes it binds, with its label in its middle, leaving out each arrow for whose id `skip`
 * answers true. An end bound to another shape follows that shape, and a free end stays where it
 * is. An arrow of more than two points, an elbow arrow and an arrow bound to `shape` at both ends
 * stay as they are.
 */
async function relayArrows(writes: Writes, shape: Element, skip: (arrow: string) => boolean = () => false): Promise<void> {
  for (const entry of entries(shape.boundElements)) {
    if (entry.type !== 'arrow' || skip(entry.id)) continue;
    const arrow = writes.get(entry.id);
    if (arrow === undefined || arrow.type !== 'arrow' || arrow.elbowed === true) continue;
    const points = pointsOf(arrow);
    const startId = boundTo(arrow.startBinding);
    const endId = boundTo(arrow.endBinding);
    if (points.length !== 2 || startId === endId || (startId !== shape.id && endId !== shape.id)) continue;
    const placed = boardPoints({ x: numberOf(arrow.x), y: numberOf(arrow.y) }, points, numberOf(arrow.angle));
    const start = boundShape(writes, startId);
    const end = boundShape(writes, endId);
    const segment = arrowPoints(
      start === undefined ? placed[0] : outlineOf(start),
      end === undefined ? placed[1] : outlineOf(end),
    );
    if (segment === null) continue;
    const label = labelOf(writes, arrow);
    const text = label === undefined ? '' : textOf(label);
    const laid = await layArrow({
      id: String(arrow.id),
      ...segment,
      start,
      end,
      label: label === undefined || text === '' ? undefined : { ...pick(label, TEXT_STYLE), text, id: String(label.id) },
    });
    writes.set(touched(arrow, { ...pick(laid.arrow, ARROW_LAYOUT), angle: 0 }));
    if (label !== undefined && laid.label !== undefined) {
      writes.set(touched(label, { ...pick(laid.label, LABEL_LAYOUT), angle: 0 }));
    }
  }
}

interface ArrowLayout {
  id: string;
  from: Point;
  to: Point;
  /** The shapes that the arrow's ends are bound to; an end left out is free. */
  start?: Element;
  end?: Element;
  label?: LabelSkeleton;
  strokeColor?: string;
}

/**
 * The arrow from `layout.from` to `layout.to`, and its label, as convertToExcalidrawElements makes
 * them: with a binding to each shape `layout` gives, read from a copy of that shape's outline.
 */
async function layArrow(layout: ArrowLayout): Promise<{ arrow: Element; label: Element | undefined }> {
  const { id, from, to, start, end, label, strokeColor } = layout;
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const arrow: Element = {
    type: 'arrow',
    id,
    x: from.x,
    y: from.y,
    width: Math.abs(dx),
    height: Math.abs(dy),
    points: [
      [0, 0],
      [dx, dy],
    ],
  };
  if (strokeColor !== undefined) arrow.strokeColor = strokeColor;
  if (start !== undefined) arrow.start = { id: String(start.id) };
  if (end !== undefined) arrow.end = { id: String(end.id) };
  if (label !== undefined) arrow.label = label;
  const copies = [start, end].flatMap((shape) => (shape === undefined ? [] : [{ ...outlineOf(shape), id: String(shape.id) }]));
  const converted = await convert([arrow, ...copies]);
  return { arrow: found(converted, id), label: label === undefined ? undefined : found(converted, label.id) };
}

/** The shape `container`, in Excalidraw's skeleton format, and its label `label`, as convertToExcalidrawElements lays them out. */
async function layLabelled(
  container: Element & { id: string },
  label: LabelSkeleton,
): Promise<{ container: Element; label: Element }> {
  const converted = await convert([{ ...container, label }]);
  return { container: found(converted, container.id), label: found(converted, label.id) };
}

async function convert(skeletons: readonly Element[], regenerateIds = false): Promise<Element[]> {
  return (await convertSkeletons(skeletons as unknown as Skeleton[], { regenerateIds })) as unknown as Element[];
}

function found(elements: readonly Element[], id: string): Element {
  const element = elements.find((candidate) => candidate.id === id);
  if (element === undefined) {
    throw new Error(`convertToExcalidrawElements didn't make the element ${id}: ${JSON.stringify(elements)}`);
  }
  return element;
}

/**
 * The shape `id` of the board, which a field of the call names; throws a ShapeError where the
 * board doesn't hold it, it is deleted, or it is the label of another shape, in which case the
 * refusal ends with `forLabel` of that shape's id.
 */
function shapeOf(shared: Y.Map<unknown>, field: string, id: string, forLabel: (container: string) => string): Element {
  const element = live(shared, id);
  if (element === undefined || typeof element.type !== 'string') {
    throw new ShapeError(`${field} is "${id}", which isn't the id of a shape on the board: get_board lists each shape's id.`);
  }
  const container = containerOf(shared, element);
  if (container !== undefined) {
    throw new ShapeError(
      `${field} is "${id}", the label of the shape "${container}", which get_board lists with its label: ${forLabel(container)}.`,
    );
  }
  return element;
}

/** The id of the shape whose label `element` is, as get_board reads labels, or undefined where it isn't a label. */
function containerOf(shared: Y.Map<unknown>, element: Element): string | undefined {
  const containerId = element.containerId;
  if (element.type !== 'text' || typeof containerId !== 'string') return undefined;
  const container = live(shared, containerId);
  return container !== undefined && container.type !== 'text' ? containerId : undefined;
}

/** The label of `container`, as the change writes it or as the board holds it. */
function labelOf(writes: Writes, container: Element): Element | undefined {
  for (const entry of entries(container.boundElements)) {
    if (entry.type !== 'text') continue;
    const label = writes.get(entry.id);
    if (label !== undefined && label.type === 'text' && label.containerId === container.id) return label;
  }
  return undefined;
}

/** The shape `id`, where an arrow binds to it. */
function boundShape(writes: Writes, id: string | undefined): Element | undefined {
  if (id === undefined) return undefined;
  const shape = writes.get(id);
  return shape !== undefined && BINDABLE.has(String(shape.type)) ? shape : undefined;
}

/** The element `id` of the board, where it isn't deleted. */
function live(shared: Y.Map<unknown>, id: string): Element | undefined {
  const element = elementOf(shared.get(id));
  return element === undefined || element.isDeleted === true ? undefined : element;
}

function elementOf(value: unknown): Element | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Element) : undefined;
}

/**
 * A copy of `element` with `changes`, and with a new version, as Excalidraw changes an element, so
 * that each page takes the new one in place of the one it holds.
 */
function touched(element: Element, changes: Element): Element {
  return {
    ...structuredClone(element),
    ...changes,
    version: numberOf(element.version) + 1,
    versionNonce: randomInt(2 ** 31),
    updated: Date.now(),
  };
}

function mark(element: Element, creator: Creator | undefined): Element {
  return creator === undefined ? element : withCreator(element, creator);
}

/** `element`, with `creator`, where given, recorded as the author of its version. */
function changedBy(element: Element, creator: Creator | undefined): Element {
  return creator === undefined ? element : withChange(element, creator);
}

/** Whether `after` moved or resized the shape `before` was. */
function movedOrResized(before: Element, after: Element): boolean {
  return (['x', 'y', 'width', 'height'] as const).some((key) => after[key] !== before[key]);
}

/** The points of an arrow or a line, or none where they aren't pairs of numbers. */
function pointsOf(element: Element): [number, number][] {
  const points = element.points;
  if (!Array.isArray(points)) return [];
  const read: [number, number][] = [];
  for (const point of points) {
    if (!Array.isArray(point) || !finite(point[0]) || !finite(point[1])) return [];
    read.push([point[0], point[1]]);
  }
  return read;
}

/** The entries of an element's `boundElements` that are well formed. */
function entries(value: unknown): { id: string; type: string }[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const fields = elementOf(entry);
    return fields !== undefined && typeof fields.id === 'string' && typeof fields.type === 'string'
      ? [{ id: fields.id, type: fields.type }]
      : [];
  });
}

/** The text of a text element, as its writer wrote it. */
function textOf(element: Element): string {
  return stringOf(element.originalText) ?? stringOf(element.text) ?? '';
}

function pick(element: Element, keys: readonly string[]): Element {
  const picked: Element = {};
  for (const key of keys) if (key in element) picked[key] = element[key];
  return picked;
}

function numberOf(value: unknown): number {
  return finite(value) ? value : 0;
}

function present<T>(value: T | null | undefined): value is T {
  return value !== undefined && value !== null;
}

function article(kind: string): string {
  return `${/^[aeiou]/.test(kind) ? 'an' : 'a'} ${kind}`;
}

/** `words` in a list, as a sentence lists them: a, b and c. */
function listed(words: readonly string[]): string {
  if (words.length < 2) return words.join('');
  return `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
}
