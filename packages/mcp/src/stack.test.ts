// Tests of the board's stacking order: where add_shapes puts new shapes, and how reorder_shapes
// moves shapes forward or back. Each checks each element's fractional index, and the order in which
// get_board lists the shapes, from back to front.
import { Awareness } from '@chalkline/sync';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { ELEMENTS } from './board';
import { createServer } from './server';
import type { BoardShape } from './shapes';

type Element = Record<string, unknown>;

const clients: Client[] = [];
const awarenesses: Awareness[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
  for (const awareness of awarenesses.splice(0)) awareness.destroy();
});

/** chalkline-mcp's copy of a board that holds `elements`, and an MCP client connected to its server. */
async function helper(elements: Element[]): Promise<{ elements: Y.Map<Element>; client: Client }> {
  const doc = new Y.Doc();
  const shared = doc.getMap<Element>(ELEMENTS);
  doc.transact(() => {
    for (const element of elements) shared.set(String(element.id), element);
  });
  const awareness = new Awareness(doc);
  awareness.setLocalState(null);
  awarenesses.push(awareness);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await createServer(doc, awareness).connect(serverSide);
  const client = new Client({ name: 'chalkline-test', version: '0.0.0' });
  await client.connect(clientSide);
  clients.push(client);
  return { elements: shared, client };
}

/** An element as a person's page draws it, with the fields Excalidraw sets on each. */
function drawn(fields: Element): Element {
  return { x: 0, y: 0, width: 100, height: 50, angle: 0, isDeleted: false, version: 1, versionNonce: 1, ...fields };
}

/**
 * A board of four shapes, from back to front: the rectangle a with its label a-label, the ellipse
 * b, the rectangle c and the diamond d.
 */
function four(): Element[] {
  return [
    drawn({ id: 'a', type: 'rectangle', index: 'a0', boundElements: [{ id: 'a-label', type: 'text' }] }),
    drawn({ id: 'a-label', type: 'text', index: 'a1', containerId: 'a', text: 'A', originalText: 'A' }),
    drawn({ id: 'b', type: 'ellipse', index: 'a2' }),
    drawn({ id: 'c', type: 'rectangle', index: 'a3' }),
    drawn({ id: 'd', type: 'diamond', index: 'a4' }),
  ];
}

const square = { type: 'rectangle', x: 0, y: 0, width: 100, height: 50 };

async function call(client: Client, name: string, args: Element = {}): Promise<CallToolResult> {
  return (await client.callTool({ name, arguments: args })) as CallToolResult;
}

function ok<T>(result: CallToolResult): T {
  expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
  return result.structuredContent as T;
}

function text(result: CallToolResult): string {
  return result.content.map((part) => (part.type === 'text' ? part.text : '')).join('');
}

/** The ids of the shapes that get_board lists, in its order, from back to front. */
async function order(client: Client): Promise<string[]> {
  return ok<{ shapes: BoardShape[] }>(await call(client, 'get_board')).shapes.map((shape) => shape.id);
}

/** Checks that each element `ids` names holds a fractional index, and that they rise in the order of `ids`. */
function expectRising(elements: Y.Map<Element>, ids: readonly string[]): void {
  const indices = ids.map((id) => elements.get(id)?.index);
  for (const [n, index] of indices.entries()) {
    expect(typeof index, `the index of ${ids[n]}`).toBe('string');
    if (n === 0) continue;
    expect(String(indices[n - 1]) < String(index), `${ids[n - 1]} below ${ids[n]}: ${JSON.stringify(indices)}`).toBe(true);
  }
}

/** The id of the label of the shape `id`. */
function labelOf(elements: Y.Map<Element>, id: string): string {
  const label = [...elements.values()].find((element) => element.containerId === id && element.isDeleted !== true);
  expect(label, `the label of ${id}`).toBeDefined();
  return String(label?.id);
}

/** Each element of the board as it stands, by id, as text that changes where any element changes. */
function snapshot(elements: Y.Map<Element>): string {
  return JSON.stringify([...elements.entries()].sort(([a], [b]) => (a < b ? -1 : 1)));
}

describe("add_shapes's place", () => {
  it.each<[string, Element]>([
    ['left out', {}],
    ['null', { place: null }],
    ['front', { place: 'front' }],
  ])('puts the shapes in front of every shape where place is %s, each in front of the ones before it', async (_case, place) => {
    const { elements, client } = await helper(four());
    const { ids } = ok<{ ids: string[] }>(
      await call(client, 'add_shapes', { shapes: [square, { ...square, type: 'ellipse' }], ...place }),
    );
    expectRising(elements, ['a', 'a-label', 'b', 'c', 'd', ...ids]);
    expect(await order(client)).toEqual(['a', 'b', 'c', 'd', ...ids]);
  });

  it('puts the shapes behind every shape where place is back, each label just above its shape', async () => {
    const { elements, client } = await helper(four());
    const { ids } = ok<{ ids: string[] }>(
      await call(client, 'add_shapes', {
        shapes: [{ ...square, width: 400, height: 300, label: { text: 'Background' } }, { ...square, type: 'ellipse' }],
        place: 'back',
      }),
    );
    const [box, ring] = ids;
    expectRising(elements, [box, labelOf(elements, box), 'a']);
    expectRising(elements, [box, ring, 'a', 'a-label', 'b', 'c', 'd']);
    expect(await order(client)).toEqual([box, ring, 'a', 'b', 'c', 'd']);
  });

  it('puts the shapes just below the shape that place.below names', async () => {
    const { elements, client } = await helper(four());
    const { ids } = ok<{ ids: string[] }>(
      await call(client, 'add_shapes', { shapes: [square, { ...square, type: 'diamond' }], place: { below: 'c' } }),
    );
    expectRising(elements, ['b', ...ids, 'c', 'd']);
    expect(await order(client)).toEqual(['a', 'b', ...ids, 'c', 'd']);
  });

  it('puts the shapes just above the shape that place.above names and its label', async () => {
    const { elements, client } = await helper(four());
    const { ids } = ok<{ ids: string[] }>(await call(client, 'add_shapes', { shapes: [square], place: { above: 'a' } }));
    expectRising(elements, ['a', 'a-label', ...ids, 'b']);
    expect(await order(client)).toEqual(['a', ...ids, 'b', 'c', 'd']);
  });

  it.each<[string, Element, string]>([
    ["a shape the board doesn't hold", { below: 'missing' }, `place.below is "missing", which isn't the id of a shape on the board`],
    ['a deleted shape', { above: 'gone' }, `place.above is "gone", which isn't the id of a shape on the board`],
    [
      'a label',
      { below: 'a-label' },
      `place.below is "a-label", the label of the shape "a", which get_board lists with its label: place the shapes below "a".`,
    ],
    ["a shape that doesn't have an index", { above: 'loose' }, `place.above is "loose", which doesn't have an index in the board's stacking order`],
  ])('refuses a place that names %s, and adds nothing', async (_case, place, refusal) => {
    const { elements, client } = await helper([
      ...four(),
      drawn({ id: 'gone', type: 'rectangle', index: 'a5', isDeleted: true }),
      drawn({ id: 'loose', type: 'rectangle' }),
    ]);
    const before = snapshot(elements);
    const result = await call(client, 'add_shapes', { shapes: [square], place });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain(refusal);
    expect(snapshot(elements)).toBe(before);
  });

  it('refuses a place that sets both below and above, and adds nothing', async () => {
    const { elements, client } = await helper(four());
    const before = snapshot(elements);
    const result = await call(client, 'add_shapes', { shapes: [square], place: { below: 'b', above: 'c' } });
    expect(result.isError).toBe(true);
    expect(snapshot(elements)).toBe(before);
  });
});

describe('reorder_shapes', () => {
  it('moves a shape and its label in front of every shape, each with a new version, and leaves the others as they are', async () => {
    const { elements, client } = await helper(four());
    expect(ok<{ ids: string[] }>(await call(client, 'reorder_shapes', { ids: ['a'], place: 'front' })).ids).toEqual(['a']);
    expectRising(elements, ['b', 'c', 'd', 'a', 'a-label']);
    expect(elements.get('a')?.version).toBe(2);
    expect(elements.get('a-label')?.version).toBe(2);
    expect(elements.get('b')).toMatchObject({ index: 'a2', version: 1 });
    expect(await order(client)).toEqual(['b', 'c', 'd', 'a']);
  });

  it('moves a shape behind every shape', async () => {
    const { elements, client } = await helper(four());
    expect(ok<{ ids: string[] }>(await call(client, 'reorder_shapes', { ids: ['d'], place: 'back' })).ids).toEqual(['d']);
    expectRising(elements, ['d', 'a', 'a-label', 'b', 'c']);
    expect(elements.get('a')).toMatchObject({ index: 'a0', version: 1 });
    expect(await order(client)).toEqual(['d', 'a', 'b', 'c']);
  });

  it('moves shapes just below the shape that place.below names, in the order the board held them, whatever order ids lists', async () => {
    const { elements, client } = await helper([...four(), drawn({ id: 'loose', type: 'rectangle' })]);
    expect(await order(client)).toEqual(['a', 'b', 'c', 'd', 'loose']);
    const moved = ok<{ ids: string[] }>(
      await call(client, 'reorder_shapes', { ids: ['loose', 'd', 'b'], place: { below: 'a' } }),
    );
    expect(moved.ids).toEqual(['b', 'd', 'loose']);
    expectRising(elements, ['b', 'd', 'loose', 'a', 'a-label', 'c']);
    expect(await order(client)).toEqual(['b', 'd', 'loose', 'a', 'c']);
  });

  it('moves a shape just above the shape that place.above names and its label', async () => {
    const { elements, client } = await helper(four());
    expect(ok<{ ids: string[] }>(await call(client, 'reorder_shapes', { ids: ['d'], place: { above: 'a' } })).ids).toEqual(['d']);
    expectRising(elements, ['a', 'a-label', 'd', 'b', 'c']);
    expect(await order(client)).toEqual(['a', 'd', 'b', 'c']);
  });

  it.each<[string, Element, string]>([
    ["an id the board doesn't hold", { ids: ['missing'], place: 'front' }, `ids[0] is "missing", which isn't the id of a shape on the board`],
    [
      'a label',
      { ids: ['a-label'], place: 'front' },
      `ids[0] is "a-label", the label of the shape "a", which get_board lists with its label: move "a", and its label moves with it.`,
    ],
    ['one id twice', { ids: ['b', 'c', 'b'], place: 'back' }, `ids[2] is "b", which ids[0] is too: list each shape once.`],
    [
      'a place that the call moves',
      { ids: ['b', 'c'], place: { below: 'c' } },
      `place.below is "c", which ids[1] moves too: place the shapes below a shape that stays where it is.`,
    ],
    ["a place the board doesn't hold", { ids: ['b'], place: { above: 'missing' } }, `place.above is "missing", which isn't the id of a shape on the board`],
    ['a place that is a label', { ids: ['b'], place: { below: 'a-label' } }, `place.below is "a-label", the label of the shape "a"`],
  ])('refuses %s, and moves nothing', async (_case, args, refusal) => {
    const { elements, client } = await helper(four());
    const before = snapshot(elements);
    const result = await call(client, 'reorder_shapes', args);
    expect(result.isError).toBe(true);
    expect(text(result)).toContain(refusal);
    expect(snapshot(elements)).toBe(before);
  });
});
