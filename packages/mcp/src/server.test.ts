import { connectDoc, MemoryNetwork } from '@chalkline/sync';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { ELEMENTS } from './board';
import { createServer } from './server';
import type { BoardShape } from './shapes';

type Element = Record<string, unknown>;

interface Board {
  network: MemoryNetwork;
  /** The page's copy of the board. */
  doc: Y.Doc;
  /** The page's elements. */
  elements: Y.Map<Element>;
  /** An MCP client connected to chalkline-mcp's server. */
  client: Client;
}

const clients: Client[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
});

/** A page that holds `elements` and chalkline-mcp's copy of the board, on one in-memory network. */
async function board(elements: Element[] = []): Promise<Board> {
  const network = new MemoryNetwork();
  const doc = new Y.Doc();
  const shared = doc.getMap<Element>(ELEMENTS);
  doc.transact(() => {
    for (const element of elements) shared.set(String(element.id), element);
  });
  connectDoc(doc, network.join('page'));
  const helper = new Y.Doc();
  connectDoc(helper, network.join('helper'));
  network.flush();

  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await createServer(helper).connect(serverSide);
  const client = new Client({ name: 'chalkline-test', version: '0.0.0' });
  await client.connect(clientSide);
  clients.push(client);
  return { network, doc, elements: shared, client };
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
  it('lists get_board and add_shapes', async () => {
    const { client } = await board();
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual(['add_shapes', 'get_board']);
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
