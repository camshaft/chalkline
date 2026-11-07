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
    expect(shape).toEqual({ id: 'free', kind: 'arrow', x: 10, y: 0, width: 0, height: -50, points: [[0, 0], [0, -50]] });
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

describe('groups', () => {
  /**
   * The group smiley: a face with a label, an eye, an arrow from the face to the eye, and an
   * arrow from the face to a cloud, which is in the group sky, inside the group weather. A note
   * outside every group has an arrow to the face.
   */
  const grouped = (): Element[] => [
    drawn({
      id: 'face',
      type: 'rectangle',
      index: 'a0',
      groupIds: ['smiley'],
      boundElements: [
        { id: 'face-label', type: 'text' },
        { id: 'tie', type: 'arrow' },
        { id: 'leash', type: 'arrow' },
        { id: 'pointer', type: 'arrow' },
      ],
    }),
    drawn({
      id: 'face-label',
      type: 'text',
      x: 10,
      y: 12,
      width: 80,
      height: 25,
      index: 'a1',
      containerId: 'face',
      groupIds: ['smiley'],
      text: 'Face',
      originalText: 'Face',
    }),
    drawn({
      id: 'eye',
      type: 'ellipse',
      x: 20,
      y: 10,
      width: 10,
      height: 10,
      index: 'a2',
      groupIds: ['smiley'],
      boundElements: [{ id: 'tie', type: 'arrow' }],
    }),
    drawn({
      id: 'tie',
      type: 'arrow',
      x: 50,
      y: 25,
      width: 10,
      height: 0,
      index: 'a3',
      groupIds: ['smiley'],
      points: [
        [0, 0],
        [10, 0],
      ],
      startBinding: { elementId: 'face', focus: 0, gap: 5 },
      endBinding: { elementId: 'eye', focus: 0, gap: 5 },
    }),
    drawn({
      id: 'leash',
      type: 'arrow',
      x: 50,
      y: 55,
      width: 0,
      height: 240,
      index: 'a4',
      groupIds: ['smiley'],
      points: [
        [0, 0],
        [0, 240],
      ],
      startBinding: { elementId: 'face', focus: 0, gap: 5 },
      endBinding: { elementId: 'cloud', focus: 0, gap: 5 },
    }),
    drawn({
      id: 'cloud',
      type: 'ellipse',
      y: 300,
      index: 'a5',
      groupIds: ['sky', 'weather'],
      boundElements: [{ id: 'leash', type: 'arrow' }],
    }),
    drawn({ id: 'note', type: 'rectangle', x: 300, index: 'a6', boundElements: [{ id: 'pointer', type: 'arrow' }] }),
    drawn({
      id: 'pointer',
      type: 'arrow',
      x: 295,
      y: 25,
      width: 190,
      height: 0,
      index: 'a7',
      points: [
        [0, 0],
        [-190, 0],
      ],
      startBinding: { elementId: 'note', focus: 0, gap: 5 },
      endBinding: { elementId: 'face', focus: 0, gap: 5 },
    }),
  ];

  /** The outline of a shape as the board holds it, which an arrow bound to it stops short of. */
  const outline = (element: Element | undefined) => ({
    type: element?.type === 'ellipse' ? ('ellipse' as const) : ('rectangle' as const),
    x: Number(element?.x),
    y: Number(element?.y),
    width: Number(element?.width),
    height: Number(element?.height),
    angle: 0,
  });

  /** Checks that the arrow `id` runs between the shapes `start` and `end`, as they stand on the board. */
  const expectBetween = (elements: Y.Map<Element>, id: string, start: string, end: string): void => {
    const expected = arrowPoints(outline(elements.get(start)), outline(elements.get(end)));
    if (expected === null) throw new Error(`"${start}" and "${end}" have one center`);
    const [from, to] = ends(elements.get(id));
    expectNear(from, expected.from);
    expectNear(to, expected.to);
  };

  it('puts the shapes of one add_shapes call into a new group, which get_board lists', async () => {
    const { elements, client } = await helper([drawn({ id: 'theirs', type: 'rectangle', x: 400, index: 'a0' })]);
    const added = ok<{ ids: string[]; group: string }>(
      await call(client, 'add_shapes', {
        shapes: [
          { type: 'rectangle', id: 'box', x: 0, y: 0, width: 100, height: 50, label: { text: 'Box' } },
          { type: 'ellipse', id: 'oval', x: 200, y: 0, width: 100, height: 50 },
          { type: 'arrow', id: 'link', x: 100, y: 25, width: 100, height: 0, start: 'box', end: 'oval' },
        ],
        group: true,
      }),
    );
    expect(added.ids).toEqual(['box', 'oval', 'link']);
    expect(added.group).toMatch(/^[\w-]{20}$/);
    const label = labelOf(elements, 'box');
    expect(label).toBeDefined();
    for (const element of [elements.get('box'), label, elements.get('oval'), elements.get('link')]) {
      expect(element?.groupIds, String(element?.id)).toEqual([added.group]);
    }
    expect(elements.get('theirs')?.groupIds).toBeUndefined();
    const groups = Object.fromEntries((await board(client)).map((shape) => [shape.id, shape.groups]));
    expect(groups).toEqual({ theirs: undefined, box: [added.group], oval: [added.group], link: [added.group] });
  });

  it('leaves the shapes of a call without group out of every group', async () => {
    const { elements, client } = await helper();
    const added = ok(await call(client, 'add_shapes', { shapes: [{ type: 'rectangle', id: 'solo', x: 0, y: 0, width: 100, height: 50 }] }));
    expect(added).toEqual({ ids: ['solo'] });
    expect(elements.get('solo')?.groupIds).toEqual([]);
    const [shape] = await board(client);
    expect(shape).not.toHaveProperty('groups');
  });

  it('lists each group a shape is in, the innermost first', async () => {
    const { client } = await helper(grouped());
    const groups = Object.fromEntries((await board(client)).map((shape) => [shape.id, shape.groups]));
    expect(groups).toEqual({
      face: ['smiley'],
      eye: ['smiley'],
      tie: ['smiley'],
      leash: ['smiley'],
      cloud: ['sky', 'weather'],
      note: undefined,
      pointer: undefined,
    });
  });

  it('deletes every shape of a group, and no other', async () => {
    const { elements, client } = await helper(grouped());
    const deleted = ok<{ ids: string[] }>(await call(client, 'delete_shapes', { groups: ['smiley'] }));
    expect(deleted.ids).toEqual(['face', 'eye', 'tie', 'leash']);
    for (const id of ['face', 'face-label', 'eye', 'tie', 'leash']) {
      expect(elements.get(id), id).toMatchObject({ isDeleted: true, version: 2 });
    }
    expect(elements.get('pointer')).toMatchObject({ isDeleted: false, startBinding: { elementId: 'note' }, endBinding: null, version: 2 });
    expect(elements.get('cloud')).toMatchObject({ isDeleted: false, boundElements: [], version: 2 });
    expect(elements.get('note')).toMatchObject({ isDeleted: false, version: 1 });
    expect((await board(client)).map((shape) => shape.id)).toEqual(['cloud', 'note', 'pointer']);
  });

  it('deletes ids and groups together, each shape once', async () => {
    const { client } = await helper(grouped());
    const deleted = ok<{ ids: string[] }>(await call(client, 'delete_shapes', { ids: ['eye', 'cloud'], groups: ['weather', 'smiley'] }));
    expect(deleted.ids).toEqual(['eye', 'cloud', 'face', 'tie', 'leash']);
    expect((await board(client)).map((shape) => shape.id)).toEqual(['note', 'pointer']);
  });

  it('moves a group by its left and top edges, with its labels and the arrows bound to it', async () => {
    const { elements, client } = await helper(grouped());
    const moved = ok<{ shapes: BoardShape[] }>(await call(client, 'update_shape', { group: 'smiley', x: 100, y: 200 })).shapes;
    expect(moved.map((shape) => shape.id)).toEqual(['face', 'eye', 'tie', 'leash']);
    expect(moved[0]).toEqual({ id: 'face', kind: 'rectangle', x: 100, y: 200, width: 100, height: 50, label: 'Face', groups: ['smiley'] });
    expect(elements.get('face')).toMatchObject({ x: 100, y: 200, version: 2 });
    expect(elements.get('face-label')).toMatchObject({ x: 110, y: 212, version: 2 });
    expect(elements.get('eye')).toMatchObject({ x: 120, y: 210, version: 2 });
    expect(elements.get('tie')).toMatchObject({
      x: 150,
      y: 225,
      points: [
        [0, 0],
        [10, 0],
      ],
      version: 2,
    });
    expect(elements.get('cloud')).toMatchObject({ x: 0, y: 300, version: 1 });
    expect(elements.get('note')).toMatchObject({ x: 300, y: 0, version: 1 });
    expectBetween(elements, 'leash', 'face', 'cloud');
    expectBetween(elements, 'pointer', 'note', 'face');
  });

  it('moves a group along one axis where the call sets x or y alone', async () => {
    const { elements, client } = await helper(grouped());
    const moved = ok<{ shapes: BoardShape[] }>(await call(client, 'update_shape', { group: 'weather', y: 400 })).shapes;
    expect(moved).toEqual([{ id: 'cloud', kind: 'ellipse', x: 0, y: 400, width: 100, height: 50, groups: ['sky', 'weather'] }]);
    expect(elements.get('face')).toMatchObject({ x: 0, y: 0, version: 1 });
    expectBetween(elements, 'leash', 'face', 'cloud');
  });

  it("puts a label that update_shape adds into its shape's groups", async () => {
    const { elements, client } = await helper(grouped());
    ok(await call(client, 'update_shape', { id: 'eye', label: { text: 'Eye' } }));
    ok(await call(client, 'update_shape', { id: 'tie', label: { text: 'Tie' } }));
    expect(labelOf(elements, 'eye')?.groupIds).toEqual(['smiley']);
    expect(labelOf(elements, 'tie')?.groupIds).toEqual(['smiley']);
  });

  it('refuses each group it cannot move or delete, and changes nothing', async () => {
    const { elements, client } = await helper(grouped());
    const before = JSON.stringify(elements.toJSON());
    const cases: [string, Element, string][] = [
      ['update_shape', { x: 1 }, "The call doesn't name a shape: give id, the shape to change, or group, a group to move."],
      [
        'update_shape',
        { id: 'face', group: 'smiley', x: 1 },
        `The call sets id "face" and group "smiley": give id to change one shape, or group to move a group.`,
      ],
      [
        'update_shape',
        { group: 'smiley', width: 5 },
        `width doesn't apply to a group, such as "smiley": update_shape moves a group by x and y, and changes each of its shapes by that shape's id.`,
      ],
      ['update_shape', { group: 'smiley' }, `The call doesn't move the group "smiley": give its x, its y or both.`],
      [
        'update_shape',
        { group: 'missing', x: 1 },
        `group is "missing", which no shape on the board is in: get_board lists each shape's groups.`,
      ],
      ['delete_shapes', {}, "The call doesn't name a shape to delete: give ids, groups or both."],
      ['delete_shapes', { groups: ['smiley', 'smiley'] }, `groups[1] is "smiley", which groups[0] is too: list each group once.`],
      [
        'delete_shapes',
        { groups: ['missing'] },
        `groups[0] is "missing", which no shape on the board is in: get_board lists each shape's groups.`,
      ],
      [
        'delete_shapes',
        { ids: ['missing'], groups: ['smiley'] },
        `ids[0] is "missing", which isn't the id of a shape on the board: get_board lists each shape's id.`,
      ],
    ];
    for (const [tool, args, refusal] of cases) {
      const result = await call(client, tool, args);
      expect(result.isError, `${tool} ${JSON.stringify(args)}`).toBe(true);
      expect(text(result)).toBe(refusal);
    }
    expect(JSON.stringify(elements.toJSON())).toBe(before);
  });

  it('names the group in the tools that read, add, move and delete it', async () => {
    const { client } = await helper();
    const { tools } = await client.listTools();
    const tool = (name: string) => tools.find((candidate) => candidate.name === name);
    for (const name of ['get_board', 'add_shapes', 'update_shape', 'delete_shapes']) {
      expect(tool(name)?.description, name).toContain('group');
    }
    expect(Object.keys(tool('add_shapes')?.inputSchema.properties ?? {})).toContain('group');
    expect(Object.keys(tool('update_shape')?.inputSchema.properties ?? {})).toContain('group');
    expect(Object.keys(tool('delete_shapes')?.inputSchema.properties ?? {})).toContain('groups');
    const answer = tool('get_board')?.outputSchema as unknown as {
      properties: { shapes: { items: { properties: Record<string, unknown> } } };
    };
    expect(Object.keys(answer.properties.shapes.items.properties)).toContain('groups');
  });
});
