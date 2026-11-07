import {
  Awareness,
  connectAwareness,
  connectDoc,
  CONVERTS,
  MemoryNetwork,
  readRequest,
  REQUESTS,
  type MermaidRequest,
} from '@chalkline/sync';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { ELEMENTS } from './board';
import { RequestError, waitForRequest, writeMermaidRequest, type RequestAnswer } from './requests';
import { createServer } from './server';
import { FONT_FAMILY, type BoardShape } from './shapes';

type Element = Record<string, unknown>;

interface Board {
  network: MemoryNetwork;
  /** The page's copy of the board. */
  doc: Y.Doc;
  /** The page's elements. */
  elements: Y.Map<Element>;
  /** The page's awareness state, which doesn't list a kind of request it converts until a test says so. */
  awareness: Awareness;
  /** chalkline-mcp's copy of the board, and its awareness of the room. */
  helper: Y.Doc;
  helperAwareness: Awareness;
  /** An MCP client connected to chalkline-mcp's server. */
  client: Client;
}

const clients: Client[] = [];
const awarenesses: Awareness[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
  for (const awareness of awarenesses.splice(0)) awareness.destroy();
});

/**
 * Delivers each message once the code that sent it yields, as a live network does, so that a
 * tool's call can wait on an answer from the page.
 */
function deliverSoon(network: MemoryNetwork): void {
  const deliver = network.deliver.bind(network);
  let queued = false;
  network.deliver = (...args: Parameters<MemoryNetwork['deliver']>) => {
    deliver(...args);
    if (queued) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      network.flush();
    });
  };
}

/** A page that holds `elements` and chalkline-mcp's copy of the board, on one in-memory network. */
async function board(elements: Element[] = []): Promise<Board> {
  const network = new MemoryNetwork();
  const doc = new Y.Doc();
  const shared = doc.getMap<Element>(ELEMENTS);
  doc.transact(() => {
    for (const element of elements) shared.set(String(element.id), element);
  });
  deliverSoon(network);
  const awareness = new Awareness(doc);
  const pagePeer = network.join('page');
  connectDoc(doc, pagePeer);
  connectAwareness(awareness, pagePeer);
  const helper = new Y.Doc();
  const helperAwareness = new Awareness(helper);
  helperAwareness.setLocalState(null);
  awarenesses.push(awareness, helperAwareness);
  const helperPeer = network.join('helper');
  connectDoc(helper, helperPeer);
  connectAwareness(helperAwareness, helperPeer);
  network.flush();

  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await createServer(helper, helperAwareness).connect(serverSide);
  const client = new Client({ name: 'chalkline-test', version: '0.0.0' });
  await client.connect(clientSide);
  clients.push(client);
  return { network, doc, elements: shared, awareness, helper, helperAwareness, client };
}

/**
 * Makes the page of `board` convert Mermaid requests, as a page that has the board open does: it
 * lists mermaid in its awareness state, and answers each pending request as `outcome` says, or
 * leaves it pending where `outcome` answers null.
 */
function converting(board: Board, outcome: (request: MermaidRequest) => { ids: string[] } | { error: string } | null): void {
  const requests = board.doc.getMap<unknown>(REQUESTS);
  requests.observe(() => {
    for (const [id, value] of requests) {
      const request = readRequest(value);
      if (request?.status !== 'pending') continue;
      const answered = outcome(request);
      if (answered === null) continue;
      requests.set(
        id,
        'error' in answered
          ? { ...request, status: 'failed', error: answered.error }
          : { ...request, status: 'done', ids: answered.ids },
      );
    }
  });
  board.awareness.setLocalStateField(CONVERTS, ['mermaid']);
  board.network.flush();
}

/** Resolves once the page of `board` holds a pending request, on the change event of its requests map. */
function requestReached(board: Board): Promise<void> {
  const requests = board.doc.getMap<unknown>(REQUESTS);
  return new Promise((resolve) => {
    const check = () => {
      if (![...requests.values()].some((value) => readRequest(value)?.status === 'pending')) return;
      requests.unobserve(check);
      resolve();
    };
    requests.observe(check);
    check();
  });
}

function answered(result: CallToolResult): RequestAnswer {
  expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
  return result.structuredContent as RequestAnswer;
}

/** An element as the page draws it, with the fields Excalidraw sets on each. */
function drawn(fields: Element): Element {
  return { x: 0, y: 0, width: 100, height: 50, isDeleted: false, version: 1, versionNonce: 1, ...fields };
}

async function call(client: Client, name: string, args: Element = {}): Promise<CallToolResult> {
  return (await client.callTool({ name, arguments: args })) as CallToolResult;
}

function ids(result: CallToolResult): string[] {
  expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
  return (result.structuredContent as { ids: string[] }).ids;
}

function shapes(result: CallToolResult): BoardShape[] {
  expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
  return (result.structuredContent as { shapes: BoardShape[] }).shapes;
}

function text(result: CallToolResult): string {
  return result.content.map((part) => (part.type === 'text' ? part.text : '')).join('');
}

describe('chalkline-mcp', () => {
  it('lists get_board, render_board, add_shapes, connect, update_shape, delete_shapes, reorder_shapes, scale_shapes, add_mermaid, get_request, read_changes, read_transcript and post_message', async () => {
    const { client } = await board();
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      'add_mermaid',
      'add_shapes',
      'connect',
      'delete_shapes',
      'get_board',
      'get_request',
      'post_message',
      'read_changes',
      'read_transcript',
      'render_board',
      'reorder_shapes',
      'scale_shapes',
      'update_shape',
    ]);
  });

  it('adds a labelled rectangle, which reaches the page with its label bound to it', async () => {
    const { network, elements, client } = await board();
    const added = ids(
      await call(client, 'add_shapes', {
        shapes: [{ type: 'rectangle', x: 10, y: 20, width: 200, height: 80, label: { text: 'Hello' } }],
      }),
    );
    expect(added).toHaveLength(1);
    const [id] = added;
    expect(id).toMatch(/^[A-Za-z0-9_-]{20}$/);

    network.flush();
    expect(elements.size).toBe(2);
    const label = [...elements.values()].find((element) => element.containerId === id);
    expect(label).toMatchObject({ type: 'text', originalText: 'Hello' });
    expect(elements.get(id)).toMatchObject({
      type: 'rectangle',
      x: 10,
      y: 20,
      width: 200,
      height: 80,
      boundElements: [{ id: label?.id, type: 'text' }],
    });
  });

  it('reads the shapes that the page drew', async () => {
    const { network, doc, elements, client } = await board();
    doc.transact(() => {
      elements.set('oval', drawn({ id: 'oval', type: 'ellipse', width: 120, height: 60, index: 'a0' }));
      elements.set(
        'oval-label',
        drawn({ id: 'oval-label', type: 'text', x: 10, y: 17, height: 25, index: 'a1', containerId: 'oval', text: 'Start', originalText: 'Start' }),
      );
      elements.set(
        'note',
        drawn({ id: 'note', type: 'text', x: 200, width: 160, height: 25, index: 'a2', containerId: null, text: 'Cache it', originalText: 'Cache it' }),
      );
    });
    network.flush();

    expect(shapes(await call(client, 'get_board'))).toEqual([
      { id: 'oval', kind: 'ellipse', x: 0, y: 0, width: 120, height: 60, label: 'Start' },
      { id: 'note', kind: 'text', x: 200, y: 0, width: 160, height: 25, label: 'Cache it' },
    ]);
  });

  it('binds an arrow to shapes of the same call, though the arrow comes before them', async () => {
    const { network, elements, client } = await board();
    const [arrow, ask, answer] = ids(
      await call(client, 'add_shapes', {
        shapes: [
          { type: 'arrow', x: 100, y: 25, width: 200, height: 0, start: 'ask', end: 'answer', label: { text: 'yes' } },
          { type: 'rectangle', id: 'ask', x: 0, y: 0, width: 100, height: 50, label: { text: 'Ask' } },
          { type: 'diamond', id: 'answer', x: 300, y: 0, width: 100, height: 100 },
        ],
      }),
    );
    expect([ask, answer]).toEqual(['ask', 'answer']);

    network.flush();
    expect(elements.get(arrow)).toMatchObject({
      type: 'arrow',
      startBinding: { elementId: 'ask' },
      endBinding: { elementId: 'answer' },
    });
    expect(elements.get('ask')?.boundElements).toContainEqual({ id: arrow, type: 'arrow' });
    expect(elements.get('answer')?.boundElements).toContainEqual({ id: arrow, type: 'arrow' });
    const listed = shapes(await call(client, 'get_board')).find((candidate) => candidate.id === arrow);
    expect(listed).toMatchObject({ kind: 'arrow', label: 'yes', start: 'ask', end: 'answer' });
  });

  it("puts the shapes it adds above the page's, each label above its shape", async () => {
    const { network, elements, client } = await board([drawn({ id: 'top', type: 'rectangle', index: 'a5' })]);
    const [id] = ids(
      await call(client, 'add_shapes', { shapes: [{ type: 'ellipse', x: 0, y: 0, label: { text: 'Above' } }] }),
    );

    network.flush();
    const label = [...elements.values()].find((element) => element.containerId === id);
    const indices = [elements.get('top')?.index, elements.get(id)?.index, label?.index];
    expect(indices.every((index) => typeof index === 'string')).toBe(true);
    expect(new Set(indices).size).toBe(3);
    expect([...indices].sort()).toEqual(indices);
  });
});

describe('lines and arrows of add_shapes', () => {
  // The agent the tests' client is, by the name it gives as it connects, which get_board lists as
  // the creator of each shape add_shapes adds.
  const creator = { kind: 'agent', name: 'chalkline-test' };
  // The colors Excalidraw sets on a shape that leaves them out, which get_board lists.
  const colors = { strokeColor: '#1e1e1e', backgroundColor: 'transparent' };

  it('draws a line of width 0 straight down or up, and get_board reads it so', async () => {
    const { network, elements, client } = await board();
    const [down, up] = ids(
      await call(client, 'add_shapes', {
        shapes: [
          { type: 'line', x: 10, y: 20, width: 0, height: 50 },
          { type: 'line', x: 40, y: 70, width: 0, height: -50 },
        ],
      }),
    );

    network.flush();
    expect(elements.get(down)).toMatchObject({ type: 'line', x: 10, y: 20, width: 0, height: 50, points: [[0, 0], [0, 50]] });
    expect(elements.get(up)).toMatchObject({ type: 'line', x: 40, y: 70, width: 0, height: 50, points: [[0, 0], [0, -50]] });
    expect(shapes(await call(client, 'get_board'))).toEqual([
      { id: down, kind: 'line', x: 10, y: 20, width: 0, height: 50, points: [[0, 0], [0, 50]], creator, ...colors },
      { id: up, kind: 'line', x: 40, y: 70, width: 0, height: -50, points: [[0, 0], [0, -50]], creator, ...colors },
    ]);
  });

  it('draws an arrow of width 0 straight down between two shapes of the same call', async () => {
    const { network, elements, client } = await board();
    const [arrow] = ids(
      await call(client, 'add_shapes', {
        shapes: [
          { type: 'arrow', x: 50, y: 55, width: 0, height: 50, start: 'top', end: 'bottom' },
          { type: 'rectangle', id: 'top', x: 0, y: 0, width: 100, height: 50 },
          { type: 'rectangle', id: 'bottom', x: 0, y: 110, width: 100, height: 50 },
        ],
      }),
    );

    network.flush();
    // The converter moves each end of an arrow bound at both ends 0.5 toward the other end.
    expect(elements.get(arrow)).toMatchObject({
      type: 'arrow',
      x: 50,
      y: 55,
      width: 0,
      height: 50,
      points: [
        [0, 0.5],
        [0, 49.5],
      ],
      startBinding: { elementId: 'top' },
      endBinding: { elementId: 'bottom' },
    });
    expect(shapes(await call(client, 'get_board')).find((shape) => shape.id === arrow)).toEqual({
      id: arrow,
      kind: 'arrow',
      x: 50,
      y: 55,
      width: 0,
      height: 49,
      points: [
        [0, 0.5],
        [0, 49.5],
      ],
      start: 'top',
      end: 'bottom',
      creator,
      ...colors,
    });
  });

  it('draws an arrow that sets start and end and none of width, height and points from the edge of one shape to the edge of the other', async () => {
    const { network, elements, client } = await board();
    const [between, curved] = ids(
      await call(client, 'add_shapes', {
        shapes: [
          { type: 'arrow', x: 120, y: 30, start: 'ask', end: 'answer', label: { text: 'yes' } },
          { type: 'arrow', x: 100, y: 25, points: [[0, 0], [100, -40], [200, 0]], start: 'ask', end: 'answer' },
          { type: 'rectangle', id: 'ask', x: 0, y: 0, width: 100, height: 50 },
          { type: 'rectangle', id: 'answer', x: 300, y: 0, width: 100, height: 50 },
        ],
      }),
    );

    network.flush();
    // It runs from 5 right of the right edge of ask to 5 left of the left edge of answer, along the
    // line between their centers, whatever its x and y; the converter moves each end of an arrow
    // bound at both ends 0.5 toward the other end.
    expect(elements.get(between)).toMatchObject({
      type: 'arrow',
      x: 105,
      y: 25,
      width: 190,
      height: 0,
      points: [
        [0.5, 0],
        [189.5, 0],
      ],
      startBinding: { elementId: 'ask' },
      endBinding: { elementId: 'answer' },
    });
    const label = [...elements.values()].find((element) => element.containerId === between);
    expect(label).toMatchObject({ type: 'text', originalText: 'yes' });
    expect(Number(label?.x) + Number(label?.width) / 2).toBeCloseTo(200, 0);
    expect(Number(label?.y) + Number(label?.height) / 2).toBeCloseTo(25, 0);
    expect(elements.get(between)?.boundElements).toContainEqual({ id: label?.id, type: 'text' });
    // An arrow through its points keeps them.
    expect(elements.get(curved)).toMatchObject({
      type: 'arrow',
      x: 100,
      y: 25,
      points: [
        [0.5, 0.5],
        [100, -40],
        [199.5, -0.5],
      ],
      startBinding: { elementId: 'ask' },
      endBinding: { elementId: 'answer' },
    });
    for (const shape of ['ask', 'answer']) {
      expect(elements.get(shape)?.boundElements).toEqual(
        expect.arrayContaining([
          { id: between, type: 'arrow' },
          { id: curved, type: 'arrow' },
        ]),
      );
    }
    expect(shapes(await call(client, 'get_board')).find((shape) => shape.id === between)).toMatchObject({
      kind: 'arrow',
      x: 105,
      y: 25,
      width: 189,
      height: 0,
      points: [
        [0.5, 0],
        [189.5, 0],
      ],
      label: 'yes',
      start: 'ask',
      end: 'answer',
    });
  });

  it('draws an arrow that leaves out its x and y between a text and an ellipse as connect draws one, and leaves the text where it is', async () => {
    const note = { type: 'text', id: 'note', x: 0, y: 0, text: 'Note' };
    const oval = { type: 'ellipse', id: 'oval', x: 300, y: 200, width: 100, height: 80 };
    const added = await board();
    const [arrow] = ids(await call(added.client, 'add_shapes', { shapes: [{ type: 'arrow', start: 'note', end: 'oval' }, note, oval] }));
    const connected = await board();
    ids(await call(connected.client, 'add_shapes', { shapes: [note, oval] }));
    const connection = await call(connected.client, 'connect', { start: 'note', end: 'oval' });
    expect(connection.isError, JSON.stringify(connection.content)).not.toBe(true);
    const { id } = connection.structuredContent as { id: string };

    added.network.flush();
    connected.network.flush();
    const fields = ['x', 'y', 'width', 'height', 'points', 'startBinding', 'endBinding'];
    const geometry = (element: Element | undefined) => Object.fromEntries(fields.map((field) => [field, element?.[field]]));
    expect(geometry(added.elements.get(arrow))).toEqual(geometry(connected.elements.get(id)));
    expect(added.elements.get(arrow)).toMatchObject({ startBinding: { elementId: 'note' }, endBinding: { elementId: 'oval' } });
    expect(added.elements.get('note')).toMatchObject({ x: 0, y: 0 });
    for (const shape of ['note', 'oval']) {
      expect(added.elements.get(shape)?.boundElements).toContainEqual({ id: arrow, type: 'arrow' });
    }
  });

  it("draws a line of height 0 straight across, and a line that leaves out its width or its height at Excalidraw's default", async () => {
    const { network, elements, client } = await board();
    const [across, unsized, left] = ids(
      await call(client, 'add_shapes', {
        shapes: [
          { type: 'line', x: 0, y: 0, width: 120, height: 0 },
          { type: 'line', x: 0, y: 10 },
          { type: 'line', x: 0, y: 20, width: -80 },
        ],
      }),
    );

    network.flush();
    expect(elements.get(across)).toMatchObject({ width: 120, height: 0, points: [[0, 0], [120, 0]] });
    expect(elements.get(unsized)).toMatchObject({ width: 100, height: 0, points: [[0, 0], [100, 0]] });
    expect(elements.get(left)).toMatchObject({ width: 80, height: 0, points: [[0, 0], [-80, 0]] });
    expect(shapes(await call(client, 'get_board')).map(({ width, height }) => [width, height])).toEqual([
      [120, 0],
      [100, 0],
      [-80, 0],
    ]);
  });

  it('draws a line or an arrow through its points, at its first point, and get_board lists the points', async () => {
    const { network, elements, client } = await board();
    const [zigzag, moved, curve] = ids(
      await call(client, 'add_shapes', {
        shapes: [
          { type: 'line', x: 10, y: 20, points: [[0, 0], [40, 30], [80, -10], [120, 20]] },
          { type: 'line', x: 0, y: 0, points: [[5, 10], [25, 10], [25, 40]] },
          { type: 'arrow', x: 100, y: 100, points: [[0, 0], [50, -40], [100, 0]] },
        ],
      }),
    );

    network.flush();
    expect(elements.get(zigzag)).toMatchObject({
      type: 'line',
      x: 10,
      y: 20,
      width: 120,
      height: 40,
      points: [[0, 0], [40, 30], [80, -10], [120, 20]],
    });
    expect(elements.get(moved)).toMatchObject({ type: 'line', x: 5, y: 10, width: 20, height: 30, points: [[0, 0], [20, 0], [20, 30]] });
    // The converter moves this arrow's first point 0.5 right and down and its last point 0.5 left and up, and keeps the width and height it reads.
    expect(elements.get(curve)).toMatchObject({ type: 'arrow', x: 100, y: 100, width: 100, height: 40, points: [[0.5, 0.5], [50, -40], [99.5, -0.5]] });
    expect(shapes(await call(client, 'get_board'))).toEqual([
      { id: zigzag, kind: 'line', x: 10, y: 20, width: 120, height: 20, points: [[0, 0], [40, 30], [80, -10], [120, 20]], creator, ...colors },
      { id: moved, kind: 'line', x: 5, y: 10, width: 20, height: 30, points: [[0, 0], [20, 0], [20, 30]], creator, ...colors },
      { id: curve, kind: 'arrow', x: 100, y: 100, width: 99, height: -1, points: [[0.5, 0.5], [50, -40], [99.5, -0.5]], creator, ...colors },
    ]);
  });

  it('closes a line back to its first point, so that its background color fills the shape it encloses', async () => {
    const { network, elements, client } = await board();
    const [triangle, square] = ids(
      await call(client, 'add_shapes', {
        shapes: [
          { type: 'line', x: 0, y: 0, points: [[0, 0], [60, 0], [30, 50]], closed: true, backgroundColor: '#ffc9c9' },
          { type: 'line', x: 100, y: 0, points: [[0, 0], [40, 0], [40, 40], [0, 40], [0, 0]], closed: true, backgroundColor: '#a5d8ff' },
        ],
      }),
    );

    network.flush();
    expect(elements.get(triangle)).toMatchObject({
      type: 'line',
      width: 60,
      height: 50,
      backgroundColor: '#ffc9c9',
      points: [[0, 0], [60, 0], [30, 50], [0, 0]],
    });
    expect(elements.get(square)).toMatchObject({
      type: 'line',
      width: 40,
      height: 40,
      backgroundColor: '#a5d8ff',
      points: [[0, 0], [40, 0], [40, 40], [0, 40], [0, 0]],
    });
  });

  it('draws a freehand stroke through its points, at its first point, and get_board lists the points', async () => {
    const { network, elements, client } = await board();
    const [stroke, moved] = ids(
      await call(client, 'add_shapes', {
        shapes: [
          { type: 'freedraw', x: 50, y: 60, points: [[0, 0], [10, 5], [20, -5], [30, 10]], strokeColor: '#1971c2' },
          { type: 'freedraw', x: 0, y: 0, points: [[200, 100], [210, 120]] },
        ],
      }),
    );

    network.flush();
    expect(elements.get(stroke)).toMatchObject({
      type: 'freedraw',
      x: 50,
      y: 60,
      width: 30,
      height: 15,
      strokeColor: '#1971c2',
      points: [[0, 0], [10, 5], [20, -5], [30, 10]],
      pressures: [],
      simulatePressure: true,
    });
    expect(elements.get(moved)).toMatchObject({ type: 'freedraw', x: 200, y: 100, width: 10, height: 20, points: [[0, 0], [10, 20]] });
    // restoreElements sets the seed 1 on an element that leaves it out, and add_shapes sets a random one.
    expect(elements.get(stroke)?.seed).not.toBe(elements.get(moved)?.seed);
    expect(shapes(await call(client, 'get_board'))).toEqual([
      {
        id: stroke,
        kind: 'freedraw',
        x: 50,
        y: 60,
        width: 30,
        height: 15,
        points: [[0, 0], [10, 5], [20, -5], [30, 10]],
        creator,
        strokeColor: '#1971c2',
        backgroundColor: 'transparent',
      },
      { id: moved, kind: 'freedraw', x: 200, y: 100, width: 10, height: 20, points: [[0, 0], [10, 20]], creator, ...colors },
    ]);
  });
});

describe('add_shapes refusals', () => {
  const oval = () => drawn({ id: 'oval', type: 'ellipse', index: 'a0' });

  it('refuses an arrow that ends at a shape already on the board, and adds nothing', async () => {
    const { network, elements, client } = await board([oval()]);
    const result = await call(client, 'add_shapes', {
      shapes: [
        { type: 'rectangle', x: 0, y: 0 },
        { type: 'arrow', x: 0, y: 0, end: 'oval' },
      ],
    });
    expect(result.isError).toBe(true);
    expect(text(result)).toBe(
      `shapes[1].end is "oval", which isn't the id of a rectangle, ellipse, diamond or text that this call adds: an arrow's start and end name shapes of the same call.`,
    );
    network.flush();
    expect([...elements.keys()]).toEqual(['oval']);
  });

  it('refuses an arrow that starts at an arrow', async () => {
    const { client } = await board();
    const result = await call(client, 'add_shapes', {
      shapes: [
        { type: 'arrow', id: 'first', x: 0, y: 0 },
        { type: 'arrow', x: 0, y: 0, start: 'first' },
      ],
    });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain(`shapes[1].start is "first", which isn't the id of a rectangle, ellipse, diamond or text`);
  });

  it('refuses two shapes with one id', async () => {
    const { network, elements, client } = await board();
    const result = await call(client, 'add_shapes', {
      shapes: [
        { type: 'rectangle', id: 'same', x: 0, y: 0 },
        { type: 'ellipse', id: 'same', x: 200, y: 0 },
      ],
    });
    expect(result.isError).toBe(true);
    expect(text(result)).toBe(`shapes[1].id is "same", which shapes[0] has too: give each shape its own id.`);
    network.flush();
    expect(elements.size).toBe(0);
  });

  it('refuses an id that a shape on the board has already', async () => {
    const { network, elements, client } = await board([oval()]);
    const result = await call(client, 'add_shapes', { shapes: [{ type: 'diamond', id: 'oval', x: 0, y: 0 }] });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain(`shapes[0].id is "oval", which a shape on the board has already`);
    network.flush();
    expect([...elements.keys()]).toEqual(['oval']);
  });

  it('refuses a line or an arrow that sets both points and a width or a height, and adds nothing', async () => {
    const { network, elements, client } = await board();
    const cases: [Record<string, unknown>, string][] = [
      [{ type: 'line', x: 0, y: 0, width: 10, points: [[0, 0], [10, 10]] }, 'width'],
      [{ type: 'arrow', x: 0, y: 0, height: 20, points: [[0, 0], [10, 10]] }, 'height'],
    ];
    for (const [shape, field] of cases) {
      const result = await call(client, 'add_shapes', { shapes: [{ type: 'rectangle', x: 0, y: 0 }, shape] });
      expect(result.isError).toBe(true);
      expect(text(result)).toBe(
        `shapes[1] sets both points and ${field}: a line or an arrow through points gets its size from them, so leave out its width and height.`,
      );
    }
    network.flush();
    expect(elements.size).toBe(0);
  });

  it('refuses a closed line of fewer than three points, and adds nothing', async () => {
    const { network, elements, client } = await board();
    for (const line of [
      { type: 'line', x: 0, y: 0, points: [[0, 0], [10, 10]], closed: true },
      { type: 'line', x: 0, y: 0, width: 10, height: 10, closed: true },
    ]) {
      const result = await call(client, 'add_shapes', { shapes: [line] });
      expect(result.isError).toBe(true);
      expect(text(result)).toBe(
        'shapes[0].closed is true, and the line has fewer than three points: a closed line needs points, three or more, that enclose the shape it fills.',
      );
    }
    network.flush();
    expect(elements.size).toBe(0);
  });

  it("refuses an arrow that leaves out its x or its y and doesn't run between two shapes, and adds nothing", async () => {
    const { network, elements, client } = await board();
    const cases: [Record<string, unknown>, string][] = [
      [{ type: 'arrow', y: 0, width: 10, height: 10 }, 'x'],
      [{ type: 'arrow', x: 0, start: 'a' }, 'y'],
      [{ type: 'arrow', x: 0, start: 'a', end: 'b', width: 50 }, 'y'],
    ];
    for (const [arrow, field] of cases) {
      const result = await call(client, 'add_shapes', {
        shapes: [arrow, { type: 'rectangle', id: 'a', x: 0, y: 0 }, { type: 'rectangle', id: 'b', x: 200, y: 0 }],
      });
      expect(result.isError).toBe(true);
      expect(text(result)).toBe(
        `shapes[0] leaves out ${field}: an arrow needs its x and y, unless it sets start and end and none of width, height and points, so that it runs between those two shapes.`,
      );
    }
    network.flush();
    expect(elements.size).toBe(0);
  });

  it('refuses an arrow between two shapes of one center, and adds nothing', async () => {
    const { network, elements, client } = await board();
    const result = await call(client, 'add_shapes', {
      shapes: [
        { type: 'arrow', start: 'a', end: 'b' },
        { type: 'rectangle', id: 'a', x: 0, y: 0, width: 100, height: 50 },
        { type: 'ellipse', id: 'b', x: 25, y: 5, width: 50, height: 40 },
      ],
    });
    expect(result.isError).toBe(true);
    expect(text(result)).toBe(
      'shapes[0] starts at "a" and ends at "b", which have one center, so an arrow between them has no direction: give the arrow its x and y, and a width and a height or points.',
    );
    network.flush();
    expect(elements.size).toBe(0);
  });
});

describe('Mermaid requests', () => {
  const flowchart = 'flowchart LR\n  A --> B';

  it('answers add_mermaid pending at once where no page is in the room, and get_board lists the request', async () => {
    const { network, doc, client } = await board();
    const result = answered(await call(client, 'add_mermaid', { text: flowchart, at: { x: 5, y: 6 } }));

    expect(result).toEqual({ id: expect.stringMatching(/^[A-Za-z0-9_-]{20}$/), status: 'pending' });
    network.flush();
    expect(readRequest(doc.getMap<unknown>(REQUESTS).get(result.id))).toEqual({
      kind: 'mermaid',
      text: flowchart,
      by: 'chalkline-test',
      status: 'pending',
      error: null,
      at: { x: 5, y: 6 },
    });
    const listed = await call(client, 'get_board');
    expect((listed.structuredContent as { pending: unknown[] }).pending).toEqual([{ id: result.id, kind: 'mermaid' }]);
  });

  it("answers done with the new shapes' ids once a page converts the request", async () => {
    const page = await board();
    const texts: string[] = [];
    converting(page, (request) => {
      texts.push(request.text);
      return { ids: ['r-0', 'r-2'] };
    });

    const result = answered(await call(page.client, 'add_mermaid', { text: flowchart }));

    expect(result).toEqual({ id: expect.any(String), status: 'done', ids: ['r-0', 'r-2'] });
    expect(texts).toEqual([flowchart]);
    const listed = await call(page.client, 'get_board');
    expect((listed.structuredContent as { pending: unknown[] }).pending).toEqual([]);
  });

  it("answers failed with the page's reason where the page couldn't convert the text", async () => {
    const page = await board();
    converting(page, () => ({ error: 'No diagram type detected' }));

    const result = answered(await call(page.client, 'add_mermaid', { text: 'not mermaid' }));

    expect(result).toEqual({ id: expect.any(String), status: 'failed', error: 'No diagram type detected' });
  });

  it('answers pending once the room no longer holds a page, and the request stays on the board', async () => {
    const page = await board();
    converting(page, () => null);

    const adding = call(page.client, 'add_mermaid', { text: flowchart });
    await requestReached(page);
    // The page stops converting, as a page that closes does.
    page.awareness.setLocalState({});
    const result = answered(await adding);

    expect(result).toEqual({ id: expect.any(String), status: 'pending' });
    expect(readRequest(page.doc.getMap<unknown>(REQUESTS).get(result.id))?.status).toBe('pending');
  });

  it('answers get_request once a page converts a request that was pending', async () => {
    const page = await board();
    const asked = answered(await call(page.client, 'add_mermaid', { text: flowchart }));
    expect(asked.status).toBe('pending');
    converting(page, () => null);

    let settled = false;
    const reading = call(page.client, 'get_request', { id: asked.id }).then((result) => {
      settled = true;
      return result;
    });
    // A call that the server answers after get_request's shows that get_request waits for the page.
    await call(page.client, 'get_board');
    expect(settled).toBe(false);

    const requests = page.doc.getMap<unknown>(REQUESTS);
    requests.set(asked.id, { ...(readRequest(requests.get(asked.id)) as MermaidRequest), status: 'done', ids: ['shape'] });

    expect(answered(await reading)).toEqual({ id: asked.id, status: 'done', ids: ['shape'] });
  });

  it("refuses get_request for an id the board doesn't hold", async () => {
    const { client } = await board();
    const result = await call(client, 'get_request', { id: 'nope' });

    expect(result.isError).toBe(true);
    expect(text(result)).toBe(`The board doesn't hold a Mermaid request with the id "nope": give an id that add_mermaid answered.`);
  });

  it('stops waiting, and rejects, once its signal aborts', async () => {
    const page = await board();
    converting(page, () => null);
    const id = writeMermaidRequest(page.helper, flowchart, 'agent');
    const controller = new AbortController();

    const waiting = waitForRequest(page.helper, page.helperAwareness, id, controller.signal);
    controller.abort(new Error('cancelled'));

    await expect(waiting).rejects.toThrow('cancelled');
    await expect(waitForRequest(page.helper, page.helperAwareness, 'nope')).rejects.toBeInstanceOf(RequestError);
  });
});

describe('add_shapes styles', () => {
  const creator = { kind: 'agent', name: 'chalkline-test' };

  it('stores each style, font and alignment that a shape sets, and get_board reports them', async () => {
    const { network, elements, client } = await board();
    const added = ids(
      await call(client, 'add_shapes', {
        shapes: [
          {
            type: 'rectangle',
            id: 'wash',
            x: 0,
            y: 0,
            width: 200,
            height: 80,
            strokeColor: '#1971c2',
            backgroundColor: '#a5d8ff',
            strokeWidth: 1,
            strokeStyle: 'dashed',
            fillStyle: 'hachure',
            roughness: 0,
            opacity: 40,
            label: { text: 'Wash', fontFamily: 'Comic Shanns', textAlign: 'left' },
          },
          {
            type: 'text',
            id: 'note',
            x: 0,
            y: 120,
            text: 'Note',
            fontFamily: 'Nunito',
            textAlign: 'right',
            strokeWidth: 4,
            strokeStyle: 'dotted',
            fillStyle: 'zigzag',
            roughness: 2,
            opacity: 100,
          },
          { type: 'arrow', id: 'arrow', x: 200, y: 40, width: 100, height: 0, strokeWidth: 4, strokeStyle: 'dotted', roughness: 2, opacity: 0 },
          { type: 'line', id: 'line', x: 0, y: 200, width: 300, height: 0, strokeWidth: 1, fillStyle: 'cross-hatch', roughness: 0, opacity: 25 },
        ],
      }),
    );
    expect(added).toEqual(['wash', 'note', 'arrow', 'line']);

    network.flush();
    const wash = { strokeColor: '#1971c2', backgroundColor: '#a5d8ff', strokeWidth: 1, strokeStyle: 'dashed', fillStyle: 'hachure', roughness: 0, opacity: 40 };
    expect(elements.get('wash')).toMatchObject({ type: 'rectangle', ...wash });
    const label = [...elements.values()].find((element) => element.containerId === 'wash');
    expect(label).toMatchObject({ type: 'text', originalText: 'Wash', fontFamily: FONT_FAMILY['Comic Shanns'], textAlign: 'left' });
    const note = { strokeWidth: 4, strokeStyle: 'dotted', fillStyle: 'zigzag', roughness: 2 };
    expect(elements.get('note')).toMatchObject({ type: 'text', fontFamily: FONT_FAMILY.Nunito, textAlign: 'right', ...note, opacity: 100 });
    // A text that aligns right ends at its x.
    expect(Number(elements.get('note')?.x) + Number(elements.get('note')?.width)).toBeCloseTo(0);
    const arrow = { strokeWidth: 4, strokeStyle: 'dotted', roughness: 2, opacity: 0 };
    expect(elements.get('arrow')).toMatchObject({ type: 'arrow', ...arrow });
    const line = { strokeWidth: 1, fillStyle: 'cross-hatch', roughness: 0, opacity: 25 };
    expect(elements.get('line')).toMatchObject({ type: 'line', ...line });

    const listed = shapes(await call(client, 'get_board'));
    const read = (id: string) => listed.find((shape) => shape.id === id);
    expect(read('wash')).toEqual({
      id: 'wash',
      kind: 'rectangle',
      x: 0,
      y: 0,
      width: 200,
      height: 80,
      label: 'Wash',
      ...wash,
      fontFamily: 'Comic Shanns',
      textAlign: 'left',
      creator,
    });
    expect(read('note')).toMatchObject({ kind: 'text', label: 'Note', fontFamily: 'Nunito', textAlign: 'right', ...note });
    // 100 is Excalidraw's default opacity, which get_board leaves out.
    expect(read('note')).not.toHaveProperty('opacity');
    expect(read('arrow')).toMatchObject({ kind: 'arrow', ...arrow });
    expect(read('line')).toMatchObject({ kind: 'line', ...line });
  });

  it('stores the style of a freehand stroke and of a closed line, and get_board reports it', async () => {
    const { network, elements, client } = await board();
    const added = ids(
      await call(client, 'add_shapes', {
        shapes: [
          { type: 'freedraw', id: 'stroke', x: 0, y: 0, points: [[0, 0], [10, 5], [20, 0]], strokeWidth: 4, strokeStyle: 'dashed', roughness: 0, opacity: 50 },
          {
            type: 'line',
            id: 'loop',
            x: 0,
            y: 50,
            points: [[0, 0], [40, 0], [20, 30]],
            closed: true,
            backgroundColor: '#ffc9c9',
            fillStyle: 'hachure',
            strokeWidth: 1,
          },
        ],
      }),
    );
    expect(added).toEqual(['stroke', 'loop']);

    network.flush();
    const stroke = { strokeWidth: 4, strokeStyle: 'dashed', roughness: 0, opacity: 50 };
    expect(elements.get('stroke')).toMatchObject({ type: 'freedraw', ...stroke });
    const loop = { backgroundColor: '#ffc9c9', fillStyle: 'hachure', strokeWidth: 1 };
    expect(elements.get('loop')).toMatchObject({ type: 'line', ...loop });

    const listed = shapes(await call(client, 'get_board'));
    expect(listed.find((shape) => shape.id === 'stroke')).toMatchObject({ kind: 'freedraw', ...stroke });
    expect(listed.find((shape) => shape.id === 'loop')).toMatchObject({ kind: 'line', ...loop });
  });

  it("leaves out of get_board each style field that is Excalidraw's default", async () => {
    const { client } = await board();
    ids(
      await call(client, 'add_shapes', {
        shapes: [{ type: 'rectangle', id: 'plain', x: 0, y: 0, width: 100, height: 50, label: { text: 'Plain' } }],
      }),
    );
    expect(shapes(await call(client, 'get_board'))).toEqual([
      { id: 'plain', kind: 'rectangle', x: 0, y: 0, width: 100, height: 50, label: 'Plain', strokeColor: '#1e1e1e', backgroundColor: 'transparent', creator },
    ]);
  });

  it.each([
    ['strokeWidth', { type: 'rectangle', x: 0, y: 0, strokeWidth: 3 }, 'shapes[0].strokeWidth'],
    ['strokeStyle', { type: 'line', x: 0, y: 0, strokeStyle: 'wavy' }, 'shapes[0].strokeStyle'],
    ['fillStyle', { type: 'ellipse', x: 0, y: 0, fillStyle: 'dots' }, 'shapes[0].fillStyle'],
    ['roughness', { type: 'arrow', x: 0, y: 0, roughness: 3 }, 'shapes[0].roughness'],
    ['an opacity above 100', { type: 'diamond', x: 0, y: 0, opacity: 101 }, 'shapes[0].opacity'],
    ['an opacity below 0', { type: 'text', x: 0, y: 0, text: 'Note', opacity: -1 }, 'shapes[0].opacity'],
    ['an opacity between whole numbers', { type: 'rectangle', x: 0, y: 0, opacity: 50.5 }, 'shapes[0].opacity'],
    ['fontFamily', { type: 'text', x: 0, y: 0, text: 'Note', fontFamily: 'Comic Sans' }, 'shapes[0].fontFamily'],
    ['textAlign', { type: 'text', x: 0, y: 0, text: 'Note', textAlign: 'justify' }, 'shapes[0].textAlign'],
    ["a label's fontFamily", { type: 'rectangle', x: 0, y: 0, label: { text: 'Box', fontFamily: 'Comic Sans' } }, 'shapes[0].label.fontFamily'],
    ["a label's textAlign", { type: 'arrow', x: 0, y: 0, label: { text: 'yes', textAlign: 'justify' } }, 'shapes[0].label.textAlign'],
  ])("refuses %s outside Excalidraw's values, names the field, and adds nothing", async (_case, shape, field) => {
    const { network, elements, client } = await board();
    const result = await call(client, 'add_shapes', { shapes: [shape] });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain(` at ${field}`);
    network.flush();
    expect(elements.size).toBe(0);
  });

  it("lists each style field in add_shapes's description and in get_board's shapes", async () => {
    const { client } = await board();
    const { tools } = await client.listTools();
    const fields = ['strokeWidth', 'strokeStyle', 'fillStyle', 'roughness', 'opacity', 'fontFamily', 'textAlign'];
    const description = tools.find((tool) => tool.name === 'add_shapes')?.description ?? '';
    for (const field of fields) expect(description).toContain(field);
    const answer = tools.find((tool) => tool.name === 'get_board')?.outputSchema as unknown as {
      properties: { shapes: { items: { properties: Record<string, unknown> } } };
    };
    expect(Object.keys(answer.properties.shapes.items.properties)).toEqual(
      expect.arrayContaining(['strokeColor', 'backgroundColor', ...fields]),
    );
  });
});
