import { isShape, listSnapshotMarks, shapeCount } from '@chalkline/sync';
import type * as Y from 'yjs';
import { byIndex, type VersionedElement } from './binding';
import { STORE_PREFIX, storeName } from './keep';
import type { RoomSecrets } from './room';

/** The start of the name of each IndexedDB database that keeps a board's snapshots in a browser. */
export const SNAPSHOT_PREFIX = 'chalkline-snapshots-';

/** How long a board goes without a snapshot before its next change takes one: 10 minutes. */
export const SNAPSHOT_INTERVAL_MS = 10 * 60 * 1000;

/** The most shapes that one change deletes without a snapshot of the board before it. */
export const LARGE_DELETION = 50;

/** The object store of a snapshots database. */
const STORE = 'snapshots';

/** Why a browser took a snapshot. */
export type SnapshotReason = 'interval' | 'deletion' | 'mark';

const REASONS: readonly string[] = ['interval', 'deletion', 'mark'];

/** The fields of a board's element that a snapshot reads. */
export interface SnapshotElement extends VersionedElement {
  readonly isDeleted?: boolean;
}

/** A snapshot of the board, as the browser keeps it. */
export interface Snapshot<T> {
  /** The browser's time when it took the snapshot, in milliseconds since 1970. */
  at: number;
  reason: SnapshotReason;
  /** The mark's label, for a mark's snapshot; null for any other. */
  label: string | null;
  /** The mark's id, for a mark's snapshot; null for any other. */
  mark: string | null;
  /** How many shapes the snapshot holds. */
  shapes: number;
  /** How many shapes the change deleted, for a deletion's snapshot; null for any other. */
  deleted: number | null;
  /** Each element of the board that isn't deleted, bound text among them, from back to front. */
  elements: T[];
}

/** A snapshot as a list shows it: its key in the store, and each of its fields but its elements. */
export interface SnapshotSummary {
  id: number;
  at: number;
  reason: SnapshotReason;
  label: string | null;
  mark: string | null;
  shapes: number;
  deleted: number | null;
}

/** The snapshots that a browser keeps of one board. */
export interface SnapshotStore<T> {
  /** Adds `snapshot`, and resolves with its key once the write is committed. */
  add(snapshot: Snapshot<T>): Promise<number>;
  /** Removes the oldest snapshot, and resolves with whether the store held one. */
  removeOldest(): Promise<boolean>;
  /** Each snapshot of the store, oldest first, without its elements. */
  list(): Promise<SnapshotSummary[]>;
  /** The elements of the snapshot keyed `id`, or null where the store doesn't hold it. */
  elements(id: number): Promise<T[] | null>;
  /** Closes the store's database. */
  close(): void;
}

/**
 * The name of the IndexedDB database that keeps the snapshots of the board of `secrets` in this browser: the
 * prefix, then the room's name and the 32 hex digits that `storeName` puts after the kept board's prefix. So two
 * rooms of one name and different passwords keep separate snapshots, and the name doesn't hold the password.
 */
export async function snapshotStoreName(secrets: RoomSecrets): Promise<string> {
  return SNAPSHOT_PREFIX + (await storeName(secrets)).slice(STORE_PREFIX.length);
}

/** Whether `error` is the error of a write that the browser's storage refused for want of room. */
export function isQuotaError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { name?: unknown }).name === 'QuotaExceededError';
}

/** Resolves once `transaction` commits, and rejects where it fails or aborts. */
function committed(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error ?? new DOMException('The write was aborted.', 'AbortError'));
  });
}

function readSummary(id: IDBValidKey, value: unknown): SnapshotSummary | null {
  if (typeof id !== 'number' || typeof value !== 'object' || value === null) return null;
  const { at, reason, label, mark, shapes, deleted } = value as Record<string, unknown>;
  if (typeof at !== 'number' || typeof reason !== 'string' || !REASONS.includes(reason)) return null;
  if (typeof shapes !== 'number') return null;
  return {
    id,
    at,
    reason: reason as SnapshotReason,
    label: typeof label === 'string' ? label : null,
    mark: typeof mark === 'string' ? mark : null,
    shapes,
    deleted: typeof deleted === 'number' ? deleted : null,
  };
}

/**
 * Opens the IndexedDB database `name`, which keeps a board's snapshots in this browser: its object store
 * `snapshots` holds one record for each snapshot, keyed by an increasing number, so the oldest snapshot has the
 * lowest key.
 */
export function openSnapshotStore<T>(name: string, factory: IDBFactory = indexedDB): Promise<SnapshotStore<T>> {
  return new Promise((resolve, reject) => {
    const request = factory.open(name, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(STORE, { autoIncrement: true });
    };
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      // A later version of the page that changes the database waits for this one to close it.
      db.onversionchange = () => db.close();
      resolve({
        add: async (snapshot) => {
          const transaction = db.transaction(STORE, 'readwrite');
          const added = transaction.objectStore(STORE).add(snapshot);
          await committed(transaction);
          return added.result as number;
        },
        removeOldest: async () => {
          const transaction = db.transaction(STORE, 'readwrite');
          const store = transaction.objectStore(STORE);
          const cursor = store.openKeyCursor();
          let removed = false;
          cursor.onsuccess = () => {
            if (cursor.result === null) return;
            store.delete(cursor.result.primaryKey);
            removed = true;
          };
          await committed(transaction);
          return removed;
        },
        list: async () => {
          const transaction = db.transaction(STORE, 'readonly');
          const cursor = transaction.objectStore(STORE).openCursor();
          const summaries: SnapshotSummary[] = [];
          cursor.onsuccess = () => {
            if (cursor.result === null) return;
            const summary = readSummary(cursor.result.primaryKey, cursor.result.value);
            if (summary !== null) summaries.push(summary);
            cursor.result.continue();
          };
          await committed(transaction);
          return summaries;
        },
        elements: async (id) => {
          const transaction = db.transaction(STORE, 'readonly');
          const read = transaction.objectStore(STORE).get(id);
          await committed(transaction);
          const value: unknown = read.result;
          if (typeof value !== 'object' || value === null) return null;
          const { elements } = value as { elements?: unknown };
          return Array.isArray(elements) ? (elements as T[]) : null;
        },
        close: () => db.close(),
      });
    };
  });
}

/** When the keeper reads the time, and where it reports a snapshot it couldn't keep. */
export interface KeepOptions {
  /** The time now, in milliseconds since 1970: `Date.now` unless a test sets another clock. */
  now?: () => number;
  /** Called where a snapshot couldn't be kept, with the error that stopped it. */
  onError?: (error: unknown) => void;
}

/** The snapshots that `keepSnapshots` keeps of a board. */
export interface SnapshotKeeper<T> {
  /** The snapshots the store holds, newest first, without their elements. */
  list(): SnapshotSummary[];
  /** The elements of the snapshot `id`, or null where the store doesn't hold it. */
  elements(id: number): Promise<T[] | null>;
  /** Whether the browser couldn't keep the last snapshot it took. */
  lost(): boolean;
  /** Calls `listener` after each write to the store, and returns a function that stops it. */
  onChange(listener: () => void): () => void;
  /** Resolves once each snapshot taken so far is written, or lost. */
  settled(): Promise<void>;
  /** Stops taking snapshots, waits for the writes of those taken, and closes the store. */
  stop(): Promise<void>;
}

/** The digest of a board that tells two snapshots apart: each element's id, version and nonce. */
function digest(elements: readonly SnapshotElement[]): string {
  return elements
    .map((element) => `${element.id}:${element.version}:${element.versionNonce}`)
    .sort()
    .join('\n');
}

/** The elements of `map` that aren't deleted, from back to front. */
function current<T extends SnapshotElement>(map: Y.Map<T>): T[] {
  return [...map.values()].filter((element) => element.isDeleted !== true).sort(byIndex);
}

/**
 * The elements of `map` that weren't deleted before the transaction whose change of keys is `changes`, from back
 * to front: the map after the transaction, with each key the transaction changed set back to its old value, and
 * each key it added left out.
 */
function before<T extends SnapshotElement>(map: Y.Map<T>, changes: Map<string, { action: string; oldValue: unknown }>): T[] {
  const elements: T[] = [];
  for (const [key, value] of map.entries()) {
    if (!changes.has(key)) elements.push(value);
  }
  for (const change of changes.values()) {
    if (change.action !== 'add') elements.push(change.oldValue as T);
  }
  return elements.filter((element) => element.isDeleted !== true).sort(byIndex);
}

/**
 * Keeps snapshots of the board in `store` (designs/chalkline A14), on each change of `elements`, whatever made it,
 * and on each change of `marks`:
 * - before a change that deletes more than 50 shapes, a snapshot of the board as it stood before it;
 * - otherwise, before a change where the last snapshot was taken at least 10 minutes before, or where none was, a
 *   snapshot of the board as it stood before the change;
 * - after a change that adds a mark that no snapshot records, a snapshot of the board as it stands, for the newest
 *   mark the change adds.
 * It doesn't take a snapshot of a board without shapes, nor a deletion's or an interval's snapshot whose elements
 * match the last snapshot's. It reads the time on each change, and never on a timer. It writes the snapshots one
 * at a time, in the order it takes them, and where the browser's storage refuses a write for want of room, it
 * removes the oldest snapshot and writes again, until the write succeeds or the store doesn't hold another
 * snapshot. A snapshot that it couldn't keep still counts as its last for the 10 minutes, so that a full storage
 * doesn't take a write on each change. It reads the store before its interval snapshots start.
 */
export function keepSnapshots<T extends SnapshotElement>(
  elements: Y.Map<T>,
  marks: Y.Map<unknown>,
  store: SnapshotStore<T>,
  options: KeepOptions = {},
): SnapshotKeeper<T> {
  const now = options.now ?? Date.now;
  const report = (error: unknown) => options.onError?.(error);
  const listeners = new Set<() => void>();
  const changed = () => {
    for (const listener of [...listeners]) listener();
  };
  /** The store's snapshots, newest first, as the keeper last read or wrote them. */
  let summaries: SnapshotSummary[] = [];
  /** The time and the digest of the last snapshot the keeper took, or of the newest the store held. */
  let last: { at: number; digest: string } | null = null;
  /** Each mark that a snapshot of the store records, or that a change added with a newer mark. */
  const recorded = new Set<string>();
  let loaded = false;
  let failed = false;

  let queue: Promise<void> = (async () => {
    summaries = (await store.list()).reverse();
    for (const summary of summaries) {
      if (summary.mark !== null) recorded.add(summary.mark);
    }
    const newest = summaries[0];
    if (last === null && newest !== undefined) {
      const held = (await store.elements(newest.id)) ?? [];
      if (last === null) last = { at: newest.at, digest: digest(held) };
    }
  })()
    .catch(report)
    .finally(() => {
      loaded = true;
      changed();
    });
  const enqueue = (job: () => Promise<void> | void) => {
    queue = queue.then(job).catch(report);
  };

  /** Writes `snapshot`, and removes the oldest snapshot for each write the browser refuses for want of room. */
  const keep = async (snapshot: Snapshot<T>): Promise<void> => {
    for (;;) {
      try {
        const id = await store.add(snapshot);
        const { at, reason, label, mark, shapes, deleted } = snapshot;
        summaries = [{ id, at, reason, label, mark, shapes, deleted }, ...summaries];
        failed = false;
        break;
      } catch (error) {
        let removed = false;
        if (isQuotaError(error)) {
          try {
            removed = await store.removeOldest();
          } catch (removal) {
            report(removal);
          }
        }
        if (!removed) {
          failed = true;
          report(error);
          break;
        }
        summaries = summaries.slice(0, -1);
      }
    }
    changed();
  };

  const onElements = (event: Y.YMapEvent<T>) => {
    const changes = event.changes.keys;
    let deleted = 0;
    for (const [key, change] of changes) {
      if (change.action === 'add' || !isShape(change.oldValue)) continue;
      const after = elements.get(key);
      if (after === undefined || after.isDeleted === true) deleted += 1;
    }
    const at = now();
    const large = deleted > LARGE_DELETION;
    if (!large && !(loaded && (last === null || at - last.at >= SNAPSHOT_INTERVAL_MS))) return;
    const board = before(elements, changes);
    const shapes = shapeCount(board);
    if (shapes === 0) return;
    const sum = digest(board);
    if (last !== null && last.digest === sum) return;
    last = { at, digest: sum };
    const snapshot: Snapshot<T> = {
      at,
      reason: large ? 'deletion' : 'interval',
      label: null,
      mark: null,
      shapes,
      deleted: large ? deleted : null,
      elements: board,
    };
    enqueue(() => keep(snapshot));
  };

  const onMarks = (event: Y.YMapEvent<unknown>) => {
    const added = listSnapshotMarks(marks).filter((mark) => event.keysChanged.has(mark.id));
    const newest = added[added.length - 1];
    if (newest === undefined) return;
    const board = current(elements);
    const at = now();
    enqueue(() => {
      const seen = recorded.has(newest.id);
      for (const mark of added) recorded.add(mark.id);
      const shapes = shapeCount(board);
      if (seen || shapes === 0) return;
      last = { at, digest: digest(board) };
      return keep({ at, reason: 'mark', label: newest.label, mark: newest.id, shapes, deleted: null, elements: board });
    });
  };

  elements.observe(onElements);
  marks.observe(onMarks);
  return {
    list: () => [...summaries],
    elements: (id) => store.elements(id),
    lost: () => failed,
    onChange: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    settled: () => queue,
    stop: async () => {
      elements.unobserve(onElements);
      marks.unobserve(onMarks);
      listeners.clear();
      await queue;
      store.close();
    },
  };
}
