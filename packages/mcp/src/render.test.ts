import { inflateSync } from 'node:zlib';
import { Awareness } from '@chalkline/sync';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { Resvg } from '@resvg/resvg-js';
import { afterEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { ELEMENTS } from './board';
import { FILES, renderBoard, type Region } from './render';
import { createServer } from './server';

type Element = Record<string, unknown>;

/** A picture's pixels: 4 bytes each, red, green, blue and alpha, row by row from the top. */
interface Pixels {
  width: number;
  height: number;
  data: Uint8Array;
}

/** Whether a pixel's red, green and blue are of a color. */
type Color = (red: number, green: number, blue: number) => boolean;

const white: Color = (r, g, b) => r > 245 && g > 245 && b > 245;
const dark: Color = (r, g, b) => r < 100 && g < 100 && b < 100;
const red: Color = (r, g, b) => r > 200 && g < 60 && b < 60;
const blue: Color = (r, g, b) => b > 200 && r < 60 && g < 60;

const clients: Client[] = [];
const awarenesses: Awareness[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
  for (const awareness of awarenesses.splice(0)) awareness.destroy();
});

/** An MCP client connected to chalkline-mcp's server on the board that `doc` holds, in a room without a page. */
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

function text(result: CallToolResult): string {
  return result.content.map((part) => (part.type === 'text' ? part.text : '')).join('');
}

/** The picture of a render_board answer, decoded, and the answer's structured content, which its text repeats. */
function picture(result: CallToolResult): { pixels: Pixels; answer: unknown } {
  expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
  const [image, json] = result.content;
  expect(image).toMatchObject({ type: 'image', mimeType: 'image/png' });
  expect(json.type).toBe('text');
  expect(JSON.parse(json.type === 'text' ? json.text : '')).toEqual(result.structuredContent);
  const png = Buffer.from(image.type === 'image' ? image.data : '', 'base64');
  return { pixels: decodePng(png), answer: result.structuredContent };
}

/** Decodes a PNG of 8 bits a channel, RGB or RGBA and not interlaced, as resvg writes it. */
function decodePng(png: Buffer): Pixels {
  expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  let width = 0;
  let height = 0;
  let channels = 0;
  const data: Buffer[] = [];
  for (let at = 8; at < png.length; ) {
    const length = png.readUInt32BE(at);
    const type = png.toString('latin1', at + 4, at + 8);
    const body = png.subarray(at + 8, at + 8 + length);
    if (type === 'IHDR') {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      expect({ depth: body[8], color: body[9], interlace: body[12] }).toMatchObject({ depth: 8, interlace: 0 });
      channels = body[9] === 6 ? 4 : 3;
      expect([2, 6]).toContain(body[9]);
    } else if (type === 'IDAT') {
      data.push(body);
    }
    at += 12 + length;
  }

  const raw = inflateSync(Buffer.concat(data));
  const stride = width * channels;
  const rows = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const left = x >= channels ? rows[y * stride + x - channels] : 0;
      const up = y > 0 ? rows[(y - 1) * stride + x] : 0;
      const corner = x >= channels && y > 0 ? rows[(y - 1) * stride + x - channels] : 0;
      rows[y * stride + x] = (line[x] + predicted(filter, left, up, corner)) & 0xff;
    }
  }

  const pixels = new Uint8Array(width * height * 4);
  for (let pixel = 0; pixel < width * height; pixel++) {
    for (let channel = 0; channel < 4; channel++) {
      pixels[pixel * 4 + channel] = channel < channels ? rows[pixel * channels + channel] : 255;
    }
  }
  return { width, height, data: pixels };
}

/** The byte that a PNG row's filter predicts from the bytes to its left, above it, and above and left of it. */
function predicted(filter: number, left: number, up: number, corner: number): number {
  switch (filter) {
    case 0:
      return 0;
    case 1:
      return left;
    case 2:
      return up;
    case 3:
      return (left + up) >> 1;
    case 4: {
      const estimate = left + up - corner;
      const fromLeft = Math.abs(estimate - left);
      const fromUp = Math.abs(estimate - up);
      const fromCorner = Math.abs(estimate - corner);
      if (fromLeft <= fromUp && fromLeft <= fromCorner) return left;
      return fromUp <= fromCorner ? up : corner;
    }
    default:
      throw new Error(`A PNG row has the filter ${filter}, which PNG doesn't define.`);
  }
}

/** Each color the picture holds, as its red, green, blue and alpha joined by commas. */
function colors(pixels: Pixels): Set<string> {
  const seen = new Set<string>();
  for (let at = 0; at < pixels.data.length; at += 4) seen.add(pixels.data.subarray(at, at + 4).join(','));
  return seen;
}

function every(pixels: Pixels, color: Color): boolean {
  for (let at = 0; at < pixels.data.length; at += 4) {
    if (!color(pixels.data[at], pixels.data[at + 1], pixels.data[at + 2])) return false;
  }
  return true;
}

function some(pixels: Pixels, color: Color): boolean {
  return !every(pixels, (r, g, b) => !color(r, g, b));
}

function at(pixels: Pixels, x: number, y: number): [number, number, number] {
  const start = (y * pixels.width + x) * 4;
  return [pixels.data[start], pixels.data[start + 1], pixels.data[start + 2]];
}

/** A rectangle as the page keeps it, with straight edges and a solid fill. */
function rectangle(fields: Element): Element {
  return {
    type: 'rectangle',
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    angle: 0,
    strokeColor: '#1e1e1e',
    backgroundColor: 'transparent',
    fillStyle: 'solid',
    strokeWidth: 2,
    strokeStyle: 'solid',
    roughness: 0,
    opacity: 100,
    roundness: null,
    seed: 1,
    version: 1,
    versionNonce: 1,
    isDeleted: false,
    groupIds: [],
    frameId: null,
    boundElements: null,
    link: null,
    locked: false,
    ...fields,
  };
}

/** A board that holds `elements`, in that order. */
function board(elements: Element[]): Y.Doc {
  const doc = new Y.Doc();
  const shared = doc.getMap<Element>(ELEMENTS);
  doc.transact(() => {
    for (const element of elements) shared.set(String(element.id), element);
  });
  return doc;
}

async function drawn(doc: Y.Doc, region: Region, maxWidth = region.width, maxHeight = region.height): Promise<Pixels> {
  return decodePng((await renderBoard(doc, { region, maxWidth, maxHeight })).png);
}

const LABELLED = { shapes: [{ type: 'rectangle', x: 0, y: 0, width: 240, height: 80, label: { text: 'Hello' } }] };

describe('render_board', () => {
  it('draws a board that holds one labelled rectangle as a PNG of the asked size', async () => {
    const client = await connected(new Y.Doc());
    const added = await call(client, 'add_shapes', LABELLED);
    expect(added.isError, JSON.stringify(added.content)).not.toBe(true);

    const region = { x: -20, y: -20, width: 280, height: 120 };
    const { pixels, answer } = picture(await call(client, 'render_board', { region, max_width: 560, max_height: 240 }));
    expect(answer).toEqual({ region, width: 560, height: 240 });
    expect([pixels.width, pixels.height]).toEqual([560, 240]);
    expect(colors(pixels).size).toBeGreaterThan(1);
    // The region's corner lies outside the rectangle, and its outline and label are dark.
    expect(white(...at(pixels, 0, 0))).toBe(true);
    expect(some(pixels, dark)).toBe(true);
  });

  it('draws the whole board, with a margin of 10 around its shapes, where region is left out', async () => {
    const client = await connected(new Y.Doc());
    const added = await call(client, 'add_shapes', LABELLED);
    expect(added.isError, JSON.stringify(added.content)).not.toBe(true);

    const { pixels, answer } = picture(await call(client, 'render_board'));
    expect(answer).toEqual({ region: { x: -10, y: -10, width: 260, height: 100 }, width: 1024, height: 394 });
    expect([pixels.width, pixels.height]).toEqual([1024, 394]);
    expect(some(pixels, dark)).toBe(true);
  });

  it("refuses a call without region on a board that doesn't hold a shape, and draws a region of it in white", async () => {
    const client = await connected(new Y.Doc());
    const refused = await call(client, 'render_board');
    expect(refused.isError).toBe(true);
    expect(text(refused)).toBe(
      "The board doesn't hold a shape, so it has no bounds to draw: set region to draw a part of the board.",
    );

    const region = { x: 0, y: 0, width: 50, height: 20 };
    const { pixels, answer } = picture(await call(client, 'render_board', { region, max_width: 100, max_height: 100 }));
    expect(answer).toEqual({ region, width: 100, height: 40 });
    expect([...colors(pixels)]).toEqual(['255,255,255,255']);
  });
});

describe('renderBoard', () => {
  it('draws each shape where the board holds it, wherever its top left shape is', async () => {
    const doc = board([
      rectangle({ id: 'far', x: -500, y: -300, index: 'a0' }),
      rectangle({ id: 'red', x: 100, y: 100, width: 200, height: 100, strokeColor: '#ff0000', backgroundColor: '#ff0000', index: 'a1' }),
    ]);
    expect(every(await drawn(doc, { x: 150, y: 125, width: 100, height: 50 }), red)).toBe(true);
    expect(every(await drawn(doc, { x: 400, y: 400, width: 100, height: 50 }), white)).toBe(true);
  });

  it('draws the shapes back to front by their index, whatever order the board holds them in', async () => {
    const doc = board([
      rectangle({ id: 'blue', strokeColor: '#0000ff', backgroundColor: '#0000ff', index: 'a2' }),
      rectangle({ id: 'red', strokeColor: '#ff0000', backgroundColor: '#ff0000', index: 'a1' }),
    ]);
    expect(every(await drawn(doc, { x: 25, y: 25, width: 50, height: 50 }), blue)).toBe(true);
  });

  it('leaves a deleted shape out', async () => {
    const doc = board([
      rectangle({ id: 'gone', strokeColor: '#ff0000', backgroundColor: '#ff0000', index: 'a1', isDeleted: true }),
      rectangle({ id: 'kept', x: 300, y: 300, index: 'a2' }),
    ]);
    expect(every(await drawn(doc, { x: 25, y: 25, width: 50, height: 50 }), white)).toBe(true);
  });

  it("draws an image from the board's files once the board holds its file", async () => {
    const doc = board([
      rectangle({
        id: 'picture',
        type: 'image',
        width: 40,
        height: 40,
        strokeColor: 'transparent',
        fileId: 'green',
        status: 'saved',
        scale: [1, 1],
        crop: null,
        index: 'a1',
      }),
    ]);
    const region = { x: 10, y: 10, width: 20, height: 20 };
    expect([...colors(await drawn(doc, region))]).toEqual(['255,255,255,255']);

    const png = new Resvg(
      '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"><rect width="4" height="4" fill="#00ff00"/></svg>',
    )
      .render()
      .asPng();
    doc.getMap<unknown>(FILES).set('green', {
      id: 'green',
      mimeType: 'image/png',
      dataURL: `data:image/png;base64,${png.toString('base64')}`,
      created: 1,
    });
    expect([...colors(await drawn(doc, region))]).toEqual(['0,255,0,255']);
  });

  it('draws a picture at least one pixel wide and high', async () => {
    const thin = await renderBoard(new Y.Doc(), { region: { x: 0, y: 0, width: 1, height: 1000 }, maxWidth: 100, maxHeight: 100 });
    expect([thin.width, thin.height]).toEqual([1, 100]);
    const pixels = decodePng(thin.png);
    expect([pixels.width, pixels.height]).toEqual([1, 100]);
  });
});
