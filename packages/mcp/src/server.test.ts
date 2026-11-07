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
import type { BoardShape } from './shapes';

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
  it('lists get_board, add_shapes, add_mermaid and get_request', async () => {
    const { client } = await board();
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual(['add_mermaid', 'add_shapes', 'get_board', 'get_request']);
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
