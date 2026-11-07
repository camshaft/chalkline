import type * as Y from 'yjs';

/** The snapshot marks' map's name in the room's Yjs document. */
export const SNAPSHOTS = 'snapshots';

/**
 * A snapshot mark: the agent's helper writes one to ask each browser on the board to keep a snapshot of its
 * board, such as before a large edit. The snapshots themselves stay in each browser's storage, outside the
 * room's document.
 */
export interface SnapshotMark {
  /** The mark's id, unique on the board, and its key in the map. */
  id: string;
  /** The name of the agent whose helper wrote the mark, as the helper's creator mark reads it. */
  by: string;
  /** When the helper wrote the mark, as an ISO 8601 time. */
  at: string;
  /** What the snapshot is for, in a short text, or null. */
  label: string | null;
  /** How many shapes the helper's copy of the board held when it wrote the mark. */
  shapes: number;
}

/**
 * The board's snapshot marks: a Y.Map from each mark's id to its record. A mark is written once, whole, under
 * its id.
 */
export function snapshotsOf(doc: Y.Doc): Y.Map<unknown> {
  return doc.getMap<unknown>(SNAPSHOTS);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const filled = (value: unknown): value is string => typeof value === 'string' && value.trim() !== '';

const isTime = (value: unknown): value is string => filled(value) && !Number.isNaN(Date.parse(value));

const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 0;

/**
 * Reads one snapshot mark, which may come from any peer: a value that isn't an object, that lacks one of the
 * fields `id`, `by`, `at`, `label` and `shapes`, that holds a blank `id` or `by` or a time that doesn't parse,
 * whose `label` is neither a string nor null, or whose `shapes` isn't a whole number of 0 or more, reads as
 * null, as `readEntry` reads the transcript's entries. Other fields are left out, and the record it answers is
 * a copy.
 */
export function readSnapshotMark(value: unknown): SnapshotMark | null {
  if (!isRecord(value)) return null;
  const { id, by, at, label, shapes } = value;
  if (!filled(id) || !filled(by) || !isTime(at)) return null;
  if (label !== null && typeof label !== 'string') return null;
  if (!isCount(shapes)) return null;
  return { id, by, at, label, shapes };
}

/**
 * The mark that `marks` holds under `id`, or null where it doesn't hold one, where its value doesn't read as a
 * mark, or where the value's `id` isn't `id`.
 */
export function getSnapshotMark(marks: Y.Map<unknown>, id: string): SnapshotMark | null {
  const mark = readSnapshotMark(marks.get(id));
  return mark !== null && mark.id === id ? mark : null;
}

/**
 * Every mark of `marks` that `getSnapshotMark` reads under its key, oldest first: in the order of `at`, and of
 * `id` where two times are equal, so that every copy of the board lists them in one order.
 */
export function listSnapshotMarks(marks: Y.Map<unknown>): SnapshotMark[] {
  const records: SnapshotMark[] = [];
  for (const id of marks.keys()) {
    const mark = getSnapshotMark(marks, id);
    if (mark !== null) records.push(mark);
  }
  return records.sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * Writes `mark` whole under its id, which sends it to every peer. It keeps only the mark's fields, as a copy.
 * Where the mark doesn't read as one, it throws a TypeError and doesn't write anything, so that a writer
 * doesn't make a mark absent for every reader.
 */
export function writeSnapshotMark(marks: Y.Map<unknown>, mark: SnapshotMark): void {
  const value = readSnapshotMark(mark);
  if (value === null) throw new TypeError(`not a snapshot mark: ${JSON.stringify(mark)}`);
  marks.set(value.id, value);
}

/**
 * Whether `element` is a shape of the board: an element that isn't deleted and isn't a container's bound
 * text, a text element whose `containerId` is set.
 */
export function isShape(element: unknown): boolean {
  if (!isRecord(element) || element.isDeleted === true) return false;
  return !(element.type === 'text' && typeof element.containerId === 'string');
}

/** How many of `elements` are shapes, as `isShape` reads each. */
export function shapeCount(elements: Iterable<unknown>): number {
  let count = 0;
  for (const element of elements) {
    if (isShape(element)) count += 1;
  }
  return count;
}
