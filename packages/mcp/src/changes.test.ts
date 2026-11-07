import { Awareness, connectDoc, MemoryNetwork } from '@chalkline/sync';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { ELEMENTS } from './board';
import { ChangeLog, type ChangesRead } from './changes';
import { withCreator, type Creator } from './creator';
import { createServer } from './server';

type Element = Record<string, unknown>;

/** The agent whose creator mark these tests' agent shapes hold, as its helper writes the mark. */
const claude: Creator = { kind: 'agent', name: 'Claude' };

/** An element as a page draws it, with the fields Excalidraw sets on each: a rectangle unless `fields` sets its type. */
function drawn(fields: Element): Element {
  return { type: 'rectangle', x: 0, y: 0, width: 100, height: 50, isDeleted: false, version: 1, versionNonce: 1, ...fields };
}

/** A board of `values` in a new copy of the board, and the map that holds them. */
function boardOf(values: Element[]): { doc: Y.Doc; elements: Y.Map<unknown> } {
  const doc = new Y.Doc();
  const elements = doc.getMap<unknown>(ELEMENTS);
  for (const value of values) elements.set(String(value.id), value);
  return { doc, elements };
}

describe('ChangeLog', () => {
  it("lists each shape the board holds as added from cursor 0, with an agent's shape's creator", () => {
    const { doc } = boardOf([drawn({ id: 'box' }), withCreator(drawn({ id: 'note', type: 'ellipse' }), claude)]);
    const log = new ChangeLog(doc);
    expect(log.after(0)).toEqual({
      changes: [
        { change: 'added', id: 'box', kind: 'rectangle', x: 0, y: 0, width: 100, height: 50 },
        { change: 'added', id: 'note', kind: 'ellipse', x: 0, y: 0, width: 100, height: 50, creator: claude },
      ],
      cursor: 2,
    });
    expect(log.length).toBe(2);
  });

  it("lists a person's freehand stroke with its points, as get_board lists them", () => {
    const { doc, elements } = boardOf([]);
    const log = new ChangeLog(doc);
    expect(log.after(0)).toEqual({ changes: [], cursor: 0 });

    // A person draws a stroke with the pen, then draws it on.
    elements.set('pen', drawn({ id: 'pen', type: 'freedraw', width: 30, height: 40, points: [[0, 0], [10, 20], [30, 40]] }));
    expect(log.after(0)).toEqual({
      changes: [{ change: 'added', id: 'pen', kind: 'freedraw', x: 0, y: 0, width: 30, height: 40, points: [[0, 0], [10, 20], [30, 40]] }],
      cursor: 1,
    });
    elements.set(
      'pen',
      drawn({ id: 'pen', type: 'freedraw', width: 50, height: 40, version: 2, points: [[0, 0], [10, 20], [30, 40], [50, 30]] }),
    );
    expect(log.after(1)).toEqual({
      changes: [
        { change: 'changed', id: 'pen', kind: 'freedraw', x: 0, y: 0, width: 50, height: 40, points: [[0, 0], [10, 20], [30, 40], [50, 30]] },
      ],
      cursor: 2,
    });
  });

  it('lists a shape added, one changed and one deleted after the cursor, each with its creator', () => {
    const { doc, elements } = boardOf([drawn({ id: 'box' }), withCreator(drawn({ id: 'note', type: 'ellipse' }), claude)]);
    const log = new ChangeLog(doc);
    const { cursor } = log.after(0);

    // A person adds a circle, moves the note that an agent added, and deletes the box.
    elements.set('circle', drawn({ id: 'circle', type: 'ellipse', x: 300 }));
    elements.set('note', withCreator(drawn({ id: 'note', type: 'ellipse', x: 40, version: 2 }), claude));
    elements.set('box', drawn({ id: 'box', isDeleted: true, version: 2 }));
    expect(log.after(cursor)).toEqual({
      changes: [
        { change: 'added', id: 'circle', kind: 'ellipse', x: 300, y: 0, width: 100, height: 50 },
        { change: 'changed', id: 'note', kind: 'ellipse', x: 40, y: 0, width: 100, height: 50, creator: claude },
        { change: 'deleted', id: 'box', kind: 'rectangle', x: 0, y: 0, width: 100, height: 50 },
      ],
      cursor: 5,
    });
    expect(log.after(5)).toEqual({ changes: [], cursor: 5 });
  });

  it('lists each shape once across the reads after the cursor, as the last of them read it', () => {
    const { doc, elements } = boardOf([drawn({ id: 'box' }), drawn({ id: 'kept', x: 500 })]);
    const log = new ChangeLog(doc);
    const { cursor } = log.after(0);

    // Between two reads, a person adds a circle and moves it, adds a diamond and deletes it, and
    // deletes the box and brings it back with Excalidraw's undo, one row lower.
    elements.set('circle', drawn({ id: 'circle', type: 'ellipse' }));
    elements.set('note', drawn({ id: 'note', type: 'diamond' }));
    elements.set('box', drawn({ id: 'box', isDeleted: true, version: 2 }));
    log.after(cursor);
    elements.set('circle', drawn({ id: 'circle', type: 'ellipse', x: 80, version: 2 }));
    elements.set('note', drawn({ id: 'note', type: 'diamond', isDeleted: true, version: 2 }));
    elements.set('box', drawn({ id: 'box', y: 30, version: 3 }));

    expect(log.after(cursor)).toEqual({
      changes: [
        { change: 'changed', id: 'box', kind: 'rectangle', x: 0, y: 30, width: 100, height: 50 },
        { change: 'added', id: 'circle', kind: 'ellipse', x: 80, y: 0, width: 100, height: 50 },
      ],
      cursor: 8,
    });
  });

  it("lists a change of a shape's label as a change of the shape, and leaves out a change that get_board doesn't list", () => {
    const { doc, elements } = boardOf([drawn({ id: 'box' })]);
    const log = new ChangeLog(doc);
    const { cursor } = log.after(0);

    elements.set('label', drawn({ id: 'label', type: 'text', containerId: 'box', text: 'Start', originalText: 'Start' }));
    const labelled = log.after(cursor);
    expect(labelled).toEqual({
      changes: [{ change: 'changed', id: 'box', kind: 'rectangle', x: 0, y: 0, width: 100, height: 50, label: 'Start' }],
      cursor: cursor + 1,
    });

    elements.set('box', drawn({ id: 'box', version: 2, versionNonce: 7 }));
    expect(log.after(labelled.cursor)).toEqual({ changes: [], cursor: labelled.cursor });
  });

  it("leaves out a change of only a text's place, size or font, and lists a change of its words or its color", () => {
    const note = (fields: Element): Element =>
      drawn({ id: 'note', type: 'text', text: 'draw a box', originalText: 'draw a box', ...fields });
    const { doc, elements } = boardOf([note({})]);
    const log = new ChangeLog(doc);
    const { cursor } = log.after(0);

    // A page measures the text again, and a person moves it and sets another font, keeping its words.
    elements.set('note', note({ x: 40, y: 10, width: 120, height: 30, fontFamily: 6, version: 2 }));
    expect(log.after(cursor)).toEqual({ changes: [], cursor });

    const circle = { text: 'draw a circle', originalText: 'draw a circle', x: 40, y: 10, width: 120, height: 30, fontFamily: 6 };
    elements.set('note', note({ ...circle, version: 3 }));
    const worded = log.after(cursor);
    expect(worded).toEqual({
      changes: [
        { change: 'changed', id: 'note', kind: 'text', x: 40, y: 10, width: 120, height: 30, label: 'draw a circle', fontFamily: 'Nunito' },
      ],
      cursor: cursor + 1,
    });

    elements.set('note', note({ ...circle, strokeColor: '#1971c2', version: 4 }));
    expect(log.after(worded.cursor)).toEqual({
      changes: [
        {
          change: 'changed',
          id: 'note',
          kind: 'text',
          x: 40,
          y: 10,
          width: 120,
          height: 30,
          label: 'draw a circle',
          fontFamily: 'Nunito',
          strokeColor: '#1971c2',
        },
      ],
      cursor: worded.cursor + 1,
    });
  });

  it('waits for the next change of a shape, and answers it with the cursor after it', async () => {
    const { doc, elements } = boardOf([drawn({ id: 'box' })]);
    const log = new ChangeLog(doc);
    const { cursor } = log.after(0);
    let read: ChangesRead | undefined;
    const waited = log.next(cursor, new AbortController().signal).then((value) => {
      read = value;
    });
    await Promise.resolve();
    expect(read).toBeUndefined();
    expect(log.waiting).toBe(1);

    // A change that get_board doesn't list, such as a new version, doesn't end the wait.
    elements.set('box', drawn({ id: 'box', version: 2 }));
    await Promise.resolve();
    expect(read).toBeUndefined();
    expect(log.waiting).toBe(1);

    elements.set('box', drawn({ id: 'box', x: 40, version: 3 }));
    await waited;
    expect(read).toEqual({
      changes: [{ change: 'changed', id: 'box', kind: 'rectangle', x: 40, y: 0, width: 100, height: 50 }],
      cursor: 2,
    });
    expect(log.waiting).toBe(0);
  });

  it('ends a wait with no changes once its signal aborts, and stops waiting', async () => {
    const log = new ChangeLog(new Y.Doc());
    const controller = new AbortController();
    const waited = log.next(0, controller.signal);
    expect(log.waiting).toBe(1);

    controller.abort();
    expect(await waited).toEqual({ changes: [], cursor: 0 });
    expect(log.waiting).toBe(0);
    expect(await log.next(0, controller.signal)).toEqual({ changes: [], cursor: 0 });
    expect(log.waiting).toBe(0);
  });
});

interface Board {
  network: MemoryNetwork;
  /** The page's elements. */
  elements: Y.Map<unknown>;
  /** An MCP client connected to chalkline-mcp's server. */
  client: Client;
}

const clients: Client[] = [];
const awarenesses: Awareness[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
  for (const awareness of awarenesses.splice(0)) awareness.destroy();
});

/** A page that holds `values`, and chalkline-mcp's copy of the board, on one in-memory network. */
async function board(values: Element[] = []): Promise<Board> {
  const network = new MemoryNetwork();
  const { doc: page, elements } = boardOf(values);
  connectDoc(page, network.join('page'));
  const helper = new Y.Doc();
  const awareness = new Awareness(helper);
  awareness.setLocalState(null);
  awarenesses.push(awareness);
  connectDoc(helper, network.join('helper'));
  network.flush();

  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await createServer(helper, awareness).connect(serverSide);
  const client = new Client({ name: 'chalkline-test', version: '0.0.0' });
  await client.connect(clientSide);
  clients.push(client);
  return { network, elements, client };
}

async function readChanges(client: Client, args: Record<string, unknown> = {}, signal?: AbortSignal): Promise<CallToolResult> {
  return (await client.callTool({ name: 'read_changes', arguments: args }, undefined, { signal })) as CallToolResult;
}

function read(result: CallToolResult): ChangesRead {
  expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
  return result.structuredContent as ChangesRead;
}

function text(result: CallToolResult): string {
  return result.content.map((part) => (part.type === 'text' ? part.text : '')).join('');
}

describe('read_changes', () => {
  it('reports a shape a peer adds, one it changes and one it deletes, each with its creator', async () => {
    const { network, elements, client } = await board([
      drawn({ id: 'box' }),
      withCreator(drawn({ id: 'note', type: 'ellipse' }), claude),
    ]);
    const first = read(await readChanges(client));
    expect(first).toEqual({
      changes: [
        { change: 'added', id: 'box', kind: 'rectangle', x: 0, y: 0, width: 100, height: 50 },
        { change: 'added', id: 'note', kind: 'ellipse', x: 0, y: 0, width: 100, height: 50, creator: claude },
      ],
      cursor: 2,
    });

    // The page adds a circle, moves the note that an agent added, and deletes the box.
    elements.set('circle', drawn({ id: 'circle', type: 'ellipse', x: 300 }));
    elements.set('note', withCreator(drawn({ id: 'note', type: 'ellipse', x: 40, version: 2 }), claude));
    elements.set('box', drawn({ id: 'box', isDeleted: true, version: 2 }));
    network.flush();
    expect(read(await readChanges(client, { cursor: first.cursor }))).toEqual({
      changes: [
        { change: 'added', id: 'circle', kind: 'ellipse', x: 300, y: 0, width: 100, height: 50 },
        { change: 'changed', id: 'note', kind: 'ellipse', x: 40, y: 0, width: 100, height: 50, creator: claude },
        { change: 'deleted', id: 'box', kind: 'rectangle', x: 0, y: 0, width: 100, height: 50 },
      ],
      cursor: 5,
    });
  });

  it('lists a shape the agent adds with add_shapes, with the agent as its creator', async () => {
    // A board that holds a shape, so that the first read answers at once with the cursor after it.
    const { client } = await board([drawn({ id: 'box' })]);
    const { cursor } = read(await readChanges(client));
    expect(cursor).toBe(1);
    const added = (await client.callTool({
      name: 'add_shapes',
      arguments: { shapes: [{ type: 'rectangle', x: 10, y: 20, width: 200, height: 80 }] },
    })) as CallToolResult;
    expect(added.isError, JSON.stringify(added.content)).not.toBe(true);
    const [id] = (added.structuredContent as { ids: string[] }).ids;

    const { changes } = read(await readChanges(client, { cursor }));
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({
      change: 'added',
      id,
      kind: 'rectangle',
      x: 10,
      y: 20,
      width: 200,
      height: 80,
      creator: { kind: 'agent', name: 'chalkline-test' },
    });
  });

  it('waits for the next change, and answers it once the page changes a shape', async () => {
    const { network, elements, client } = await board([drawn({ id: 'box' })]);
    let answered = false;
    const waiting = readChanges(client, { cursor: 1 }).then((result) => {
      answered = true;
      return result;
    });
    // A second read, which answers at once, comes back while the first still waits.
    expect(read(await readChanges(client, { cursor: 0 })).cursor).toBe(1);
    expect(answered).toBe(false);

    elements.set('box', drawn({ id: 'box', x: 40, version: 2 }));
    network.flush();
    expect(read(await waiting)).toEqual({
      changes: [{ change: 'changed', id: 'box', kind: 'rectangle', x: 40, y: 0, width: 100, height: 50 }],
      cursor: 2,
    });
  });

  it('stops waiting once the client cancels the call', async () => {
    const { network, elements, client } = await board([drawn({ id: 'box' })]);
    const controller = new AbortController();
    const cancelled = readChanges(client, { cursor: 1 }, controller.signal);
    expect(read(await readChanges(client, { cursor: 0 })).cursor).toBe(1);
    controller.abort();
    await expect(cancelled).rejects.toThrow();

    elements.set('circle', drawn({ id: 'circle', type: 'ellipse' }));
    network.flush();
    expect(read(await readChanges(client, { cursor: 1 }))).toEqual({
      changes: [{ change: 'added', id: 'circle', kind: 'ellipse', x: 0, y: 0, width: 100, height: 50 }],
      cursor: 2,
    });
  });

  it("refuses a cursor past the board's changes", async () => {
    const { client } = await board([drawn({ id: 'box' })]);
    const result = await readChanges(client, { cursor: 2 });
    expect(result.isError).toBe(true);
    expect(text(result)).toBe(
      "cursor is 2, and the board's changes end at cursor 1 in this run of the helper: give a cursor that read_changes answered, or 0 to read from the start.",
    );
  });
});
