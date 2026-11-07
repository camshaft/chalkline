// The agent's changes of the board, which the page lists and undoes (designs/chalkline, task "undo
// the agent's changes from the page"). chalkline-mcp records each of its tool calls that changes the
// board as one change in the board's shared state, the array `agentChanges`, with each element the
// call wrote as it was before the call and as the call left it. A page lists the changes, newest
// first, and undoes one with its Undo button, and the agent undoes one of its own with undo_change:
// either writes each element back as it was before the change, for every participant, unless a
// person changed it after the change, and records the undo beside the change. As the helper records
// a change, each earlier change that the board no longer shows anything of leaves the array, so that
// the array doesn't grow for the life of the board (dropReplacedChanges). This module runs in Node
// and in the browser alike.
import { newEntryId } from '@chalkline/sync';
import type * as Y from 'yjs';
import { CUSTOM_DATA, withChange, withDrawingChanged, withWordsChanged, type Creator } from './creator';

/** The name of the board's array of the agent's changes and their undos. */
export const AGENT_CHANGES = 'agentChanges';

/** One element that an agent's change wrote: the element before the change and after it, null where the board didn't hold it. */
export interface ElementChange {
  id: string;
  before: unknown;
  after: unknown;
}

/** One tool call of an agent that changed the board, as the board's array records it. */
export interface AgentChange {
  kind: 'change';
  id: string;
  /** The agent whose call made the change. */
  by: Creator;
  /** When the change was made, as an ISO 8601 time. */
  at: string;
  /** The tool the agent called, such as add_shapes. */
  tool: string;
  /** The change in a line, such as "Claude added 18 shapes". */
  summary: string;
  elements: ElementChange[];
}

/** An element that an undo left as it was, since it changed after the agent's change, with its name for people. */
export interface KeptElement {
  id: string;
  name: string;
}

/** An undo of an agent's change, as the board's array records it. */
export interface AgentUndo {
  kind: 'undo';
  id: string;
  /** The id of the change it undid. */
  change: string;
  /** Who undid it: a person's name, or the agent's. */
  by: string;
  /** When, as an ISO 8601 time. */
  at: string;
  /** The ids of the elements it wrote back as they were before the change. */
  restored: string[];
  /** The elements it left as they were, since they changed after the change. */
  kept: KeptElement[];
}

/** The mark the board's array holds once changes left it, which tells a page that older changes aren't kept. */
export interface ChangesDropped {
  kind: 'dropped';
}

/** An agent's change as the page lists it: the change, and its first undo, or null where no one undid it. */
export interface ListedChange extends AgentChange {
  undo: AgentUndo | null;
}

/** The board's array of the agent's changes and their undos, in `doc`. */
export function agentChangesOf(doc: Y.Doc): Y.Array<unknown> {
  return doc.getArray<unknown>(AGENT_CHANGES);
}

/** Thrown where an undo can't run: the change isn't on the board, or someone undid it already. */
export class UndoError extends Error {}

/**
 * Runs `work`, and returns its result with each element of `elements` that a transaction of origin
 * `origin` wrote while it ran: the element before the first such write, and as the last one left it.
 * The tools pass their call's agent as the origin of the transaction that writes the change, so a
 * change that another call or a peer writes meanwhile isn't counted.
 */
export async function capturedChanges<T>(
  elements: Y.Map<unknown>,
  origin: unknown,
  work: () => Promise<T>,
): Promise<{ result: T; elements: ElementChange[] }> {
  const captured = new Map<string, ElementChange>();
  const observer = (event: Y.YMapEvent<unknown>, transaction: Y.Transaction): void => {
    if (transaction.origin !== origin) return;
    for (const [id, change] of event.changes.keys) {
      const after = copyOf(elements.get(id));
      const known = captured.get(id);
      if (known !== undefined) known.after = after;
      else captured.set(id, { id, before: change.action === 'add' ? null : copyOf(change.oldValue), after });
    }
  };
  elements.observe(observer);
  try {
    const result = await work();
    return { result, elements: [...captured.values()] };
  } finally {
    elements.unobserve(observer);
  }
}

/**
 * Records an agent's change on `changes`, and returns its id; returns null, and records nothing,
 * where the change didn't write any element. With `board`, the board's elements, it drops in the
 * same transaction each earlier change that the board no longer shows anything of, as
 * dropReplacedChanges does.
 */
export function recordAgentChange(
  changes: Y.Array<unknown>,
  change: { by: Creator; tool: string; summary: string; elements: ElementChange[]; now?: Date; board?: Y.Map<unknown> },
): string | null {
  if (change.elements.length === 0) return null;
  const record: AgentChange = {
    kind: 'change',
    id: newEntryId(),
    by: { kind: 'agent', name: change.by.name },
    at: (change.now ?? new Date()).toISOString(),
    tool: change.tool,
    summary: change.summary,
    elements: change.elements,
  };
  const { board } = change;
  inTransaction(changes, () => {
    changes.push([record]);
    if (board !== undefined) dropReplacedChanges(board, changes);
  });
  return record.id;
}

/**
 * The agent's changes that `changes` records, newest first, each with its first undo in the
 * array's order, or null. A change made later comes first, and of two changes made at the same
 * time, the later one in the array, so every participant, whose array holds the same records in the
 * same order once their copies meet, lists them in the same order.
 */
export function listAgentChanges(changes: Y.Array<unknown>): ListedChange[] {
  return listedIn(changes.toArray());
}

/** How an undo runs: who undoes the change, the agent where an agent does, the time, and the transaction's origin. */
export interface UndoOptions {
  /** Who undoes it: a person's name, or the agent's. */
  by: string;
  /** The agent that undoes it, where an agent does: each element it writes records the agent as the author of its version. */
  agent?: Creator;
  now?: Date;
  /** The origin of the transaction that writes the undo. */
  origin?: unknown;
}

/**
 * Undoes the agent's change `id` on the board, for every participant: writes each element the change
 * wrote back as it was before the change, and deletes each element the change added, in one
 * transaction with the undo's record. An element that changed after the change, as where a person
 * moved, relabelled or deleted it since, stays as it is, and the undo names it among `kept`. A
 * change of what a page changes as it shows an element, such as a text's place and size as the page
 * measures it again, or the element's version, isn't counted. Throws an UndoError where the board
 * doesn't record the change, or where someone undid it already.
 */
export function undoAgentChange(
  elements: Y.Map<unknown>,
  changes: Y.Array<unknown>,
  id: string,
  options: UndoOptions,
): AgentUndo {
  const listed = listAgentChanges(changes).find((change) => change.id === id);
  if (listed === undefined) {
    throw new UndoError(
      `The board doesn't record an agent's change ${id}: a change leaves the list once the board no longer shows anything it wrote, so give an id that the change list shows.`,
    );
  }
  if (listed.undo !== null) {
    throw new UndoError(`${listed.undo.by} undid the change ${id}, "${listed.summary}", at ${listed.undo.at} already.`);
  }
  const doc = changes.doc;
  if (doc === null) throw new UndoError("The change list isn't on a board.");
  const now = options.now ?? new Date();
  const board = [...elements.values()];
  const undo: AgentUndo = {
    kind: 'undo',
    id: newEntryId(),
    change: id,
    by: options.by,
    at: now.toISOString(),
    restored: [],
    kept: [],
  };
  const writes: [string, Record<string, unknown>][] = [];
  for (const { id: element, before, after } of listed.elements) {
    const current = elements.get(element);
    if (contentOf(current) !== contentOf(after)) {
      undo.kept.push({ id: element, name: nameOf(current ?? after ?? before, board) });
      continue;
    }
    const base = recordOf(before ?? current);
    if (base === undefined) continue;
    const restored: Record<string, unknown> = before === null ? { ...base, isDeleted: true } : structuredClone(base);
    restored.version = Math.max(versionOf(current), versionOf(before)) + 1;
    restored.versionNonce = Math.trunc(Math.random() * 2 ** 31);
    restored.updated = now.getTime();
    const marked = withDrawingChanged(withWordsChanged(restored, current), current);
    writes.push([element, options.agent === undefined ? marked : withChange(marked, options.agent)]);
    undo.restored.push(element);
  }
  doc.transact(() => {
    for (const [element, value] of writes) elements.set(element, value);
    changes.push([undo]);
  }, options.origin);
  return undo;
}

/**
 * Drops from `changes` each agent's change that the board, whose elements `elements` holds, no
 * longer shows anything of, with its undos, and returns the ids of the changes it dropped. An
 * element counts for one change at most: the newest change that no one undid whose Undo would write
 * the element back, since the board shows the element as the change left it, or, where no such
 * change counts it, the newest undone change whose undo the board shows the element as. A change
 * stays while an element counts for it, so the array keeps at most one change for each element of
 * the board, without a count or a size chosen for it. It drops too each undo of a change that the
 * array doesn't hold and each undo of a change after its first, and, where it drops a change, keeps
 * one ChangesDropped mark on the array, which tells a page that older changes aren't kept. It
 * writes in one transaction, and doesn't write anything where it doesn't drop a record.
 */
export function dropReplacedChanges(elements: Y.Map<unknown>, changes: Y.Array<unknown>): string[] {
  const records = changes.toArray();
  const listed = listedIn(records);
  const counted = new Set<string>();
  const shown = new Set<string>();
  // Counts for `change` each element of it that no change counts yet, where the board shows the
  // element as `target` returns it.
  const count = (change: ListedChange, target: (element: ElementChange) => unknown): void => {
    for (const element of change.elements) {
      const wanted = target(element);
      if (counted.has(element.id) || wanted === undefined) continue;
      if (contentOf(elements.get(element.id)) !== contentOf(wanted)) continue;
      counted.add(element.id);
      shown.add(change.id);
    }
  };
  for (const change of listed) if (change.undo === null) count(change, (element) => element.after);
  for (const change of listed) {
    const { undo } = change;
    if (undo !== null) count(change, (element) => undoneTo(undo, element));
  }
  const dropped = listed.filter((change) => !shown.has(change.id)).map((change) => change.id);
  const undos = new Set(listed.flatMap((change) => (change.undo !== null && shown.has(change.id) ? [change.undo.id] : [])));
  const places: number[] = [];
  let marked = false;
  records.forEach((value, place) => {
    const change = readChange(value);
    const undo = readUndo(value);
    if (change !== undefined) {
      if (!shown.has(change.id)) places.push(place);
    } else if (undo !== undefined) {
      if (!undos.has(undo.id)) places.push(place);
    } else if (isDropped(value)) {
      if (marked) places.push(place);
      marked = true;
    }
  });
  const mark = dropped.length > 0 && !marked;
  if (places.length === 0 && !mark) return dropped;
  inTransaction(changes, () => {
    for (const place of places.reverse()) changes.delete(place, 1);
    if (mark) changes.push([{ kind: 'dropped' } satisfies ChangesDropped]);
  });
  return dropped;
}

/** Whether `changes` holds the ChangesDropped mark: whether older changes left it, which a page's list says. */
export function olderChangesDropped(changes: Y.Array<unknown>): boolean {
  return changes.toArray().some(isDropped);
}

/** The fields that change with each new version of an element, whatever changed in it. */
const VERSION_FIELDS = ['version', 'versionNonce', 'updated'];

/** The fields of a text that a page changes as it measures the text again. */
const MEASURED_FIELDS = ['x', 'y', 'width', 'height', 'fontFamily', 'lineHeight', 'baseline'];

/**
 * What an undo compares of `element` with the element as the agent's change left it: the element's
 * JSON, its members in order, without its version, its nonce, its time and Chalkline's member of its
 * custom data, which the marks hold, and of a text without its place, its size, its font and its
 * wrapped words, which a page sets as it measures the text again. "null" where it is absent.
 */
export function contentOf(element: unknown): string {
  const record = recordOf(element);
  if (record === undefined) return JSON.stringify(element ?? null);
  const compared: Record<string, unknown> = { ...record };
  for (const field of VERSION_FIELDS) delete compared[field];
  const customData = recordOf(compared.customData);
  if (customData !== undefined) {
    const rest: Record<string, unknown> = { ...customData };
    delete rest[CUSTOM_DATA];
    if (Object.keys(rest).length === 0) delete compared.customData;
    else compared.customData = rest;
  }
  if (compared.type === 'text') {
    for (const field of MEASURED_FIELDS) delete compared[field];
    if (typeof compared.originalText === 'string') delete compared.text;
  }
  return JSON.stringify(sorted(compared));
}

/** How a page names each type of element to people. */
const KINDS: Record<string, string> = {
  rectangle: 'rectangle',
  ellipse: 'ellipse',
  diamond: 'diamond',
  arrow: 'arrow',
  line: 'line',
  freedraw: 'freehand stroke',
  text: 'text',
  image: 'image',
  frame: 'frame',
  magicframe: 'frame',
  embeddable: 'embedded page',
  iframe: 'embedded page',
};

/** The most characters of a shape's words that its name quotes. */
const QUOTED = 40;

/**
 * The name of `element` for people, with its label or its words, which `board`, the board's
 * elements, holds: such as `the rectangle "Login"`, `an ellipse` or `the text "Hello"`.
 */
export function nameOf(element: unknown, board: Iterable<unknown>): string {
  const record = recordOf(element) ?? {};
  const type = typeof record.type === 'string' ? record.type : 'shape';
  if (type === 'text') {
    const what = typeof record.containerId === 'string' ? 'label' : 'text';
    const words = wordsIn(record);
    return words === undefined ? `a ${what}` : `the ${what} "${words}"`;
  }
  const kind = KINDS[type] ?? type;
  const labels: Record<string, unknown>[] = [];
  for (const value of board) {
    const candidate = recordOf(value);
    if (candidate?.type === 'text' && candidate.containerId === record.id) labels.push(candidate);
  }
  const label = labels.find((candidate) => candidate.isDeleted !== true) ?? labels[0];
  const words = label === undefined ? undefined : wordsIn(label);
  if (words !== undefined) return `the ${kind} "${words}"`;
  return `${/^[aeiou]/.test(kind) ? 'an' : 'a'} ${kind}`;
}

/** The words of a text, on one line, shortened to QUOTED characters, or undefined where it doesn't hold any. */
function wordsIn(text: Record<string, unknown>): string | undefined {
  const raw = typeof text.originalText === 'string' ? text.originalText : text.text;
  if (typeof raw !== 'string') return undefined;
  const words = raw.replace(/\s+/g, ' ').trim();
  if (words === '') return undefined;
  return words.length > QUOTED ? `${words.slice(0, QUOTED)}...` : words;
}

/** The change `value` records, or undefined where it isn't a change of this form. */
function readChange(value: unknown): AgentChange | undefined {
  const record = recordOf(value);
  if (record?.kind !== 'change') return undefined;
  const by = recordOf(record.by);
  const { id, at, tool, summary, elements } = record;
  if (typeof id !== 'string' || typeof at !== 'string' || typeof tool !== 'string' || typeof summary !== 'string') return undefined;
  if (by?.kind !== 'agent' || typeof by.name !== 'string' || !Array.isArray(elements)) return undefined;
  const written: ElementChange[] = [];
  for (const entry of elements) {
    const element = recordOf(entry);
    if (element === undefined || typeof element.id !== 'string') return undefined;
    written.push({ id: element.id, before: element.before ?? null, after: element.after ?? null });
  }
  return { kind: 'change', id, by: { kind: 'agent', name: by.name }, at, tool, summary, elements: written };
}

/** The undo `value` records, or undefined where it isn't an undo of this form. */
function readUndo(value: unknown): AgentUndo | undefined {
  const record = recordOf(value);
  if (record?.kind !== 'undo') return undefined;
  const { id, change, by, at, restored, kept } = record;
  if (typeof id !== 'string' || typeof change !== 'string' || typeof by !== 'string' || typeof at !== 'string') return undefined;
  if (!Array.isArray(restored) || !restored.every((entry) => typeof entry === 'string')) return undefined;
  if (!Array.isArray(kept)) return undefined;
  const left: KeptElement[] = [];
  for (const entry of kept) {
    const element = recordOf(entry);
    if (element === undefined || typeof element.id !== 'string' || typeof element.name !== 'string') return undefined;
    left.push({ id: element.id, name: element.name });
  }
  return { kind: 'undo', id, change, by, at, restored: [...restored], kept: left };
}

/** The changes `records` holds, as listAgentChanges lists them. */
function listedIn(records: unknown[]): ListedChange[] {
  const undos = new Map<string, AgentUndo>();
  for (const value of records) {
    const undo = readUndo(value);
    if (undo !== undefined && !undos.has(undo.change)) undos.set(undo.change, undo);
  }
  const listed: { change: ListedChange; place: number }[] = [];
  records.forEach((value, place) => {
    const change = readChange(value);
    if (change !== undefined) listed.push({ change: { ...change, undo: undos.get(change.id) ?? null }, place });
  });
  listed.sort((a, b) => timeOf(b.change.at) - timeOf(a.change.at) || b.place - a.place);
  return listed.map(({ change }) => change);
}

/**
 * `element` as the undo `undo` wrote it, which the board shows while no one changed it since: as it
 * was before the change, or, where the change added it, as the change left it, deleted; undefined
 * where the undo left it as it was.
 */
function undoneTo(undo: AgentUndo, { id, before, after }: ElementChange): unknown {
  if (!undo.restored.includes(id)) return undefined;
  return before ?? { ...(recordOf(after) ?? {}), isDeleted: true };
}

/** Whether `value` is the ChangesDropped mark. */
function isDropped(value: unknown): boolean {
  return recordOf(value)?.kind === 'dropped';
}

/** Runs `work` in one transaction of the doc that `changes` is on, or alone where it isn't on a doc. */
function inTransaction(changes: Y.Array<unknown>, work: () => void): void {
  const doc = changes.doc;
  if (doc === null) work();
  else doc.transact(work);
}

/** The milliseconds since the epoch of the ISO 8601 time `at`, or 0 where it doesn't parse. */
function timeOf(at: string): number {
  const time = Date.parse(at);
  return Number.isFinite(time) ? time : 0;
}

/** The version `element` holds, or 0. */
function versionOf(element: unknown): number {
  const version = recordOf(element)?.version;
  return typeof version === 'number' && Number.isFinite(version) ? version : 0;
}

/** A copy of `value`, or null where it is undefined. */
function copyOf(value: unknown): unknown {
  return value === undefined ? null : structuredClone(value);
}

/** `value` as a record, or undefined where it isn't an object. */
function recordOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

/** `value` with the members of each object in order, so that its JSON doesn't depend on the order they were set in. */
function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  const record = recordOf(value);
  if (record === undefined) return value;
  return Object.fromEntries(
    Object.keys(record)
      .sort()
      .map((key) => [key, sorted(record[key])]),
  );
}
