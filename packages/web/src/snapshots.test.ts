import 'fake-indexeddb/auto';
import { connectDoc, MemoryNetwork, snapshotsOf, writeSnapshotMark, type SnapshotMark } from '@chalkline/sync';
import { afterEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { bindElements, type Canvas } from './binding';
import { storeName, STORE_PREFIX } from './keep';
import {
  keepSnapshots,
  openSnapshotStore,
  SNAPSHOT_INTERVAL_MS,
  SNAPSHOT_PREFIX,
  snapshotStoreName,
  type Snapshot,
  type SnapshotKeeper,
  type SnapshotStore,
  type SnapshotSummary,
} from './snapshots';

interface Shape {
  id: string;
  type: string;
  version: number;
  versionNonce: number;
  index: string;
  isDeleted: boolean;
  containerId?: string | null;
}

function shape(id: string, version = 1, fields: Partial<Shape> = {}): Shape {
  return { id, type: 'rectangle', version, versionNonce: 1, index: `a${id}`, isDeleted: false, ...fields };
}

/** `count` rectangles, s000 and on, from back to front. */
function shapes(count: number): Shape[] {
  return Array.from({ length: count }, (_, n) => shape(`s${String(n).padStart(3, '0')}`));
}

/** `element` as Excalidraw deletes it: marked deleted, at its next version. */
const deleted = (element: Shape): Shape => ({ ...element, version: element.version + 1, isDeleted: true });

/** `element` at its next version, as an edit of it writes it. */
const edited = (element: Shape): Shape => ({ ...element, version: element.version + 1 });

/** A mark that claude-code's helper wrote, which `fields` change. */
const mark = (id: string, fields: Partial<SnapshotMark> = {}): SnapshotMark => ({
  id,
  by: 'claude-code',
  at: '2026-11-07T18:00:00.000Z',
  label: null,
  shapes: 2,
  ...fields,
});

const START = Date.parse('2026-11-07T18:00:00.000Z');

/** A clock that starts at START and moves only as the test moves it. */
function clock() {
  let time = START;
  return {
    now: () => time,
    advance: (ms: number) => {
      time += ms;
    },
  };
}

let names = 0;
/** A database name that no other test uses. */
function freshName(): string {
  names += 1;
  return `test-snapshots-${names}`;
}

const keepers: SnapshotKeeper<Shape>[] = [];
afterEach(async () => {
  await Promise.all(keepers.splice(0).map((keeper) => keeper.stop()));
});

/** Keeps snapshots of `doc`'s board in `store`, or in a database of its own, once it has read the store. */
async function keeper(
  doc: Y.Doc,
  options: { now?: () => number; store?: SnapshotStore<Shape>; errors?: unknown[] } = {},
): Promise<SnapshotKeeper<Shape>> {
  const store = options.store ?? (await openSnapshotStore<Shape>(freshName()));
  const kept = keepSnapshots(doc.getMap<Shape>('elements'), snapshotsOf(doc), store, {
    now: options.now ?? clock().now,
    onError: (error) => options.errors?.push(error),
  });
  keepers.push(kept);
  await kept.settled();
  return kept;
}

/** Writes `elements` into `doc`'s board in one transaction. */
function put(doc: Y.Doc, elements: Shape[]): void {
  const map = doc.getMap<Shape>('elements');
  doc.transact(() => {
    for (const element of elements) map.set(element.id, element);
  });
}

/** The newest snapshot that `keeper` holds. */
function newest(keeper: SnapshotKeeper<Shape>): SnapshotSummary {
  const [first] = keeper.list();
  if (first === undefined) throw new Error("the keeper doesn't hold a snapshot");
  return first;
}

/** A canvas that the test edits, as Excalidraw's is, and that `bindElements` keeps in step with the board. */
function canvas(): Canvas<Shape> & { set(elements: Shape[]): void } {
  let elements: Shape[] = [];
  const handlers = new Set<() => void>();
  return {
    elements: () => elements,
    replace: (next) => {
      elements = next;
    },
    onChange: (handler) => {
      handlers.add(handler);
      return () => {
        handlers.delete(handler);
      };
    },
    set: (next) => {
      elements = next;
      for (const handler of handlers) handler();
    },
  };
}

/** `store`, which refuses each write past `room` snapshots, as a browser's full storage does. */
function limited<T>(store: SnapshotStore<T>, room: number): SnapshotStore<T> {
  return {
    ...store,
    add: async (snapshot) => {
      if ((await store.list()).length >= room) throw new DOMException('The storage is full.', 'QuotaExceededError');
      return store.add(snapshot);
    },
  };
}

describe('keepSnapshots', () => {
  it('takes a snapshot of the board as it stood before the first change 10 minutes after the last, and none 9 minutes after', async () => {
    const doc = new Y.Doc();
    const map = doc.getMap<Shape>('elements');
    const time = clock();
    const snapshots = await keeper(doc, { now: time.now });

    // The board before the first change has no shapes, so the first change doesn't take a snapshot.
    put(doc, [shape('a'), shape('b'), shape('c')]);
    await snapshots.settled();
    expect(snapshots.list()).toEqual([]);

    map.set('a', shape('a', 2));
    await snapshots.settled();
    expect(snapshots.list()).toEqual([
      { id: expect.any(Number), at: START, reason: 'interval', label: null, mark: null, shapes: 3, deleted: null },
    ]);
    expect(await snapshots.elements(newest(snapshots).id)).toEqual([shape('a'), shape('b'), shape('c')]);

    time.advance(SNAPSHOT_INTERVAL_MS - 60_000);
    map.set('b', shape('b', 2));
    await snapshots.settled();
    expect(snapshots.list()).toHaveLength(1);

    time.advance(60_000);
    map.set('c', shape('c', 2));
    await snapshots.settled();
    expect(snapshots.list().map((each) => [each.reason, each.at])).toEqual([
      ['interval', START + SNAPSHOT_INTERVAL_MS],
      ['interval', START],
    ]);
    expect(await snapshots.elements(newest(snapshots).id)).toEqual([shape('a', 2), shape('b', 2), shape('c')]);
  });

  it("takes a snapshot before a peer's change deletes more than 50 shapes, and none before one that deletes 50", async () => {
    const network = new MemoryNetwork();
    const ada = new Y.Doc();
    const grace = new Y.Doc();
    connectDoc(ada, network.join('ada'));
    connectDoc(grace, network.join('grace'));
    const board = shapes(110);
    put(grace, board);
    network.flush();
    const snapshots = await keeper(ada);
    put(grace, [edited(shape('s000'))]);
    network.flush();
    await snapshots.settled();
    expect(snapshots.list().map((each) => each.reason)).toEqual(['interval']);

    put(grace, board.slice(1, 51).map(deleted));
    network.flush();
    await snapshots.settled();
    expect(snapshots.list().map((each) => each.reason)).toEqual(['interval']);

    put(grace, board.slice(51, 102).map(deleted));
    network.flush();
    await snapshots.settled();
    expect(newest(snapshots)).toMatchObject({ reason: 'deletion', shapes: 60, deleted: 51 });
    expect(await snapshots.elements(newest(snapshots).id)).toEqual([edited(shape('s000')), ...board.slice(51)]);
    expect(snapshots.list()).toHaveLength(2);
  });

  it('counts an element taken out of the board as deleted', async () => {
    const doc = new Y.Doc();
    const map = doc.getMap<Shape>('elements');
    const board = shapes(60);
    put(doc, board);
    const snapshots = await keeper(doc);
    put(doc, [edited(shape('s000'))]);

    doc.transact(() => {
      for (const element of board.slice(1, 52)) map.delete(element.id);
    });
    await snapshots.settled();

    expect(snapshots.list().map((each) => [each.reason, each.shapes, each.deleted])).toEqual([
      ['deletion', 60, 51],
      ['interval', 60, null],
    ]);
  });

  it.each([
    { count: 51, reasons: ['deletion', 'interval'] },
    { count: 50, reasons: ['interval'] },
  ])('takes a snapshot before Reset the canvas deletes more than 50 shapes: $count shapes, $reasons', async ({ count, reasons }) => {
    const doc = new Y.Doc();
    const page = canvas();
    bindElements(doc.getMap<Shape>('elements'), page);
    page.set(shapes(count));
    const snapshots = await keeper(doc);
    page.set(page.elements().map((element, n) => (n === 0 ? edited(element) : element)));
    await snapshots.settled();
    expect(snapshots.list()).toHaveLength(1);

    // Reset the canvas marks each element of the canvas deleted, in one change.
    page.set(page.elements().map(deleted));
    await snapshots.settled();

    expect(snapshots.list().map((each) => each.reason)).toEqual(reasons);
    if (count > 50) expect(newest(snapshots)).toMatchObject({ shapes: count, deleted: count });
  });

  it('takes a snapshot of the board after a change that adds a mark, one for the newest mark of a change, and none for a mark it recorded', async () => {
    const name = freshName();
    const doc = new Y.Doc();
    const marks = snapshotsOf(doc);
    put(doc, [shape('a'), shape('box-label', 1, { type: 'text', containerId: 'a' }), shape('b')]);
    const snapshots = await keeper(doc, { store: await openSnapshotStore<Shape>(name) });

    doc.transact(() => {
      writeSnapshotMark(marks, mark('first'));
      writeSnapshotMark(marks, mark('second', { at: '2026-11-07T18:00:01.000Z', label: 'before the redesign' }));
    });
    await snapshots.settled();
    expect(snapshots.list()).toEqual([
      { id: expect.any(Number), at: START, reason: 'mark', label: 'before the redesign', mark: 'second', shapes: 2, deleted: null },
    ]);
    expect(await snapshots.elements(newest(snapshots).id)).toEqual([
      shape('a'),
      shape('b'),
      shape('box-label', 1, { type: 'text', containerId: 'a' }),
    ]);

    // A mark written again, and an older mark of the same change, don't take another.
    writeSnapshotMark(marks, mark('second', { at: '2026-11-07T18:00:01.000Z', label: 'before the redesign' }));
    writeSnapshotMark(marks, mark('first', { label: 'again' }));
    await snapshots.settled();
    expect(snapshots.list()).toHaveLength(1);

    // A browser that loads the board again, marks and all, in one change, doesn't take one either.
    const reloaded = new Y.Doc();
    const again = await keeper(reloaded, { store: await openSnapshotStore<Shape>(name) });
    Y.applyUpdate(reloaded, Y.encodeStateAsUpdate(doc));
    await again.settled();
    expect(again.list()).toHaveLength(1);

    writeSnapshotMark(marks, mark('third', { at: '2026-11-07T18:05:00.000Z' }));
    await snapshots.settled();
    expect(snapshots.list().map((each) => each.mark)).toEqual(['third', 'second']);
  });

  it("doesn't take a snapshot of a board without shapes, nor one whose elements match the last snapshot's", async () => {
    const doc = new Y.Doc();
    const map = doc.getMap<Shape>('elements');
    const time = clock();
    const snapshots = await keeper(doc, { now: time.now });
    const label = (version: number) => shape('label', version, { type: 'text', containerId: 'gone' });

    // A board that holds a container's bound text and a deleted shape alone has no shapes.
    writeSnapshotMark(snapshotsOf(doc), mark('empty', { shapes: 0 }));
    put(doc, [label(1), shape('gone', 2, { isDeleted: true })]);
    map.set('label', label(2));
    await snapshots.settled();
    expect(snapshots.list()).toEqual([]);

    put(doc, [shape('a')]);
    // A deleted element doesn't change the board's snapshot.
    map.set('b', shape('b', 1, { isDeleted: true }));
    await snapshots.settled();
    expect(snapshots.list()).toHaveLength(1);
    time.advance(SNAPSHOT_INTERVAL_MS);
    map.set('c', shape('c'));
    await snapshots.settled();
    expect(snapshots.list()).toHaveLength(1);

    map.set('d', shape('d'));
    await snapshots.settled();
    expect(snapshots.list().map((each) => each.at)).toEqual([START + SNAPSHOT_INTERVAL_MS, START]);
    expect(await snapshots.elements(newest(snapshots).id)).toEqual([shape('a'), shape('c'), label(2)]);
  });

  it("removes its oldest snapshot where the browser's storage refuses a write, and says where it couldn't keep one", async () => {
    const doc = new Y.Doc();
    const map = doc.getMap<Shape>('elements');
    const time = clock();
    const snapshots = await keeper(doc, { now: time.now, store: limited(await openSnapshotStore<Shape>(freshName()), 2) });
    put(doc, [shape('a')]);
    for (const version of [2, 3, 4]) {
      map.set('a', shape('a', version));
      await snapshots.settled();
      time.advance(SNAPSHOT_INTERVAL_MS);
    }

    expect(snapshots.list().map((each) => each.at)).toEqual([START + 2 * SNAPSHOT_INTERVAL_MS, START + SNAPSHOT_INTERVAL_MS]);
    expect(await snapshots.elements(newest(snapshots).id)).toEqual([shape('a', 3)]);
    expect(snapshots.lost()).toBe(false);

    const full = new Y.Doc();
    const errors: unknown[] = [];
    const refused = await keeper(full, { store: limited(await openSnapshotStore<Shape>(freshName()), 0), errors });
    let changes = 0;
    refused.onChange(() => {
      changes += 1;
    });
    put(full, [shape('a')]);
    put(full, [shape('a', 2)]);
    await refused.settled();

    expect(refused.list()).toEqual([]);
    expect(refused.lost()).toBe(true);
    expect(changes).toBe(1);
    expect(errors).toEqual([expect.objectContaining({ name: 'QuotaExceededError' })]);
  });
});

describe('the snapshot store', () => {
  it("names its database with the room's name and the digest that the kept board's name holds", async () => {
    const secrets = { room: 'standup', key: 'a-password' };
    const name = await snapshotStoreName(secrets);

    expect(name).toMatch(/^chalkline-snapshots-standup-[0-9a-f]{32}$/);
    expect(name.startsWith(SNAPSHOT_PREFIX)).toBe(true);
    expect(name.slice(SNAPSHOT_PREFIX.length)).toBe((await storeName(secrets)).slice(STORE_PREFIX.length));
    expect(name).not.toContain('a-password');
    expect(await snapshotStoreName({ room: 'standup', key: 'another-password' })).not.toBe(name);
  });

  it('keeps each snapshot through a reload, lists them oldest first, and removes the oldest', async () => {
    const name = freshName();
    const snapshot = (at: number, elements: Shape[], fields: Partial<Snapshot<Shape>> = {}): Snapshot<Shape> => ({
      at,
      reason: 'interval',
      label: null,
      mark: null,
      shapes: elements.length,
      deleted: null,
      elements,
      ...fields,
    });
    const first = await openSnapshotStore<Shape>(name);
    const one = await first.add(snapshot(START, [shape('a')]));
    const two = await first.add(snapshot(START + 1, [shape('a', 2), shape('b')], { reason: 'deletion', deleted: 51 }));
    first.close();

    const second = await openSnapshotStore<Shape>(name);

    expect(await second.list()).toEqual([
      { id: one, at: START, reason: 'interval', label: null, mark: null, shapes: 1, deleted: null },
      { id: two, at: START + 1, reason: 'deletion', label: null, mark: null, shapes: 2, deleted: 51 },
    ]);
    expect(await second.elements(two)).toEqual([shape('a', 2), shape('b')]);
    expect(await second.elements(two + 1)).toBeNull();
    expect(await second.removeOldest()).toBe(true);
    expect((await second.list()).map((each) => each.id)).toEqual([two]);
    expect(await second.removeOldest()).toBe(true);
    expect(await second.removeOldest()).toBe(false);
    second.close();
  });
});
