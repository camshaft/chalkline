import { Awareness } from '@chalkline/sync';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { ELEMENTS, FRAME_MARGIN } from './board';
import { createServer } from './server';
import type { BoardFrame, BoardShape } from './shapes';

type Element = Record<string, unknown>;

/** The agent the tests' client is, by the name it gives as it connects. */
const AGENT = { kind: 'agent', name: 'chalkline-test' };

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

async function board(client: Client): Promise<{ shapes: BoardShape[]; frames: BoardFrame[] }> {
  return ok<{ shapes: BoardShape[]; frames: BoardFrame[] }>(await call(client, 'get_board'));
}

/** The label element of the shape `id` on the board. */
function labelOf(elements: Y.Map<Element>, id: string): Element | undefined {
  return [...elements.values()].find((element) => element.type === 'text' && element.containerId === id);
}

/** The last point of an arrow on the board. */
function lastPoint(element: Element | undefined): { x: number; y: number } {
  const points = (element?.points ?? []) as [number, number][];
  const last = points[points.length - 1];
  return { x: Number(element?.x) + last[0], y: Number(element?.y) + last[1] };
}

describe('frames', () => {
  it("puts a call's shapes into a new frame of the name frame gives, sized to them with a margin, and answers its id", async () => {
    const { elements, client } = await helper();
    const added = ok<{ ids: string[]; frame: string; group?: string }>(
      await call(client, 'add_shapes', {
        shapes: [
          { id: 'box', type: 'rectangle', x: 100, y: 50, width: 200, height: 80, label: { text: 'Start' } },
          { id: 'round', type: 'ellipse', x: 400, y: 200, width: 100, height: 60 },
        ],
        frame: { name: 'Plan' },
      }),
    );
    expect(added.ids).toEqual(['box', 'round']);
    expect(added.group).toBeUndefined();
    const frame = elements.get(added.frame);
    expect(frame).toMatchObject({
      type: 'frame',
      name: 'Plan',
      x: 100 - FRAME_MARGIN,
      y: 50 - FRAME_MARGIN,
      width: 400 + 2 * FRAME_MARGIN,
      height: 210 + 2 * FRAME_MARGIN,
      isDeleted: false,
      customData: { chalkline: { creator: AGENT } },
    });
    expect(frame?.frameId ?? null).toBeNull();
    // Each element the call adds is in the frame, the rectangle's label among them, and the frame is in front of them.
    const label = labelOf(elements, 'box');
    expect(label?.frameId).toBe(added.frame);
    for (const element of [elements.get('box'), elements.get('round'), label]) {
      expect(element?.frameId).toBe(added.frame);
      expect(String(element?.index) < String(frame?.index)).toBe(true);
    }

    const { shapes, frames } = await board(client);
    expect(shapes.map((shape) => shape.id)).toEqual(['box', 'round', added.frame]);
    expect(shapes[2]).toMatchObject({ kind: 'frame', label: 'Plan', creator: AGENT });
    expect(frames).toEqual([
      {
        id: added.frame,
        name: 'Plan',
        x: 100 - FRAME_MARGIN,
        y: 50 - FRAME_MARGIN,
        width: 400 + 2 * FRAME_MARGIN,
        height: 210 + 2 * FRAME_MARGIN,
        members: ['box', 'round'],
      },
    ]);
  });

  it("puts the shapes into the call's group and its frame, and leaves the frame out of the group", async () => {
    const { elements, client } = await helper();
    const added = ok<{ ids: string[]; frame: string; group: string }>(
      await call(client, 'add_shapes', {
        shapes: [
          { id: 'a', type: 'rectangle', x: 0, y: 0, width: 50, height: 50 },
          { id: 'b', type: 'rectangle', x: 100, y: 0, width: 50, height: 50 },
        ],
        group: true,
        frame: { name: 'Grouped' },
      }),
    );
    expect(elements.get('a')?.groupIds).toEqual([added.group]);
    expect(elements.get('b')?.groupIds).toEqual([added.group]);
    expect(elements.get(added.frame)?.groupIds).toEqual([]);
    expect((await board(client)).frames.map((frame) => frame.members)).toEqual([['a', 'b']]);
  });

  it('lists each frame of the board from back to front, with its name, its bounds and the shapes in it', async () => {
    const { client } = await helper([
      drawn({ id: 'lower', type: 'ellipse', frameId: 'f', index: 'a1' }),
      drawn({ id: 'upper', type: 'rectangle', frameId: 'f', index: 'a2', boundElements: [{ id: 'upper-label', type: 'text' }] }),
      drawn({ id: 'upper-label', type: 'text', containerId: 'upper', text: 'Upper', originalText: 'Upper', frameId: 'f', index: 'a3' }),
      drawn({ id: 'outside', type: 'rectangle', x: 700, index: 'a4' }),
      drawn({ id: 'f', type: 'frame', name: null, width: 500, height: 400, index: 'a5' }),
      drawn({ id: 'g', type: 'frame', name: 'Second', x: 1000, width: 300, height: 200, index: 'a6' }),
      drawn({ id: 'inside', type: 'rectangle', x: 1050, frameId: 'g', index: 'a7' }),
      drawn({ id: 'stray', type: 'rectangle', x: 2000, frameId: 'gone', index: 'a8' }),
      drawn({ id: 'gone', type: 'frame', name: 'Deleted', isDeleted: true, index: 'a9' }),
    ]);
    const { shapes, frames } = await board(client);
    expect(frames).toEqual([
      { id: 'f', x: 0, y: 0, width: 500, height: 400, members: ['lower', 'upper'] },
      { id: 'g', name: 'Second', x: 1000, y: 0, width: 300, height: 200, members: ['inside'] },
    ]);
    expect(shapes.find((shape) => shape.id === 'g')?.label).toBe('Second');
    expect(shapes.find((shape) => shape.id === 'f')?.label).toBeUndefined();
  });

  it('moves a frame with every shape in it, each with its label, and an arrow bound to one of them follows it', async () => {
    const { elements, client } = await helper();
    const { frame } = ok<{ frame: string }>(
      await call(client, 'add_shapes', {
        shapes: [{ id: 'a', type: 'rectangle', x: 100, y: 100, width: 100, height: 50, label: { text: 'A' } }],
        frame: { name: 'One' },
      }),
    );
    ok(await call(client, 'add_shapes', { shapes: [{ id: 'b', type: 'rectangle', x: 600, y: 100, width: 100, height: 50 }] }));
    const { id: arrow } = ok<{ id: string }>(await call(client, 'connect', { start: 'b', end: 'a' }));
    const label = labelOf(elements, 'a');
    const labelX = Number(label?.x);
    const labelY = Number(label?.y);

    const moved = ok<{ shape: BoardShape }>(await call(client, 'update_shape', { id: frame, x: 290, y: 390, name: 'Renamed' }));
    expect(moved.shape).toMatchObject({ id: frame, kind: 'frame', x: 290, y: 390, label: 'Renamed' });
    expect(elements.get(frame)).toMatchObject({ x: 290, y: 390, name: 'Renamed' });
    expect(elements.get('a')).toMatchObject({ x: 300, y: 400 });
    expect(labelOf(elements, 'a')).toMatchObject({ x: labelX + 200, y: labelY + 300 });
    expect(elements.get('b')).toMatchObject({ x: 600, y: 100 });
    // The arrow from b now ends at a's outline in its new place, above and right of a's center (350, 425).
    const end = lastPoint(elements.get(arrow));
    expect(end.y).toBeGreaterThan(380);
    expect(end.y).toBeLessThan(425);
    expect(end.x).toBeGreaterThan(350);
    expect(end.x).toBeLessThan(420);
    expect((await board(client)).frames).toEqual([
      { id: frame, name: 'Renamed', x: 290, y: 390, width: 100 + 2 * FRAME_MARGIN, height: 50 + 2 * FRAME_MARGIN, members: ['a'] },
    ]);

    // A name alone renames the frame, and leaves it and its shapes where they are.
    ok(await call(client, 'update_shape', { id: frame, name: 'Third' }));
    expect(elements.get(frame)).toMatchObject({ x: 290, y: 390, name: 'Third' });
    expect(elements.get('a')).toMatchObject({ x: 300, y: 400 });
  });

  it("refuses a frame's width, a rectangle's name, a group's name and a frame without a name, and changes nothing", async () => {
    const { elements, client } = await helper();
    const { frame } = ok<{ frame: string }>(
      await call(client, 'add_shapes', {
        shapes: [{ id: 'a', type: 'rectangle', x: 0, y: 0, width: 100, height: 50 }],
        frame: { name: 'One' },
      }),
    );
    const { group } = ok<{ group: string }>(
      await call(client, 'add_shapes', { shapes: [{ id: 'b', type: 'rectangle', x: 300, y: 0, width: 100, height: 50 }], group: true }),
    );
    const before = JSON.stringify(elements.toJSON());
    const cases: [Element, string][] = [
      [{ id: frame, width: 10 }, `width doesn't apply to a frame, such as "${frame}": update_shape changes its x, y and name.`],
      [
        { id: 'a', name: 'Box' },
        `name doesn't apply to a rectangle, such as "a": update_shape changes its x, y, width, height, label, strokeColor and backgroundColor.`,
      ],
      [
        { group, name: 'Group' },
        `name doesn't apply to a group, such as "${group}": update_shape moves a group by x and y, and changes each of its shapes by that shape's id.`,
      ],
    ];
    for (const [args, refusal] of cases) {
      const result = await call(client, 'update_shape', args);
      expect(result.isError, JSON.stringify(args)).toBe(true);
      expect(text(result)).toBe(refusal);
    }
    const unnamed = await call(client, 'add_shapes', {
      shapes: [{ type: 'rectangle', x: 0, y: 300, width: 100, height: 50 }],
      frame: { name: '' },
    });
    expect(unnamed.isError).toBe(true);
    expect(JSON.stringify(elements.toJSON())).toBe(before);
  });

  it('says in its tools what a frame does, and takes frame in add_shapes and name in update_shape', async () => {
    const { client } = await helper();
    const { tools } = await client.listTools();
    const tool = (name: string) => tools.find((candidate) => candidate.name === name);
    expect(tool('add_shapes')?.description).toContain('frame');
    expect(tool('update_shape')?.description).toContain('frame');
    expect(tool('get_board')?.description).toContain('frames');
    expect(Object.keys(tool('add_shapes')?.inputSchema.properties ?? {})).toContain('frame');
    expect(Object.keys(tool('update_shape')?.inputSchema.properties ?? {})).toContain('name');
    const output = tool('get_board')?.outputSchema as unknown as { properties?: Record<string, unknown> } | undefined;
    expect(Object.keys(output?.properties ?? {})).toContain('frames');
  });
});
