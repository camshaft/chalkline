import { connectDoc, MemoryNetwork } from '@chalkline/sync';
import { describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import {
  agentChangesOf,
  capturedChanges,
  dropReplacedChanges,
  listAgentChanges,
  nameOf,
  olderChangesDropped,
  recordAgentChange,
  undoAgentChange,
  UndoError,
} from './agent-changes';
import { CUSTOM_DATA, changerOf, type Creator } from './creator';

type Element = Record<string, unknown>;

const AGENT: Creator = { kind: 'agent', name: 'Claude' };

/** A rectangle as a page draws it, with the fields an undo reads. */
function rectangle(id: string, fields: Element = {}): Element {
  return {
    id,
    type: 'rectangle',
    x: 0,
    y: 0,
    width: 100,
    height: 50,
    isDeleted: false,
    version: 1,
    versionNonce: 1,
    updated: 1,
    index: 'a0',
    ...fields,
  };
}

/** The label `text` of the shape `container`. */
function label(id: string, container: string, text: string, fields: Element = {}): Element {
  return {
    id,
    type: 'text',
    x: 10,
    y: 10,
    width: 80,
    height: 25,
    text,
    originalText: text,
    containerId: container,
    fontFamily: 5,
    isDeleted: false,
    version: 1,
    versionNonce: 1,
    updated: 1,
    index: 'a1',
    ...fields,
  };
}

interface Board {
  doc: Y.Doc;
  elements: Y.Map<unknown>;
  changes: Y.Array<unknown>;
}

function board(elements: Element[] = []): Board {
  const doc = new Y.Doc();
  const shared = doc.getMap<unknown>('elements');
  for (const element of elements) shared.set(String(element.id), element);
  return { doc, elements: shared, changes: agentChangesOf(doc) };
}

/**
 * Writes `elements` on the board as an agent's call does, in one transaction of the call's origin, and records the change;
 * with `dropping`, as chalkline-mcp records it, which drops each earlier change that the board no longer shows anything of.
 */
async function agentWrites({ doc, elements, changes }: Board, written: Element[], now?: Date, dropping = false): Promise<string> {
  const by: Creator = { ...AGENT };
  const captured = await capturedChanges(elements, by, async () => {
    doc.transact(() => {
      for (const element of written) elements.set(String(element.id), element);
    }, by);
  });
  const id = recordAgentChange(changes, {
    by,
    tool: 'update_shape',
    summary: 'Claude changed the board',
    elements: captured.elements,
    now,
    board: dropping ? elements : undefined,
  });
  if (id === null) throw new Error("the agent's call didn't write an element");
  return id;
}

/** The ids of the changes the board's list holds, newest first. */
function listedIds({ changes }: Board): string[] {
  return listAgentChanges(changes).map((change) => change.id);
}

/** Whether the board's array holds a record of the change or the undo `id`. */
function holds({ changes }: Board, id: string): boolean {
  return changes.toArray().some((value) => (value as Element).id === id);
}

/** An element of the board, as a record. */
function on({ elements }: Board, id: string): Element {
  return elements.get(id) as Element;
}

describe("the agent's changes", () => {
  it("records each element that the call's transactions write, as it was before them and as they left it", async () => {
    const shared = board([rectangle('a')]);
    const by: Creator = { ...AGENT };
    const { result, elements } = await capturedChanges(shared.elements, by, async () => {
      shared.doc.transact(() => shared.elements.set('a', rectangle('a', { x: 10, version: 2 })), by);
      // A peer's change while the call runs isn't the call's.
      shared.doc.transact(() => shared.elements.set('b', rectangle('b')), 'peer');
      shared.doc.transact(() => {
        shared.elements.set('a', rectangle('a', { x: 20, version: 3 }));
        shared.elements.set('c', rectangle('c'));
      }, by);
      return 'done';
    });
    expect(result).toBe('done');
    expect(elements).toEqual([
      { id: 'a', before: rectangle('a'), after: rectangle('a', { x: 20, version: 3 }) },
      { id: 'c', before: null, after: rectangle('c') },
    ]);
  });

  it("doesn't record a call that didn't write an element", () => {
    const { changes } = board();
    expect(recordAgentChange(changes, { by: AGENT, tool: 'update_shape', summary: 'Claude changed nothing', elements: [] })).toBeNull();
    expect(changes.length).toBe(0);
  });

  it('undoes an add: the added shape is deleted for everyone', async () => {
    const shared = board();
    const id = await agentWrites(shared, [rectangle('a', { x: 30 })]);
    const undo = undoAgentChange(shared.elements, shared.changes, id, { by: 'Ada' });
    expect(undo).toMatchObject({ kind: 'undo', change: id, by: 'Ada', restored: ['a'], kept: [] });
    expect(on(shared, 'a')).toMatchObject({ x: 30, isDeleted: true, version: 2 });
  });

  it('undoes an update: the shape goes back to where it was', async () => {
    const shared = board([rectangle('a')]);
    const id = await agentWrites(shared, [rectangle('a', { x: 50, width: 300, version: 2, versionNonce: 7 })]);
    const undo = undoAgentChange(shared.elements, shared.changes, id, { by: 'Ada' });
    expect(undo.restored).toEqual(['a']);
    expect(on(shared, 'a')).toMatchObject({ x: 0, width: 100, isDeleted: false, version: 3 });
    expect(on(shared, 'a').versionNonce).not.toBe(7);
  });

  it('undoes a delete: the shape and its label come back', async () => {
    const shared = board([rectangle('a'), label('t', 'a', 'Login')]);
    const id = await agentWrites(shared, [
      rectangle('a', { isDeleted: true, version: 2 }),
      label('t', 'a', 'Login', { isDeleted: true, version: 2 }),
    ]);
    const undo = undoAgentChange(shared.elements, shared.changes, id, { by: 'Ada' });
    expect(undo.restored).toEqual(['a', 't']);
    expect(on(shared, 'a')).toMatchObject({ isDeleted: false, version: 3 });
    expect(on(shared, 't')).toMatchObject({ isDeleted: false, version: 3, text: 'Login' });
  });

  it('leaves an element that a person changed after the change as it is, and names it', async () => {
    const shared = board([rectangle('a'), label('t', 'a', 'Login'), rectangle('b', { index: 'a2' })]);
    const id = await agentWrites(shared, [rectangle('a', { x: 50, version: 2 }), rectangle('b', { x: 50, index: 'a2', version: 2 })]);
    // A person moves the rectangle again.
    shared.elements.set('a', rectangle('a', { x: 80, version: 3 }));
    const undo = undoAgentChange(shared.elements, shared.changes, id, { by: 'Ada' });
    expect(undo.restored).toEqual(['b']);
    expect(undo.kept).toEqual([{ id: 'a', name: 'the rectangle "Login"' }]);
    expect(on(shared, 'a')).toMatchObject({ x: 80, version: 3 });
    expect(on(shared, 'b')).toMatchObject({ x: 0, version: 3 });
    const [listed] = listAgentChanges(shared.changes);
    expect(listed.undo).toEqual(undo);
  });

  it("doesn't count a page's measure of a text, a new version or the marks as a change since", async () => {
    const shared = board();
    const id = await agentWrites(shared, [label('t', 'a', 'Hello world', { containerId: null })]);
    // The page measures the text again, wraps it, and records its words mark.
    shared.elements.set(
      't',
      label('t', 'a', 'Hello world', {
        containerId: null,
        x: 12,
        width: 64,
        height: 50,
        text: 'Hello\nworld',
        version: 2,
        versionNonce: 9,
        updated: 2,
        customData: { [CUSTOM_DATA]: { wordsChanged: { words: 'Hello world', at: 1 } } },
      }),
    );
    const undo = undoAgentChange(shared.elements, shared.changes, id, { by: 'Ada' });
    expect(undo).toMatchObject({ restored: ['t'], kept: [] });
    expect(on(shared, 't')).toMatchObject({ isDeleted: true, version: 3 });
  });

  it("marks each element the agent's undo writes as the agent's, and a person's undo as the person's", async () => {
    const shared = board([rectangle('a'), rectangle('b')]);
    const first = await agentWrites(shared, [rectangle('a', { x: 50, version: 2 })]);
    const second = await agentWrites(shared, [rectangle('b', { x: 50, version: 2 })]);
    undoAgentChange(shared.elements, shared.changes, first, { by: 'Claude', agent: AGENT });
    undoAgentChange(shared.elements, shared.changes, second, { by: 'Ada' });
    expect(changerOf(on(shared, 'a'))).toEqual(AGENT);
    expect(changerOf(on(shared, 'b'))).toBeUndefined();
  });

  it("refuses a change the board doesn't record, and one that someone undid already", async () => {
    const shared = board([rectangle('a')]);
    const id = await agentWrites(shared, [rectangle('a', { x: 50, version: 2 })]);
    expect(() => undoAgentChange(shared.elements, shared.changes, 'missing', { by: 'Ada' })).toThrow(UndoError);
    undoAgentChange(shared.elements, shared.changes, id, { by: 'Ada', now: new Date('2026-11-07T10:00:00.000Z') });
    expect(() => undoAgentChange(shared.elements, shared.changes, id, { by: 'Grace' })).toThrow(
      `Ada undid the change ${id}, "Claude changed the board", at 2026-11-07T10:00:00.000Z already.`,
    );
    expect(on(shared, 'a')).toMatchObject({ x: 0, version: 3 });
  });

  it('lists the changes newest first, in the same order on every peer, with the undo a peer made', async () => {
    const network = new MemoryNetwork();
    const first = board([rectangle('a'), rectangle('b'), rectangle('c')]);
    const second = board();
    connectDoc(first.doc, network.join('first'));
    connectDoc(second.doc, network.join('second'));
    network.flush();
    expect(second.elements.size).toBe(3);

    // Each peer records a change before the other's arrives: two of them at the same time.
    const early = await agentWrites(first, [rectangle('a', { x: 1, version: 2 })], new Date('2026-11-07T10:00:00.000Z'));
    const late = await agentWrites(first, [rectangle('b', { x: 1, version: 2 })], new Date('2026-11-07T10:00:01.000Z'));
    const peers = await agentWrites(second, [rectangle('c', { x: 1, version: 2 })], new Date('2026-11-07T10:00:01.000Z'));
    network.flush();

    const listed = listAgentChanges(first.changes).map((change) => change.id);
    expect(listAgentChanges(second.changes).map((change) => change.id)).toEqual(listed);
    expect(listed).toHaveLength(3);
    expect(listed[2]).toBe(early);
    expect(new Set(listed.slice(0, 2))).toEqual(new Set([late, peers]));

    const undo = undoAgentChange(second.elements, second.changes, early, { by: 'Ada' });
    network.flush();
    expect(listAgentChanges(first.changes).find((change) => change.id === early)?.undo).toEqual(undo);
    expect(on(first, 'a')).toMatchObject({ x: 0, version: 3 });
  });

  it("drops each change that the board no longer shows anything of, on every peer, says older changes aren't kept, and undoes the newest", async () => {
    const network = new MemoryNetwork();
    const helper = board();
    const page = board();
    connectDoc(helper.doc, network.join('helper'));
    connectDoc(page.doc, network.join('page'));
    network.flush();

    const added = await agentWrites(helper, [rectangle('a'), rectangle('b', { index: 'a2' })], new Date('2026-11-07T10:00:00.000Z'), true);
    const moved = await agentWrites(helper, [rectangle('a', { x: 50, version: 2 })], new Date('2026-11-07T10:01:00.000Z'), true);
    network.flush();
    // The board still shows b as the add left it, so the add stays.
    for (const peer of [helper, page]) {
      expect(listedIds(peer)).toEqual([moved, added]);
      expect(olderChangesDropped(peer.changes)).toBe(false);
    }

    const deleted = await agentWrites(
      helper,
      [rectangle('b', { index: 'a2', isDeleted: true, version: 2 })],
      new Date('2026-11-07T10:02:00.000Z'),
      true,
    );
    network.flush();
    for (const peer of [helper, page]) {
      expect(listedIds(peer)).toEqual([deleted, moved]);
      expect(holds(peer, added)).toBe(false);
      expect(olderChangesDropped(peer.changes)).toBe(true);
    }
    expect(() => undoAgentChange(page.elements, page.changes, added, { by: 'Ada' })).toThrow('no longer shows anything it wrote');

    undoAgentChange(page.elements, page.changes, deleted, { by: 'Ada' });
    network.flush();
    expect(on(helper, 'b')).toMatchObject({ isDeleted: false, version: 3 });
    expect(on(page, 'b')).toMatchObject({ isDeleted: false, version: 3 });
  });

  it('counts an element for the newest change the board shows it as, and an undone change while the board shows its undo', async () => {
    const shared = board([rectangle('a')]);
    const right = await agentWrites(shared, [rectangle('a', { x: 50, version: 2 })], new Date('2026-11-07T10:00:00.000Z'));
    await agentWrites(shared, [rectangle('a', { version: 3 })], new Date('2026-11-07T10:01:00.000Z'));
    const again = await agentWrites(shared, [rectangle('a', { x: 50, version: 4 })], new Date('2026-11-07T10:02:00.000Z'));
    const other = await agentWrites(shared, [rectangle('b')], new Date('2026-11-07T10:03:00.000Z'), true);
    // The board shows a as both `right` and `again` left it, and a counts for `again`, the newer, alone.
    expect(listedIds(shared)).toEqual([other, again]);
    expect(holds(shared, right)).toBe(false);

    const undo = undoAgentChange(shared.elements, shared.changes, again, { by: 'Ada' });
    const third = await agentWrites(shared, [rectangle('c')], new Date('2026-11-07T10:04:00.000Z'), true);
    expect(listedIds(shared)).toEqual([third, other, again]);
    expect(listAgentChanges(shared.changes)[2]?.undo).toEqual(undo);

    // Once a person moves a, the board no longer shows what the undo wrote.
    shared.elements.set('a', rectangle('a', { x: 80, version: 6 }));
    const fourth = await agentWrites(shared, [rectangle('d')], new Date('2026-11-07T10:05:00.000Z'), true);
    expect(listedIds(shared)).toEqual([fourth, third, other]);
    expect(holds(shared, again)).toBe(false);
    expect(holds(shared, undo.id)).toBe(false);
  });

  it("drops an undo of a change that the array doesn't hold, a change's second undo, and a second mark", async () => {
    const shared = board([rectangle('a')]);
    const id = await agentWrites(shared, [rectangle('a', { x: 50, version: 2 })]);
    const first = undoAgentChange(shared.elements, shared.changes, id, { by: 'Ada' });
    // Two pages undid the change at once, an undo of a change that another copy dropped arrived, and
    // two copies marked that changes left the list.
    shared.changes.push([
      { ...first, id: 'second-undo', by: 'Bo' },
      { kind: 'undo', id: 'orphan', change: 'gone', by: 'Bo', at: first.at, restored: [], kept: [] },
      { kind: 'dropped' },
      { kind: 'dropped' },
    ]);
    expect(dropReplacedChanges(shared.elements, shared.changes)).toEqual([]);
    expect(shared.changes.toArray().map((value) => [(value as Element).kind, (value as Element).id])).toEqual([
      ['change', id],
      ['undo', first.id],
      ['dropped', undefined],
    ]);
    expect(listAgentChanges(shared.changes)[0]?.undo).toEqual(first);
    expect(olderChangesDropped(shared.changes)).toBe(true);
  });

  it('drops the changes a record replaces in the transaction that records it', async () => {
    const shared = board();
    const added = await agentWrites(shared, [rectangle('a')], undefined, true);
    let transactions = 0;
    shared.changes.observe(() => transactions++);
    const moved = await agentWrites(shared, [rectangle('a', { x: 50, version: 2 })], undefined, true);
    expect(transactions).toBe(1);
    expect(holds(shared, added)).toBe(false);
    expect(shared.changes.toArray()).toEqual([expect.objectContaining({ kind: 'change', id: moved }), { kind: 'dropped' }]);
  });

  it('serializes each element once across drops, and still compares each value written since', async () => {
    const shared = board();
    const ids: Record<string, string> = {};
    for (const id of ['a', 'b', 'c']) ids[id] = await agentWrites(shared, [rectangle(id)], undefined, true);
    const moved = await agentWrites(shared, [rectangle('a', { x: 50, version: 2 })], undefined, true);
    const stringify = vi.spyOn(JSON, 'stringify');
    const serialized: number[] = [];
    let again: string[] = [];
    let changed: string[] = [];
    try {
      // The board and the array hold the values that the drops before this one compared.
      again = dropReplacedChanges(shared.elements, shared.changes);
      serialized.push(stringify.mock.calls.length);
      // A person moves b: the drop serializes b's new value alone, and finds that b's change no longer shows.
      shared.elements.set('b', rectangle('b', { x: 80, version: 2 }));
      stringify.mockClear();
      changed = dropReplacedChanges(shared.elements, shared.changes);
      serialized.push(stringify.mock.calls.length);
    } finally {
      stringify.mockRestore();
    }
    expect(again).toEqual([]);
    expect(changed).toEqual([ids.b]);
    expect(serialized).toEqual([0, 1]);
    expect(listedIds(shared)).toEqual([moved, ids.c]);
  });

  it('names each kind of element with its label or its words', () => {
    const elements = [rectangle('a'), label('t', 'a', 'Login'), { id: 'e', type: 'ellipse' }, { id: 's', type: 'freedraw' }];
    expect(nameOf(elements[0], elements)).toBe('the rectangle "Login"');
    expect(nameOf(elements[1], elements)).toBe('the label "Login"');
    expect(nameOf(elements[2], elements)).toBe('an ellipse');
    expect(nameOf(elements[3], elements)).toBe('a freehand stroke');
    const long = label('w', 'x', 'A note that runs on for much longer than forty characters', { containerId: null });
    expect(nameOf(long, [])).toBe('the text "A note that runs on for much longer than..."');
  });
});
