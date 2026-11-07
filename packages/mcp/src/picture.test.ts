import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Awareness } from '@chalkline/sync';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { Resvg } from '@resvg/resvg-js';
import { afterEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { ELEMENTS } from './board';
import { creatorOf } from './creator';
import { decodePng, type Pixels } from './decode-png';
import { MAX_FILE_BYTES } from './picture';
import { FILES } from './render';
import { createServer } from './server';

type Element = Record<string, unknown>;

const clients: Client[] = [];
const awarenesses: Awareness[] = [];
const directories: string[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
  for (const awareness of awarenesses.splice(0)) awareness.destroy();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

/** An MCP client named chalkline-test, connected to chalkline-mcp's server on the board that `doc` holds, in a room without a page. */
async function connected(doc: Y.Doc): Promise<Client> {
  const awareness = new Awareness(doc);
  awareness.setLocalState(null);
  awarenesses.push(awareness);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await createServer(doc, awareness).connect(serverSide);
  const client = new Client({ name: 'chalkline-test', version: '0.0.0' });
  await client.connect(clientSide);
  clients.push(client);
  return client;
}

async function call(client: Client, name: string, args: Element = {}): Promise<CallToolResult> {
  return (await client.callTool({ name, arguments: args })) as CallToolResult;
}

/** The structured content of an answer that isn't a refusal. */
function answered<T>(result: CallToolResult): T {
  expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
  return result.structuredContent as T;
}

/** The text of a refusal. */
function refused(result: CallToolResult): string {
  expect(result.isError).toBe(true);
  return result.content.map((part) => (part.type === 'text' ? part.text : '')).join('');
}

function sha1(bytes: Buffer): string {
  return createHash('sha1').update(bytes).digest('hex');
}

/** A PNG of `width` by `height` pixels of one color, as resvg draws it. */
function png(width: number, height: number, fill: string): Buffer {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="${width}" height="${height}" fill="${fill}"/></svg>`;
  return new Resvg(svg).render().asPng();
}

/** A file in a new directory that the test's end removes. */
function file(name: string, bytes: Buffer | string): string {
  const directory = mkdtempSync(join(tmpdir(), 'chalkline-picture-'));
  directories.push(directory);
  const path = join(directory, name);
  writeFileSync(path, bytes);
  return path;
}

/** The board's elements that aren't deleted, by id. */
function live(doc: Y.Doc): Map<string, Element> {
  const elements = new Map<string, Element>();
  for (const [id, value] of doc.getMap<Element>(ELEMENTS).entries()) {
    if (value.isDeleted !== true) elements.set(id, value);
  }
  return elements;
}

/** The pixels of the PNG that the board's file `id` holds as its data URL. */
function filePixels(doc: Y.Doc, id: string): Pixels {
  const stored = doc.getMap<{ dataURL: string }>(FILES).get(id);
  expect(stored?.dataURL.startsWith('data:image/png;base64,')).toBe(true);
  return decodePng(Buffer.from((stored?.dataURL ?? '').slice('data:image/png;base64,'.length), 'base64'));
}

/** The red, green, blue and alpha of the pixel (x, y). */
function pixel(pixels: Pixels, x: number, y: number): number[] {
  const at = (y * pixels.width + x) * 4;
  return [...pixels.data.subarray(at, at + 4)];
}

const opaqueRed = (rgba: number[]) => rgba[0] > 200 && rgba[1] < 60 && rgba[2] < 60 && rgba[3] === 255;

describe('add_image', () => {
  it('places a PNG from a data URL, with the height that keeps its proportions, and shares its picture in the files map', async () => {
    const doc = new Y.Doc();
    const client = await connected(doc);
    const picture = png(40, 20, '#ff0000');
    const dataUrl = `data:image/png;base64,${picture.toString('base64')}`;

    const added = answered<{ id: string; file: string; width: number; height: number }>(
      await call(client, 'add_image', { data_url: dataUrl, x: 10, y: 20, width: 80 }),
    );

    expect(added).toEqual({ id: expect.any(String), file: sha1(picture), width: 80, height: 40 });
    const element = doc.getMap<Element>(ELEMENTS).get(added.id);
    expect(element).toMatchObject({
      type: 'image',
      x: 10,
      y: 20,
      width: 80,
      height: 40,
      fileId: sha1(picture),
      status: 'saved',
      scale: [1, 1],
      isDeleted: false,
      groupIds: [],
    });
    expect(typeof element?.index).toBe('string');
    expect(creatorOf(element)).toMatchObject({ kind: 'agent', name: 'chalkline-test' });
    expect(doc.getMap<Element>(FILES).get(added.file)).toMatchObject({
      id: sha1(picture),
      mimeType: 'image/png',
      dataURL: dataUrl,
      created: expect.any(Number),
    });
    const board = answered<{ shapes: { id: string; kind: string }[] }>(await call(client, 'get_board'));
    expect(board.shapes).toEqual([expect.objectContaining({ id: added.id, kind: 'image', x: 10, y: 20, width: 80, height: 40 })]);
  });

  it('places an SVG from a path, its proportions read from its viewBox, behind the shapes with place back', async () => {
    const doc = new Y.Doc();
    const client = await connected(doc);
    const shapes = answered<{ ids: string[] }>(
      await call(client, 'add_shapes', { shapes: [{ type: 'rectangle', x: 0, y: 0, width: 50, height: 50 }] }),
    );
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 30 60"><rect width="30" height="60" fill="red"/></svg>';
    const path = file('tall.svg', svg);

    const added = answered<{ id: string; file: string; width: number; height: number }>(
      await call(client, 'add_image', { path, x: 5, y: 5, width: 15, place: 'back' }),
    );

    expect(added.height).toBe(30);
    expect(doc.getMap<Element>(ELEMENTS).get(added.id)).toMatchObject({ type: 'image', width: 15, height: 30, fileId: added.file });
    expect(doc.getMap<Element>(FILES).get(added.file)).toMatchObject({
      mimeType: 'image/svg+xml',
      dataURL: `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`,
    });
    const board = answered<{ shapes: { id: string }[] }>(await call(client, 'get_board'));
    expect(board.shapes.map((shape) => shape.id)).toEqual([added.id, ...shapes.ids]);
  });

  it('reads a JPEG and its size from its start-of-frame segment', async () => {
    const doc = new Y.Doc();
    const client = await connected(doc);
    // A JPEG's markers up to its frame header, which add_image reads its kind and size from:
    // SOI, an APP0 segment of 16 bytes, then SOF0 with a height of 30 and a width of 90.
    const jpeg = Buffer.from([
      0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00,
      0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x1e, 0x00, 0x5a, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11,
      0x01, 0xff, 0xd9,
    ]);

    const added = answered<{ file: string; height: number }>(
      await call(client, 'add_image', { data_url: `data:image/jpeg;base64,${jpeg.toString('base64')}`, x: 0, y: 0, width: 60 }),
    );

    expect(added.height).toBe(20);
    expect(doc.getMap<Element>(FILES).get(added.file)).toMatchObject({ mimeType: 'image/jpeg' });
  });

  it('refuses a call without a picture or with two, a URL that is not a data URL, bytes that are not a picture, a picture over 4 MiB, and an SVG without a size and without height, and adds nothing', async () => {
    const doc = new Y.Doc();
    const client = await connected(doc);
    const at = { x: 0, y: 0, width: 10 };
    const red = `data:image/png;base64,${png(2, 2, 'red').toString('base64')}`;
    const unsized = 'data:image/svg+xml;base64,' + Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><rect width="5" height="5"/></svg>').toString('base64');
    const large = Buffer.alloc(MAX_FILE_BYTES + 1);
    png(2, 2, 'red').copy(large);

    expect(refused(await call(client, 'add_image', at))).toContain('give path');
    expect(refused(await call(client, 'add_image', { ...at, data_url: red, path: '/tmp/picture.png' }))).toContain('both path and data_url');
    expect(refused(await call(client, 'add_image', { ...at, data_url: 'https://example.com/picture.png' }))).toContain('data URL');
    expect(refused(await call(client, 'add_image', { ...at, data_url: 'data:text/plain,hello' }))).toContain("isn't a PNG, a JPEG or an SVG");
    expect(refused(await call(client, 'add_image', { ...at, path: file('large.png', large) }))).toContain('4 MiB');
    expect(
      refused(await call(client, 'add_image', { ...at, data_url: `data:image/png;base64,${large.toString('base64')}` })),
    ).toContain('4 MiB');
    expect(refused(await call(client, 'add_image', { ...at, data_url: unsized }))).toContain('give height');
    expect(refused(await call(client, 'add_image', { ...at, path: join(tmpdir(), 'chalkline-no-such-picture.png') }))).toContain(
      "couldn't read the file",
    );
    expect(doc.getMap(ELEMENTS).size).toBe(0);
    expect(doc.getMap(FILES).size).toBe(0);

    const sized = answered<{ height: number }>(await call(client, 'add_image', { ...at, data_url: unsized, height: 7 }));
    expect(sized.height).toBe(7);
  });

  it('keeps one file for two images of the same picture', async () => {
    const doc = new Y.Doc();
    const client = await connected(doc);
    const dataUrl = `data:image/png;base64,${png(4, 4, 'blue').toString('base64')}`;

    const first = answered<{ id: string; file: string }>(await call(client, 'add_image', { data_url: dataUrl, x: 0, y: 0, width: 4 }));
    const second = answered<{ id: string; file: string }>(await call(client, 'add_image', { data_url: dataUrl, x: 10, y: 0, width: 4 }));

    expect(second.file).toBe(first.file);
    expect(second.id).not.toBe(first.id);
    expect(doc.getMap(FILES).size).toBe(1);
    expect(live(doc).size).toBe(2);
  });
});

describe('flatten', () => {
  const solid = { strokeColor: '#ff0000', backgroundColor: '#ff0000', fillStyle: 'solid', roughness: 0 };

  it('turns a group into one image where the group was, deletes its shapes and their labels in one change, and draws them alone on a transparent picture', async () => {
    const doc = new Y.Doc();
    const client = await connected(doc);
    const under = answered<{ ids: string[] }>(
      await call(client, 'add_shapes', {
        shapes: [{ type: 'rectangle', x: -20, y: -20, width: 140, height: 80, strokeColor: '#0000ff', backgroundColor: '#0000ff', fillStyle: 'solid' }],
      }),
    ).ids[0];
    const group = answered<{ ids: string[]; group: string }>(
      await call(client, 'add_shapes', {
        group: true,
        shapes: [
          { type: 'rectangle', x: 0, y: 0, width: 40, height: 40, ...solid },
          { type: 'rectangle', x: 60, y: 0, width: 40, height: 40, ...solid, label: { text: 'B' } },
        ],
      }),
    );
    const top = answered<{ ids: string[] }>(
      await call(client, 'add_shapes', { shapes: [{ type: 'ellipse', x: 300, y: 300, width: 20, height: 20 }] }),
    ).ids[0];
    const before = [...live(doc).keys()];
    expect(before).toHaveLength(5);
    let updates = 0;
    doc.on('update', () => updates++);

    const flat = answered<{ id: string; file: string; ids: string[]; region: unknown; width: number; height: number }>(
      await call(client, 'flatten', { groups: [group.group] }),
    );

    expect(updates).toBe(1);
    expect(flat).toEqual({
      id: expect.any(String),
      file: expect.any(String),
      ids: group.ids,
      region: { x: -10, y: -10, width: 120, height: 60 },
      width: 240,
      height: 120,
    });
    const elements = live(doc);
    expect([...elements.keys()].sort()).toEqual([under, flat.id, top].sort());
    expect(elements.get(flat.id)).toMatchObject({
      type: 'image',
      x: -10,
      y: -10,
      width: 120,
      height: 60,
      fileId: flat.file,
      status: 'saved',
      groupIds: [group.group],
    });
    expect(creatorOf(elements.get(flat.id))).toMatchObject({ kind: 'agent', name: 'chalkline-test' });
    for (const id of before.filter((id) => ![under, top].includes(id))) {
      expect(doc.getMap<Element>(ELEMENTS).get(id)?.isDeleted).toBe(true);
    }
    const board = answered<{ shapes: { id: string }[] }>(await call(client, 'get_board'));
    expect(board.shapes.map((shape) => shape.id)).toEqual([under, flat.id, top]);

    const stored = doc.getMap<Element>(FILES).get(flat.file);
    expect(stored).toMatchObject({ id: flat.file, mimeType: 'image/png' });
    const pixels = filePixels(doc, flat.file);
    expect([pixels.width, pixels.height]).toEqual([240, 120]);
    // The board's point (x, y) is the picture's pixel ((x + 10) * 2, (y + 10) * 2).
    expect(opaqueRed(pixel(pixels, 60, 60)), 'the first rectangle').toBe(true);
    expect(pixel(pixels, 120, 60)[3], 'the gap between the rectangles, where the blue rectangle behind them is left out').toBe(0);
    expect(pixel(pixels, 2, 2)[3], 'the margin').toBe(0);
    expect(sha1(Buffer.from(String(stored?.dataURL).slice('data:image/png;base64,'.length), 'base64'))).toBe(flat.file);
  });

  it('turns the shapes that lie wholly inside a region into an image of that region, and keeps the shape that crosses its edge', async () => {
    const doc = new Y.Doc();
    const client = await connected(doc);
    const [first, second, crossing] = answered<{ ids: string[] }>(
      await call(client, 'add_shapes', {
        shapes: [
          { type: 'rectangle', x: 0, y: 0, width: 20, height: 20, ...solid },
          { type: 'freedraw', x: 30, y: 0, points: [[0, 0], [10, 10], [20, 0]], strokeColor: '#ff0000' },
          { type: 'rectangle', x: 40, y: 0, width: 40, height: 20, ...solid },
        ],
      }),
    ).ids;
    const region = { x: -5, y: -5, width: 60, height: 30 };

    const flat = answered<{ id: string; file: string; ids: string[]; region: unknown; width: number; height: number }>(
      await call(client, 'flatten', { region, scale: 1 }),
    );

    expect(flat).toMatchObject({ ids: [first, second], region, width: 60, height: 30 });
    expect([...live(doc).keys()].sort()).toEqual([flat.id, crossing].sort());
    expect(live(doc).get(flat.id)).toMatchObject({ type: 'image', ...region, groupIds: [] });
    const pixels = filePixels(doc, flat.file);
    expect(opaqueRed(pixel(pixels, 15, 15)), 'the rectangle inside').toBe(true);
    expect(pixel(pixels, 54, 2)[3], 'the rectangle that crosses the edge, which stays a shape').toBe(0);
  });

  it('refuses a call without shapes, with both shapes and a region, of a region without a whole shape, and of a shape the board lacks, and changes nothing', async () => {
    const doc = new Y.Doc();
    const client = await connected(doc);
    const [id] = answered<{ ids: string[] }>(
      await call(client, 'add_shapes', { shapes: [{ type: 'rectangle', x: 0, y: 0, width: 20, height: 20 }] }),
    ).ids;
    let updates = 0;
    doc.on('update', () => updates++);

    expect(refused(await call(client, 'flatten', {}))).toContain('give ids, groups or both, or give region');
    expect(refused(await call(client, 'flatten', { ids: [id], region: { x: 0, y: 0, width: 50, height: 50 } }))).toContain('not both');
    expect(refused(await call(client, 'flatten', { region: { x: 10, y: 10, width: 50, height: 50 } }))).toContain('No shape lies wholly inside');
    expect(refused(await call(client, 'flatten', { ids: [id, 'missing'] }))).toContain('get_board lists');
    expect(updates).toBe(0);
    expect([...live(doc).keys()]).toEqual([id]);
    expect(doc.getMap(FILES).size).toBe(0);
  });
});
