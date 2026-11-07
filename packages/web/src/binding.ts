import { withWordsChanged } from '@chalkline/mcp/creator';
import * as Y from 'yjs';

/** The fields of an Excalidraw element that decide which copy of it wins. */
export interface VersionedElement {
  readonly id: string;
  readonly version: number;
  readonly versionNonce: number;
  /** Excalidraw's fractional index, which orders elements from back to front. */
  readonly index?: string | null;
}

/** The transaction origin of the binding's writes to the shared map. */
export const LOCAL = Symbol('chalkline.local');

/**
 * Whether `candidate` replaces `current`: the higher version wins, and of two
 * equal versions the lower nonce, as Excalidraw's reconciliation decides.
 */
export function wins(candidate: VersionedElement, current: VersionedElement): boolean {
  if (candidate.version !== current.version) return candidate.version > current.version;
  return candidate.versionNonce < current.versionNonce;
}

/** The local elements that the shared map lacks, or holds an older copy of. */
export function localChanges<T extends VersionedElement>(shared: Y.Map<T>, local: readonly T[]): T[] {
  return local.filter((element) => {
    const current = shared.get(element.id);
    return current === undefined || wins(element, current);
  });
}

export interface Merged<T> {
  /** The winning copy of each element, ordered by fractional index. */
  elements: T[];
  /** The local elements that won, which the shared map should take. */
  keep: T[];
  /** The shared copies among `elements`, which the canvas lacks or holds an older copy of. */
  taken: T[];
}

/**
 * Merges the canvas's elements with the shared map's, element by element. Where the shared map
 * holds the same copy of an element as the canvas, `elements` holds the canvas's own object of it.
 */
export function mergeShared<T extends VersionedElement>(local: readonly T[], shared: Iterable<T>): Merged<T> {
  const byId = new Map<string, T>();
  for (const element of shared) byId.set(element.id, element);
  const keep: T[] = [];
  for (const element of local) {
    const current = byId.get(element.id);
    if (current === undefined || wins(element, current)) keep.push(element);
    if (current === undefined || !wins(current, element)) byId.set(element.id, element);
  }
  const ours = new Set<T>(local);
  const elements = [...byId.values()].sort(byIndex);
  return { elements, keep, taken: elements.filter((element) => !ours.has(element)) };
}

// Fractional indices compare as plain strings. An element without one goes
// last, and two elements with the same index go in the order of their ids.
function byIndex(a: VersionedElement, b: VersionedElement): number {
  const left = a.index ?? null;
  const right = b.index ?? null;
  if (left !== right) {
    if (left === null) return 1;
    if (right === null) return -1;
    return left < right ? -1 : 1;
  }
  if (a.id === b.id) return 0;
  return a.id < b.id ? -1 : 1;
}

/** The canvas that `bindElements` keeps in step with the shared map. */
export interface Canvas<T> {
  /** Every element on the canvas, deleted ones included. */
  elements(): readonly T[];
  replace(elements: T[]): void;
  /** Calls `handler` after each change on the canvas, and returns a function that stops it. */
  onChange(handler: () => void): () => void;
}

/**
 * Keeps `canvas` and the shared map of elements in step: each local edit goes
 * to the map, and each change from a peer goes to the canvas. Each side gets a
 * copy, so neither holds an object that the other changes. Returns a function
 * that stops the binding. The map's copy of each text records its words and
 * when they last changed, as `withWordsChanged` writes them, which the canvas's
 * own object of the text doesn't hold.
 */
export function bindElements<T extends VersionedElement>(shared: Y.Map<T>, canvas: Canvas<T>): () => void {
  const doc = shared.doc;
  if (doc === null) throw new Error('bindElements needs a map that belongs to a Y.Doc');

  const write = (elements: readonly T[]) => {
    if (elements.length === 0) return;
    doc.transact(() => {
      // A listener that receives only the newest copy of a text, as a peer's copy of the board holds
      // it, tells a move of the text from new words by the time the copy records for its words.
      for (const element of elements) {
        shared.set(element.id, structuredClone(withWordsChanged(element, shared.get(element.id))));
      }
    }, LOCAL);
  };
  const pull = () => {
    const { elements, keep, taken } = mergeShared(canvas.elements(), shared.values());
    // The canvas gets a copy of each element a peer changed or added, and keeps its own object of
    // every other element: Excalidraw keeps each element's drawing by its object, so a new object
    // of every element on each change would draw the whole board again. Where no shared copy won,
    // the canvas stays as it is.
    if (taken.length > 0) {
      const copies = new Set(taken);
      canvas.replace(elements.map((element) => (copies.has(element) ? structuredClone(element) : element)));
    }
    write(keep);
  };
  const push = () => write(localChanges(shared, canvas.elements()));
  const observer = (_event: Y.YMapEvent<T>, transaction: Y.Transaction) => {
    if (transaction.origin !== LOCAL) pull();
  };

  shared.observe(observer);
  const stop = canvas.onChange(push);
  pull();
  return () => {
    shared.unobserve(observer);
    stop();
  };
}
