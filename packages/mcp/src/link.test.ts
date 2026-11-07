// Tests of a shape's link, the URL that the page opens from a link icon on the shape: add_shapes
// sets it, update_shape sets, changes and removes it, get_board answers it, and both tools refuse a
// link that isn't an http or https URL.
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

/** The commit the permalinks of these tests show their lines at. */
const COMMIT = 'c7bdebe666c91bda96abdb2911f1163a098108dd';

/** A permalink to the lines `lines` of `path` in chalkline at COMMIT, as a shape that stands for code links to it. */
function permalink(path: string, lines: string): string {
  return `https://github.com/camshaft/chalkline/blob/${COMMIT}/${path}#${lines}`;
}

const SERVER = permalink('packages/mcp/src/server.ts', 'L60-L80');
const BOARD = permalink('packages/mcp/src/board.ts', 'L66-L113');
const EDIT = permalink('packages/mcp/src/edit.ts', 'L157-L190');

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

/** An element as a person's page draws it, with the fields Excalidraw sets on each, and without a link. */
function drawn(fields: Element): Element {
  return { x: 0, y: 0, width: 100, height: 50, angle: 0, isDeleted: false, version: 1, versionNonce: 1, link: null, ...fields };
}

/**
 * A board of a rectangle with its label, a text, an arrow, a line, a freehand stroke, an image, a
 * frame and an ellipse in the group "set", none of them with a link.
 */
function board(): Element[] {
  return [
    drawn({ id: 'box', type: 'rectangle', index: 'a0', boundElements: [{ id: 'box-label', type: 'text' }] }),
    drawn({ id: 'box-label', type: 'text', index: 'a1', containerId: 'box', text: 'Server', originalText: 'Server' }),
    drawn({ id: 'note', type: 'text', index: 'a2', text: 'Note', originalText: 'Note', fontSize: 20 }),
    drawn({
      id: 'pointer',
      type: 'arrow',
      index: 'a3',
      width: 100,
      height: 0,
      points: [
        [0, 0],
        [100, 0],
      ],
      startBinding: null,
      endBinding: null,
    }),
    drawn({
      id: 'rule',
      type: 'line',
      index: 'a4',
      width: 100,
      height: 0,
      points: [
        [0, 0],
        [100, 0],
      ],
    }),
    drawn({
      id: 'scribble',
      type: 'freedraw',
      index: 'a5',
      points: [
        [0, 0],
        [10, 10],
      ],
    }),
    drawn({ id: 'picture', type: 'image', index: 'a6', fileId: 'file' }),
    drawn({ id: 'area', type: 'frame', index: 'a7', name: 'Area' }),
    drawn({ id: 'grouped', type: 'ellipse', index: 'a8', x: 300, groupIds: ['set'] }),
  ];
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

/** The shapes get_board lists, from back to front. */
async function listed(client: Client): Promise<BoardShape[]> {
  return ok<{ shapes: BoardShape[] }>(await call(client, 'get_board')).shapes;
}

/** The shape get_board lists with the id `id`. */
async function shapeOf(client: Client, id: string): Promise<BoardShape | undefined> {
  return (await listed(client)).find((shape) => shape.id === id);
}

/** The label of the shape `id`: the text bound to it. */
function labelOf(elements: Y.Map<Element>, id: string): Element | undefined {
  return [...elements.values()].find((element) => element.containerId === id && element.isDeleted !== true);
}

/** Each element of the board as it stands, as text that changes where any element changes. */
function snapshot(elements: Y.Map<Element>): string {
  return JSON.stringify([...elements.entries()].sort(([a], [b]) => (a < b ? -1 : 1)));
}

describe('links in add_shapes', () => {
  it("holds the link each shape sets as its element's link, which its label doesn't hold, and get_board answers it", async () => {
    const { elements, client } = await helper([]);
    const shapes: Element[] = [
      { type: 'rectangle', id: 'server', x: 0, y: 0, width: 200, height: 80, label: { text: 'MCP server' }, link: SERVER },
      { type: 'ellipse', id: 'reader', x: 300, y: 0, width: 160, height: 80, link: BOARD },
      { type: 'diamond', id: 'choice', x: 600, y: 0, width: 100, height: 100, link: EDIT },
      { type: 'text', id: 'note', x: 0, y: 150, text: 'Reads the board', link: permalink('packages/mcp/src/board.ts', 'L73-L112') },
      { type: 'arrow', id: 'reads', x: 200, y: 40, width: 100, height: 0, label: { text: 'reads' }, link: permalink('packages/mcp/src/server.ts', 'L64-L80') },
      { type: 'line', id: 'divider', x: 0, y: 250, width: 700, height: 0, link: 'http://example.com/notes' },
      {
        type: 'freedraw',
        id: 'mark',
        x: 0,
        y: 300,
        points: [
          [0, 0],
          [10, 5],
          [20, 0],
        ],
        link: permalink('packages/mcp/src/shapes.ts', 'L172-L186'),
      },
      { type: 'rectangle', id: 'plain', x: 0, y: 400 },
    ];
    const { ids } = ok<{ ids: string[] }>(await call(client, 'add_shapes', { shapes }));
    expect(ids).toEqual(shapes.map((shape) => shape.id));
    for (const shape of shapes) {
      expect(elements.get(String(shape.id))?.link ?? null, String(shape.id)).toBe(shape.link ?? null);
    }
    for (const id of ['server', 'reads']) {
      const label = labelOf(elements, id);
      expect(label, `the label of ${id}`).toBeDefined();
      expect(label?.link ?? null, `the link of the label of ${id}`).toBeNull();
    }

    const answered = await listed(client);
    for (const shape of shapes) {
      const listedShape = answered.find((candidate) => candidate.id === shape.id);
      expect(listedShape, String(shape.id)).toBeDefined();
      expect(listedShape?.link, String(shape.id)).toBe(shape.link);
    }
    expect(answered.find((shape) => shape.id === 'plain')).not.toHaveProperty('link');
    expect(answered.find((shape) => shape.id === 'server')?.label).toBe('MCP server');
  });
});

describe('links in update_shape', () => {
  it("sets, changes and removes a rectangle's link, and leaves its label as it is", async () => {
    const { elements, client } = await helper(board());
    const label = JSON.stringify(elements.get('box-label'));

    const set = ok<{ shape: BoardShape }>(await call(client, 'update_shape', { id: 'box', link: SERVER }));
    expect(set.shape).toMatchObject({ id: 'box', link: SERVER, label: 'Server', x: 0, y: 0, width: 100, height: 50 });
    expect(elements.get('box')?.link).toBe(SERVER);
    expect(elements.get('box')?.version).toBe(2);
    expect(JSON.stringify(elements.get('box-label'))).toBe(label);
    expect((await shapeOf(client, 'box'))?.link).toBe(SERVER);

    const changed = ok<{ shape: BoardShape }>(await call(client, 'update_shape', { id: 'box', link: BOARD }));
    expect(changed.shape.link).toBe(BOARD);
    expect(elements.get('box')?.link).toBe(BOARD);
    expect(elements.get('box')?.version).toBe(3);

    const removed = ok<{ shape: BoardShape }>(await call(client, 'update_shape', { id: 'box', link: '' }));
    expect(removed.shape).not.toHaveProperty('link');
    expect(elements.get('box')?.link).toBeNull();
    expect(await shapeOf(client, 'box')).not.toHaveProperty('link');
    expect(JSON.stringify(elements.get('box-label'))).toBe(label);
  });

  it('sets the link of a text, an arrow, a line and a frame beside the other fields the call changes', async () => {
    const { elements, client } = await helper(board());
    const note = ok<{ shape: BoardShape }>(await call(client, 'update_shape', { id: 'note', strokeColor: '#1971c2', link: BOARD }));
    expect(note.shape).toMatchObject({ link: BOARD, strokeColor: '#1971c2', label: 'Note' });
    const pointer = ok<{ shape: BoardShape }>(await call(client, 'update_shape', { id: 'pointer', x: 40, link: SERVER }));
    expect(pointer.shape).toMatchObject({ link: SERVER, x: 40 });
    const rule = ok<{ shape: BoardShape }>(await call(client, 'update_shape', { id: 'rule', link: EDIT }));
    expect(rule.shape.link).toBe(EDIT);
    expect(elements.get('note')?.link).toBe(BOARD);
    expect(elements.get('pointer')?.link).toBe(SERVER);
    expect(elements.get('rule')?.link).toBe(EDIT);
    const area = ok<{ shape: BoardShape }>(await call(client, 'update_shape', { id: 'area', name: 'Renamed', link: SERVER }));
    expect(area.shape).toMatchObject({ kind: 'frame', label: 'Renamed', link: SERVER });
    expect(elements.get('area')).toMatchObject({ name: 'Renamed', link: SERVER });
  });

  it.each(['scribble', 'picture', 'area'])('sets and removes the link of %s, and changes nothing else of it', async (id) => {
    const { elements, client } = await helper(board());
    const before: Element = elements.get(id) ?? {};

    const set = ok<{ shape: BoardShape }>(await call(client, 'update_shape', { id, link: SERVER }));
    expect(set.shape).toMatchObject({ id, link: SERVER });
    const after: Element = elements.get(id) ?? {};
    expect(after.link).toBe(SERVER);
    expect(after.version).toBe(2);
    for (const [field, value] of Object.entries(before)) {
      if (!['link', 'version', 'versionNonce'].includes(field)) expect(after[field], field).toEqual(value);
    }
    expect((await shapeOf(client, id))?.link).toBe(SERVER);

    const removed = ok<{ shape: BoardShape }>(await call(client, 'update_shape', { id, link: '' }));
    expect(removed.shape).not.toHaveProperty('link');
    expect(elements.get(id)?.link).toBeNull();
  });

  it.each<[string, string, Element]>([
    ['scribble', 'a freedraw', { id: 'scribble', x: 10, link: SERVER }],
    ['picture', 'an image', { id: 'picture', strokeColor: '#e03131' }],
    ['picture', 'an image', { id: 'picture' }],
  ])('refuses each field but link of %s, and changes nothing', async (id, kind, args) => {
    const { elements, client } = await helper(board());
    const before = snapshot(elements);
    const result = await call(client, 'update_shape', args);
    expect(result.isError).toBe(true);
    expect(text(result)).toBe(
      `"${id}" is ${kind}, of which update_shape changes only the link: it changes rectangles, ellipses, diamonds, texts, arrows, lines and frames, and the link of any shape.`,
    );
    expect(snapshot(elements)).toBe(before);
  });

  it('refuses a link beside group, and moves nothing', async () => {
    const { elements, client } = await helper(board());
    const before = snapshot(elements);
    const result = await call(client, 'update_shape', { group: 'set', x: 10, link: SERVER });
    expect(result.isError).toBe(true);
    expect(text(result)).toBe(
      `link doesn't apply to a group, such as "set": update_shape moves a group by x and y, and changes each of its shapes by that shape's id.`,
    );
    expect(snapshot(elements)).toBe(before);
  });
});

/** Links that aren't http or https URLs, each of which both tools refuse. */
const REFUSED = [
  'javascript:alert(1)',
  'data:text/html,<p>hi</p>',
  'ftp://example.com/server.ts',
  'file:///tmp/server.ts',
  'mailto:board@example.com',
  'packages/mcp/src/server.ts',
  'https://',
];

describe('link refusals', () => {
  it.each([...REFUSED, ''])('add_shapes refuses the link %j, names the field, and adds nothing', async (link) => {
    const { elements, client } = await helper([]);
    const result = await call(client, 'add_shapes', { shapes: [{ type: 'rectangle', x: 0, y: 0, link }] });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain(' at shapes[0].link');
    expect(text(result)).toContain('A link is an http or https URL');
    expect(elements.size).toBe(0);
  });

  it.each(REFUSED)('update_shape refuses the link %j, names the field, and changes nothing', async (link) => {
    const { elements, client } = await helper(board());
    const before = snapshot(elements);
    const result = await call(client, 'update_shape', { id: 'box', link });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain(' at link');
    expect(snapshot(elements)).toBe(before);
  });
});

describe('link descriptions', () => {
  it("says in add_shapes's and update_shape's descriptions to link a shape that stands for code to a permalink, and lists link in the tools' schemas", async () => {
    const { client } = await helper([]);
    const { tools } = await client.listTools();
    const tool = (name: string) => tools.find((candidate) => candidate.name === name);
    for (const name of ['add_shapes', 'update_shape']) {
      const description = tool(name)?.description ?? '';
      for (const words of ['link', 'http or https', 'permalink', 'commit', 'line range']) expect(description, name).toContain(words);
    }
    expect(tool('get_board')?.description).toContain('its link');
    expect(JSON.stringify(tool('add_shapes')?.inputSchema)).toContain('"link"');
    expect(Object.keys(tool('update_shape')?.inputSchema.properties ?? {})).toContain('link');
    const answer = tool('get_board')?.outputSchema as unknown as {
      properties: { shapes: { items: { properties: Record<string, unknown> } } };
    };
    expect(Object.keys(answer.properties.shapes.items.properties)).toContain('link');
  });
});
