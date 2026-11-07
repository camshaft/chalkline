import { Awareness } from '@chalkline/sync';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { ELEMENTS } from './board';
import { arrowPoints, type Point } from './geometry';
import { createServer } from './server';
import type { BoardShape } from './shapes';

type Element = Record<string, unknown>;

/** The agent the tests' client is, by the name it gives as it connects. */
const AGENT = { kind: 'agent', name: 'chalkline-test' };
const MARK = { customData: { chalkline: { creator: AGENT } } };

const clients: Client[] = [];
const awarenesses: Awareness[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
  for (const awareness of awarenesses.splice(0)) awareness.destroy();
});

/** chalkline-mcp's copy of a board that holds `elements`, and an MCP client connected to its server. */
async function helper(elements: Element[] = []): Promise<{ elements: Y.Map<Element>; client: Client }> {
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

async function board(client: Client): Promise<BoardShape[]> {
  return ok<{ shapes: BoardShape[] }>(await call(client, 'get_board')).shapes;
}

/** The first and the last point of an arrow or a line on the board. */
function ends(element: Element | undefined): [Point, Point] {
  const points = (element?.points ?? []) as [number, number][];
  const x = Number(element?.x);
  const y = Number(element?.y);
  const [first, last] = [points[0], points[points.length - 1]];
  return [
    { x: x + first[0], y: y + first[1] },
    { x: x + last[0], y: y + last[1] },
  ];
}

/** Excalidraw moves an arrow's ends by half a pixel as it binds them, so a point is near where it was asked. */
function expectNear(actual: Point, expected: Point, tolerance = 1): void {
  expect(Math.abs(actual.x - expected.x), `x of ${JSON.stringify(actual)}`).toBeLessThanOrEqual(tolerance);
  expect(Math.abs(actual.y - expected.y), `y of ${JSON.stringify(actual)}`).toBeLessThanOrEqual(tolerance);
}

/** The label of the shape `id`, where it has one that isn't deleted. */
function labelOf(elements: Y.Map<Element>, id: string): Element | undefined {
  return [...elements.values()].find((element) => element.containerId === id && element.isDeleted !== true);
}

describe('the creator mark', () => {
  it('marks each shape add_shapes adds, and its label, and get_board lists it', async () => {
    const { elements, client } = await helper([drawn({ id: 'theirs', type: 'rectangle', index: 'a0' })]);
    const [id] = ok<{ ids: string[] }>(
      await call(client, 'add_shapes', {
        shapes: [{ type: 'rectangle', x: 200, y: 0, width: 100, height: 50, label: { text: 'Mine' } }],
      }),
    ).ids;
    expect(elements.get(id)).toMatchObject(MARK);
    expect(labelOf(elements, id)).toMatchObject(MARK);
    const shapes = await board(client);
    expect(shapes.find((shape) => shape.id === id)?.creator).toEqual(AGENT);
    expect(shapes.find((shape) => shape.id === 'theirs')?.creator).toBeUndefined();
  });
});

describe('connect', () => {
  it('draws a labelled arrow from the edge of one shape to the edge of the other, bound to both', async () => {
    const { elements, client } = await helper([
      drawn({ id: 'a', type: 'rectangle', index: 'a0' }),
      drawn({ id: 'b', type: 'ellipse', x: 300, index: 'a1' }),
    ]);
    const { id } = ok<{ id: string }>(await call(client, 'connect', { start: 'a', end: 'b', label: { text: 'then' } }));

    const arrow = elements.get(id);
    expect(arrow).toMatchObject({ type: 'arrow', startBinding: { elementId: 'a' }, endBinding: { elementId: 'b' }, ...MARK });
    const [from, to] = ends(arrow);
    expectNear(from, { x: 105, y: 25 });
    expectNear(to, { x: 295, y: 25 });
    for (const shape of ['a', 'b']) {
      expect(elements.get(shape)).toMatchObject({ version: 2, boundElements: [{ id, type: 'arrow' }] });
    }
    const label = labelOf(elements, id);
    expect(label).toMatchObject({ type: 'text', originalText: 'then', ...MARK });
    expect(arrow?.boundElements).toEqual([{ id: label?.id, type: 'text' }]);
    const indices = [elements.get('a'), elements.get('b'), arrow, label].map((element) => String(element?.index));
    expect([...indices].sort()).toEqual(indices);
    expect((await board(client)).find((shape) => shape.id === id)).toMatchObject({
      kind: 'arrow',
      start: 'a',
      end: 'b',
      label: 'then',
      creator: AGENT,
    });
  });

  it('draws an arrow straight down, with the id and the color the call sets', async () => {
    const { elements, client } = await helper([
      drawn({ id: 'top', type: 'rectangle', index: 'a0' }),
      drawn({ id: 'bottom', type: 'diamond', y: 200, height: 100, index: 'a1' }),
    ]);
    const { id } = ok<{ id: string }>(
      await call(client, 'connect', { start: 'top', end: 'bottom', id: 'down', strokeColor: '#1971c2' }),
    );
    expect(id).toBe('down');
    expect(elements.get('down')).toMatchObject({ strokeColor: '#1971c2', startBinding: { elementId: 'top' } });
    const [from, to] = ends(elements.get('down'));
    expectNear(from, { x: 50, y: 55 });
    expectNear(to, { x: 50, y: 195 });
  });

  it('refuses each call it cannot draw, and changes nothing', async () => {
    const { elements, client } = await helper([
      drawn({ id: 'a', type: 'rectangle', index: 'a0', boundElements: [{ id: 'a-label', type: 'text' }] }),
      drawn({ id: 'a-label', type: 'text', index: 'a1', containerId: 'a', text: 'A', originalText: 'A' }),
      drawn({ id: 'b', type: 'ellipse', x: 300, index: 'a2' }),
      drawn({ id: 'l', type: 'line', index: 'a3', points: [[0, 0], [100, 0]] }),
      drawn({ id: 'gone', type: 'rectangle', index: 'a4', isDeleted: true }),
      drawn({ id: 'big', type: 'rectangle', y: 400, width: 200, height: 200, index: 'a5' }),
      drawn({ id: 'small', type: 'rectangle', x: 50, y: 450, width: 100, height: 100, index: 'a6' }),
    ]);
    const before = JSON.stringify(elements.toJSON());
    const cases: [Element, string][] = [
      [{ start: 'missing', end: 'b' }, `start is "missing", which isn't the id of a shape on the board: get_board lists each shape's id.`],
      [{ start: 'a', end: 'gone' }, `end is "gone", which isn't the id of a shape on the board: get_board lists each shape's id.`],
      [
        { start: 'a-label', end: 'b' },
        `start is "a-label", the label of the shape "a", which get_board lists with its label: connect "a" in its place.`,
      ],
      [
        { start: 'a', end: 'l' },
        `end is "l", a line, which an arrow doesn't bind to: connect a rectangle, an ellipse, a diamond, a text, an image or a frame.`,
      ],
      [{ start: 'a', end: 'a' }, `start and end are both "a": connect draws an arrow between two shapes.`],
      [
        { start: 'a', end: 'b', id: 'b' },
        `id is "b", which a shape on the board has already, or a deleted one had: give the arrow another id, or leave it out.`,
      ],
      [
        { start: 'big', end: 'small' },
        `"big" and "small" have one center, so an arrow between them has no direction: move one of them with update_shape first.`,
      ],
    ];
    for (const [args, refusal] of cases) {
      const result = await call(client, 'connect', args);
      expect(result.isError, JSON.stringify(args)).toBe(true);
      expect(text(result)).toBe(refusal);
    }
    expect(JSON.stringify(elements.toJSON())).toBe(before);
  });
});

describe('update_shape', () => {
  it('moves a shape with its label, and lays the arrow bound to it out again', async () => {
    const { elements, client } = await helper([
      drawn({
        id: 'box',
        type: 'rectangle',
        index: 'a0',
        boundElements: [
          { id: 'box-label', type: 'text' },
          { id: 'link', type: 'arrow' },
        ],
      }),
      drawn({ id: 'box-label', type: 'text', x: 10, y: 12, width: 80, height: 25, index: 'a1', containerId: 'box', text: 'Box', originalText: 'Box' }),
      drawn({ id: 'other', type: 'ellipse', x: 300, index: 'a2', boundElements: [{ id: 'link', type: 'arrow' }] }),
      drawn({
        id: 'link',
        type: 'arrow',
        x: 105,
        y: 25,
        width: 190,
        height: 0,
        index: 'a3',
        points: [
          [0, 0],
          [190, 0],
        ],
        startBinding: { elementId: 'box', focus: 0, gap: 5 },
        endBinding: { elementId: 'other', focus: 0, gap: 5 },
        boundElements: [{ id: 'link-label', type: 'text' }],
      }),
      drawn({ id: 'link-label', type: 'text', x: 180, y: 13, width: 40, height: 25, index: 'a4', containerId: 'link', text: 'to', originalText: 'to' }),
    ]);
    const { shape } = ok<{ shape: BoardShape }>(await call(client, 'update_shape', { id: 'box', y: 200 }));
    expect(shape).toEqual({ id: 'box', kind: 'rectangle', x: 0, y: 200, width: 100, height: 50, label: 'Box' });

    expect(elements.get('box')).toMatchObject({ x: 0, y: 200, version: 2 });
    expect(elements.get('box-label')).toMatchObject({ x: 10, y: 212, version: 2 });
    const expected = arrowPoints(
      { type: 'rectangle', x: 0, y: 200, width: 100, height: 50, angle: 0 },
      { type: 'ellipse', x: 300, y: 0, width: 100, height: 50, angle: 0 },
    );
    if (expected === null) throw new Error('the two shapes have one center');
    const link = elements.get('link');
    expect(link).toMatchObject({ startBinding: { elementId: 'box' }, endBinding: { elementId: 'other' }, version: 2 });
    const [from, to] = ends(link);
    expectNear(from, expected.from);
    expectNear(to, expected.to);
    const label = elements.get('link-label');
    const middle = { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 };
    expectNear({ x: Number(label?.x) + Number(label?.width) / 2, y: Number(label?.y) + Number(label?.height) / 2 }, middle, 2);
  });

  it("adds, replaces and removes a diamond's label", async () => {
    const { elements, client } = await helper([drawn({ id: 'gem', type: 'diamond', width: 200, height: 100, index: 'a0' })]);

    ok(await call(client, 'update_shape', { id: 'gem', label: { text: 'Yes' } }));
    const added = labelOf(elements, 'gem');
    expect(added).toMatchObject({ type: 'text', originalText: 'Yes', containerId: 'gem', ...MARK });
    expect(elements.get('gem')?.boundElements).toEqual([{ id: added?.id, type: 'text' }]);

    ok(await call(client, 'update_shape', { id: 'gem', label: { text: 'Yes or no' } }));
    expect(labelOf(elements, 'gem')).toMatchObject({ id: added?.id, originalText: 'Yes or no' });
    expect((await board(client))[0]).toMatchObject({ id: 'gem', label: 'Yes or no' });

    ok(await call(client, 'update_shape', { id: 'gem', label: { text: '' } }));
    expect(labelOf(elements, 'gem')).toBeUndefined();
    expect(elements.get(String(added?.id))).toMatchObject({ isDeleted: true });
    expect(elements.get('gem')?.boundElements).toEqual([]);
    expect((await board(client))[0].label).toBeUndefined();
  });

  it('measures a text again for a new text and font size', async () => {
    const { elements, client } = await helper([
      drawn({ id: 'note', type: 'text', index: 'a0', text: 'Note', originalText: 'Note', fontSize: 20, fontFamily: 5, lineHeight: 1.25 }),
    ]);
    ok(await call(client, 'update_shape', { id: 'note', fontSize: 20 }));
    const before = elements.get('note');
    ok(await call(client, 'update_shape', { id: 'note', text: 'Notes', fontSize: 40, strokeColor: '#2f9e44' }));
    const after = elements.get('note');
    expect(after).toMatchObject({ text: 'Notes', originalText: 'Notes', fontSize: 40, strokeColor: '#2f9e44', autoResize: true });
    expect(after?.version).toBe(Number(before?.version) + 1);
    expect(Number(after?.width)).toBeCloseTo((Number(before?.width) * 5) / 4 * 2, 0);
    expect(Number(after?.height)).toBeCloseTo(Number(before?.height) * 2, 0);
  });

  it('draws a free arrow to a new end from its first point', async () => {
    const { elements, client } = await helper([
      drawn({ id: 'free', type: 'arrow', index: 'a0', height: 0, points: [[0, 0], [100, 0]] }),
    ]);
    const { shape } = ok<{ shape: BoardShape }>(
      await call(client, 'update_shape', { id: 'free', x: 10, y: null, width: 0, height: -50 }),
    );
    expect(elements.get('free')).toMatchObject({ x: 10, y: 0, width: 0, height: 50, points: [[0, 0], [0, -50]], version: 2 });
    expect(shape).toEqual({ id: 'free', kind: 'arrow', x: 10, y: 0, width: 0, height: -50 });
  });

  it('recolors a shape and its label', async () => {
    const { elements, client } = await helper([
      drawn({
        id: 'oval',
        type: 'ellipse',
        width: 160,
        height: 80,
        index: 'a0',
        strokeColor: '#1e1e1e',
        backgroundColor: 'transparent',
        boundElements: [{ id: 'oval-label', type: 'text' }],
      }),
      drawn({ id: 'oval-label', type: 'text', x: 30, y: 27, width: 100, height: 25, index: 'a1', containerId: 'oval', text: 'Start', originalText: 'Start', strokeColor: '#1e1e1e' }),
    ]);
    ok(await call(client, 'update_shape', { id: 'oval', strokeColor: '#e03131', backgroundColor: '#ffc9c9' }));
    expect(elements.get('oval')).toMatchObject({ strokeColor: '#e03131', backgroundColor: '#ffc9c9', width: 160, height: 80 });
    expect(elements.get('oval-label')).toMatchObject({ strokeColor: '#e03131', x: 30, y: 27 });
  });

  it('refuses each change it cannot make, and changes nothing', async () => {
    const { elements, client } = await helper([
      drawn({ id: 'box', type: 'rectangle', index: 'a0', boundElements: [{ id: 'box-label', type: 'text' }, { id: 'tied', type: 'arrow' }] }),
      drawn({ id: 'box-label', type: 'text', index: 'a1', containerId: 'box', text: 'Box', originalText: 'Box' }),
      drawn({ id: 'note', type: 'text', y: 100, index: 'a2', text: 'Note', originalText: 'Note' }),
      drawn({ id: 'tied', type: 'arrow', x: 105, index: 'a3', points: [[0, 0], [100, 0]], startBinding: { elementId: 'box', focus: 0, gap: 5 } }),
      drawn({ id: 'bent', type: 'arrow', y: 200, index: 'a4', points: [[0, 0], [50, 50], [100, 0]] }),
      drawn({ id: 'scribble', type: 'freedraw', y: 300, index: 'a5', points: [[0, 0], [10, 10]] }),
    ]);
    const before = JSON.stringify(elements.toJSON());
    const cases: [Element, string][] = [
      [{ id: 'missing', x: 1 }, `id is "missing", which isn't the id of a shape on the board: get_board lists each shape's id.`],
      [
        { id: 'box-label', x: 1 },
        `id is "box-label", the label of the shape "box", which get_board lists with its label: change it with update_shape, the id "box" and label.`,
      ],
      [
        { id: 'scribble', x: 1 },
        `"scribble" is a freedraw, which update_shape doesn't change: it changes rectangles, ellipses, diamonds, texts, arrows and lines.`,
      ],
      [
        { id: 'box' },
        `The call doesn't change "box": give a rectangle's x, y, width, height, label, strokeColor and backgroundColor, or some of them.`,
      ],
      [
        { id: 'box', x: null },
        `The call doesn't change "box": give a rectangle's x, y, width, height, label, strokeColor and backgroundColor, or some of them.`,
      ],
      [
        { id: 'note', backgroundColor: '#ffffff' },
        `backgroundColor doesn't apply to a text, such as "note": update_shape changes its x, y, text, fontSize and strokeColor.`,
      ],
      [{ id: 'box', width: 0 }, `width is 0: a rectangle's width is above 0.`],
      [
        { id: 'tied', x: 5 },
        `"tied" follows the shapes it is bound to, "box": move them, or delete the arrow and connect the shapes again.`,
      ],
      [{ id: 'bent', width: 10 }, `width and height change a straight arrow of two points, and "bent" has 3: move it with x and y.`],
    ];
    for (const [args, refusal] of cases) {
      const result = await call(client, 'update_shape', args);
      expect(result.isError, JSON.stringify(args)).toBe(true);
      expect(text(result)).toBe(refusal);
    }
    expect(JSON.stringify(elements.toJSON())).toBe(before);
  });
});

describe('delete_shapes', () => {
  /** Two shapes and an arrow bound to both, the first with a label. */
  const linked = (): Element[] => [
    drawn({
      id: 'a',
      type: 'rectangle',
      index: 'a0',
      boundElements: [
        { id: 'a-label', type: 'text' },
        { id: 'ab', type: 'arrow' },
      ],
    }),
    drawn({ id: 'a-label', type: 'text', index: 'a1', containerId: 'a', text: 'A', originalText: 'A' }),
    drawn({ id: 'b', type: 'ellipse', x: 300, index: 'a2', boundElements: [{ id: 'ab', type: 'arrow' }] }),
    drawn({
      id: 'ab',
      type: 'arrow',
      x: 105,
      y: 25,
      width: 190,
      height: 0,
      index: 'a3',
      points: [
        [0, 0],
        [190, 0],
      ],
      startBinding: { elementId: 'a', focus: 0, gap: 5 },
      endBinding: { elementId: 'b', focus: 0, gap: 5 },
    }),
  ];

  it('deletes a shape with its label, and frees the end of the arrow bound to it', async () => {
    const { elements, client } = await helper(linked());
    expect(ok<{ ids: string[] }>(await call(client, 'delete_shapes', { ids: ['a'] })).ids).toEqual(['a']);
    expect(elements.get('a')).toMatchObject({ isDeleted: true, version: 2 });
    expect(elements.get('a-label')).toMatchObject({ isDeleted: true, version: 2 });
    expect(elements.get('ab')).toMatchObject({ isDeleted: false, startBinding: null, endBinding: { elementId: 'b' }, version: 2 });
    const shapes = await board(client);
    expect(shapes.map((shape) => shape.id)).toEqual(['b', 'ab']);
    expect(shapes[1].start).toBeUndefined();
    expect(shapes[1].end).toBe('b');
  });

  it('deletes an arrow, which the shapes it was bound to no longer list', async () => {
    const { elements, client } = await helper(linked());
    ok(await call(client, 'delete_shapes', { ids: ['ab'] }));
    expect(elements.get('ab')).toMatchObject({ isDeleted: true });
    expect(elements.get('a')).toMatchObject({ boundElements: [{ id: 'a-label', type: 'text' }], version: 2 });
    expect(elements.get('b')).toMatchObject({ boundElements: [], version: 2 });
  });

  it('refuses each list it cannot delete, and deletes nothing', async () => {
    const { elements, client } = await helper(linked());
    const before = JSON.stringify(elements.toJSON());
    const cases: [string[], string][] = [
      [['missing'], `ids[0] is "missing", which isn't the id of a shape on the board: get_board lists each shape's id.`],
      [
        ['a-label'],
        `ids[0] is "a-label", the label of the shape "a", which get_board lists with its label: delete "a", or remove its label with update_shape and an empty label.`,
      ],
      [['a', 'b', 'a'], `ids[2] is "a", which ids[0] is too: list each shape once.`],
    ];
    for (const [ids, refusal] of cases) {
      const result = await call(client, 'delete_shapes', { ids });
      expect(result.isError, JSON.stringify(ids)).toBe(true);
      expect(text(result)).toBe(refusal);
    }
    expect(JSON.stringify(elements.toJSON())).toBe(before);
  });
});
