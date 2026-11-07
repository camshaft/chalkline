import { getEventListeners } from 'node:events';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inflateSync } from 'node:zlib';
import { Awareness } from '@chalkline/sync';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { Resvg } from '@resvg/resvg-js';
import { generateNKeysBetween } from 'fractional-indexing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { ELEMENTS } from './board';
import { FILES, rasterize, renderBoard, RenderError, type Picture, type Region } from './render';
import { createServer } from './server';

// render_board's handler calls renderBoard through this mock, which runs the real renderBoard, so
// that a test can read the render that a call starts.
vi.mock('./render', async (importOriginal) => {
  const render = await importOriginal<typeof import('./render')>();
  return { ...render, renderBoard: vi.fn(render.renderBoard) };
});

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

/** A freehand stroke as the page draws one: its points from its x and y, with the pen's pressure that Excalidraw simulates. */
function stroke(fields: Element): Element {
  return rectangle({
    type: 'freedraw',
    width: 60,
    height: 20,
    points: [
      [0, 0],
      [20, 20],
      [40, 0],
      [60, 20],
    ],
    pressures: [],
    simulatePressure: true,
    lastCommittedPoint: null,
    roughness: 1,
    ...fields,
  });
}

/** A line as the page keeps it, through its points from its x and y. */
function line(fields: Element): Element {
  return rectangle({
    type: 'line',
    lastCommittedPoint: null,
    startBinding: null,
    endBinding: null,
    startArrowhead: null,
    endArrowhead: null,
    polygon: false,
    ...fields,
  });
}

/** A text as the page keeps it, outside a container. */
function textShape(fields: Element & { text: string }): Element {
  return rectangle({
    type: 'text',
    width: fields.text.length * 12,
    height: 25,
    fontSize: 20,
    fontFamily: 5,
    textAlign: 'left',
    verticalAlign: 'top',
    containerId: null,
    originalText: fields.text,
    autoResize: true,
    lineHeight: 1.25,
    ...fields,
  });
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

/** A text of 32 px at (0, 0), as add_shapes adds it, drawn by render_board: `region` of it, at twice its size. */
async function drawnText(words: string, region: Region): Promise<Pixels> {
  const client = await connected(new Y.Doc());
  const added = await call(client, 'add_shapes', { shapes: [{ type: 'text', x: 0, y: 0, text: words, fontSize: 32 }] });
  expect(added.isError, JSON.stringify(added.content)).not.toBe(true);
  const size = { max_width: 2 * region.width, max_height: 2 * region.height };
  return picture(await call(client, 'render_board', { region, ...size })).pixels;
}

/** How many pixels of two pictures of one size differ in their red, green or blue. */
function differing(a: Pixels, b: Pixels): number {
  expect([a.width, a.height]).toEqual([b.width, b.height]);
  let count = 0;
  for (let pixel = 0; pixel < a.data.length; pixel += 4) {
    if ([0, 1, 2].some((channel) => a.data[pixel + channel] !== b.data[pixel + channel])) count++;
  }
  return count;
}

/** The path of a font file of the dejavu-fonts-ttf package, such as DejaVuSans.ttf. */
function dejavu(font: string): string {
  return createRequire(import.meta.url).resolve(`dejavu-fonts-ttf/ttf/${font}`);
}

/**
 * Runs `work` as on a machine whose fonts are the files of dejavu-fonts-ttf that `fonts` lists. On
 * Linux, resvg reads the machine's fonts from the directories that the fontconfig file named by
 * FONTCONFIG_FILE lists, each time it draws.
 */
async function withMachineFonts<T>(fonts: string[], work: () => Promise<T>): Promise<T> {
  const machine = mkdtempSync(join(tmpdir(), 'chalkline-fonts-'));
  const directory = join(machine, 'fonts');
  mkdirSync(directory);
  for (const font of fonts) copyFileSync(dejavu(font), join(directory, font));
  const config = join(machine, 'fonts.conf');
  writeFileSync(config, `<?xml version="1.0"?>\n<fontconfig><dir>${directory}</dir></fontconfig>\n`);
  const before = process.env.FONTCONFIG_FILE;
  process.env.FONTCONFIG_FILE = config;
  try {
    return await work();
  } finally {
    if (before === undefined) delete process.env.FONTCONFIG_FILE;
    else process.env.FONTCONFIG_FILE = before;
    rmSync(machine, { recursive: true, force: true });
  }
}

/** Whether resvg, drawing in the machine's fonts, draws the letter of an SVG text. */
function machineDrawsText(): boolean {
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><text x="4" y="32" font-size="32">A</text></svg>';
  return some(decodePng(new Resvg(svg, { background: '#ffffff' }).render().asPng()), dark);
}

const LABELLED = { shapes: [{ type: 'rectangle', x: 0, y: 0, width: 240, height: 80, label: { text: 'Hello' } }] };

/** A green square of 4 pixels by 4. */
const SQUARE = '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"><rect width="4" height="4" fill="#00ff00"/></svg>';

/**
 * An SVG image that holds a group with an opacity far left of the image, which panics resvg 0.34 as
 * it draws the image: it draws the group on a layer wholly outside the area it fits the layer into.
 */
const FAR_GROUP =
  '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 10 10"><g opacity="0.5"><rect x="-100000" width="10" height="10" fill="#0000ff"/></g><rect width="10" height="10" fill="#00ff00"/></svg>';

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

  it("draws a text's letters as it draws them in the same text without its emoji and its em dash", async () => {
    // At 32 px, "Hi, I'm Claude " runs from x 0 to about 234 in DejaVu Sans, so the region holds
    // most of its letters and none of the em dash or the emoji.
    const region = { x: 0, y: 0, width: 200, height: 40 };
    const marked = await drawnText("Hi, I'm Claude \u2014 I'm on the board \u{1F44B}", region);
    const plain = await drawnText("Hi, I'm Claude I'm on the board", region);
    expect(some(plain, dark)).toBe(true);
    expect(differing(marked, plain)).toBe(0);
  });

  it('draws a character that its font lacks, such as an emoji, as a box', async () => {
    const pixels = await drawnText('\u{1F44B}', { x: 0, y: 0, width: 40, height: 40 });
    expect(some(pixels, dark)).toBe(true);
  });

  it.runIf(process.platform === 'linux')("draws a text in the helper's font, whatever fonts the machine holds", async () => {
    // DejaVu Math TeX Gyre holds every character of the text, and DejaVu Sans lacks its last, a
    // mathematical bold A. Were resvg to load the machine's fonts beside the helper's, it would draw
    // the whole text in DejaVu Math TeX Gyre on the first machine, and its letters in DejaVu Sans on
    // the second.
    const words = 'Hello \u{1D400}';
    const region = { x: 0, y: 0, width: 140, height: 40 };
    const withMath = await withMachineFonts(['DejaVuMathTeXGyre.ttf'], async () => {
      expect(machineDrawsText()).toBe(true);
      return drawnText(words, region);
    });
    const withNone = await withMachineFonts([], async () => {
      expect(machineDrawsText()).toBe(false);
      return drawnText(words, region);
    });
    expect(some(withNone, dark)).toBe(true);
    expect(differing(withMath, withNone)).toBe(0);
  });

  it('draws a freehand stroke as the page draws one, a line of width 0, shapes of size 0.0001 and a text', async () => {
    const client = await connected(
      board([
        stroke({ id: 'stroke', x: 20, y: 20, strokeColor: '#ff0000', strokeWidth: 4, index: 'a1' }),
        line({
          id: 'upright',
          x: 120,
          y: 10,
          width: 0,
          height: 80,
          points: [
            [0, 0],
            [0, 80],
          ],
          index: 'a2',
        }),
        line({
          id: 'short',
          x: 140,
          y: 50,
          width: 0.0001,
          height: 0,
          points: [
            [0, 0],
            [0.0001, 0],
          ],
          index: 'a3',
        }),
        rectangle({ id: 'speck', x: 160, y: 50, width: 0.0001, height: 0.0001, index: 'a4' }),
        textShape({ id: 'words', x: 20, y: 60, text: 'Hello', index: 'a5' }),
      ]),
    );
    const region = { x: 0, y: 0, width: 200, height: 100 };
    const { pixels, answer } = picture(await call(client, 'render_board', { region, max_width: 400 }));
    expect(answer).toEqual({ region, width: 400, height: 200 });
    // Excalidraw didn't draw a freehand stroke without a Path2D, which jsdom doesn't define, so the
    // picture held nothing red.
    expect(some(pixels, red)).toBe(true);
    // The line of width 0 runs down at x 120, 2 wide.
    expect(dark(...at(pixels, 240, 100))).toBe(true);
  });

  it("draws a region far from a labelled arrow, whose label's mask panicked resvg", async () => {
    const client = await connected(new Y.Doc());
    const added = await call(client, 'add_shapes', {
      shapes: [
        { type: 'rectangle', x: 0, y: 0, width: 100, height: 60 },
        { type: 'rectangle', x: 400, y: 0, width: 100, height: 60 },
        {
          type: 'rectangle',
          x: 8000,
          y: 4600,
          width: 200,
          height: 200,
          strokeColor: '#ff0000',
          backgroundColor: '#ff0000',
          fillStyle: 'solid',
        },
      ],
    });
    expect(added.isError, JSON.stringify(added.content)).not.toBe(true);
    const [start, end] = (added.structuredContent as { ids: string[] }).ids;
    const linked = await call(client, 'connect', { start, end, label: { text: 'far' } });
    expect(linked.isError, JSON.stringify(linked.content)).not.toBe(true);

    // The region of the call that stopped the helper: resvg drew the arrow, which its label masks,
    // on a layer wholly outside the area it fits each layer into, and panicked.
    const region = { x: 7700, y: 4350, width: 960, height: 850 };
    const { pixels, answer } = picture(await call(client, 'render_board', { region, max_width: 1100 }));
    expect(answer).toEqual({ region, width: 1100, height: 974 });
    expect(some(pixels, red)).toBe(true);
  });

  it('answers an error where resvg stops before it draws the picture, and the helper goes on', async () => {
    const doc = board([
      rectangle({
        id: 'picture',
        type: 'image',
        width: 40,
        height: 40,
        strokeColor: 'transparent',
        fileId: 'far',
        status: 'saved',
        scale: [1, 1],
        crop: null,
        index: 'a1',
      }),
    ]);
    doc.getMap<unknown>(FILES).set('far', {
      id: 'far',
      mimeType: 'image/svg+xml',
      dataURL: `data:image/svg+xml;base64,${Buffer.from(FAR_GROUP).toString('base64')}`,
      created: 1,
    });
    const client = await connected(doc);
    const failed = await call(client, 'render_board', { region: { x: 0, y: 0, width: 40, height: 40 } });
    expect(failed.isError).toBe(true);
    expect(text(failed)).toMatch(
      /^resvg, which turns the board's SVG into the PNG in a process of its own, stopped on the signal SIGABRT before it drew the picture: .*panicked/s,
    );

    const read = await call(client, 'get_board');
    expect(read.isError, JSON.stringify(read.content)).not.toBe(true);
    const { pixels } = picture(await call(client, 'render_board', { region: { x: 100, y: 100, width: 40, height: 40 } }));
    expect(every(pixels, white)).toBe(true);
  });

  it("answers an error once the call's timeout passes, and draws the next call", async () => {
    const client = await connected(new Y.Doc());
    const added = await call(client, 'add_shapes', LABELLED);
    expect(added.isError, JSON.stringify(added.content)).not.toBe(true);

    // resvg's process alone takes longer than a millisecond to start.
    const late = await call(client, 'render_board', { timeout: 0.001 });
    expect(late.isError).toBe(true);
    expect(text(late)).toBe(
      "render_board didn't draw the picture within 0.001 seconds, the call's timeout: draw a smaller region, or give a longer timeout.",
    );
    const read = await call(client, 'get_board');
    expect(read.isError, JSON.stringify(read.content)).not.toBe(true);
    picture(await call(client, 'render_board', { timeout: 60 }));
  });

  it('stops the render where the client cancels the call', async () => {
    const client = await connected(new Y.Doc());
    const added = await call(client, 'add_shapes', LABELLED);
    expect(added.isError, JSON.stringify(added.content)).not.toBe(true);

    // The render that the server starts for the next call, read as the server starts it.
    const { renderBoard: render } = await vi.importActual<typeof import('./render')>('./render');
    const started = new Promise<{ drawing: Promise<Picture> }>((resolve) => {
      vi.mocked(renderBoard).mockImplementationOnce((doc, options) => {
        const drawing = render(doc, options);
        resolve({ drawing });
        return drawing;
      });
    });
    const cancel = new AbortController();
    const calling = client.callTool({ name: 'render_board', arguments: {} }, undefined, { signal: cancel.signal });
    const { drawing } = await started;
    cancel.abort(new Error('The test cancels the call.'));
    await expect(calling).rejects.toThrow('The test cancels the call.');
    await expect(drawing).rejects.toThrow('The client cancelled the call before render_board drew the picture.');
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

  it('draws the stroke of a shape whose bounds lie just outside the region', async () => {
    const doc = board([rectangle({ id: 'beside', x: 101, width: 50, strokeWidth: 4, index: 'a1' })]);
    const pixels = await drawn(doc, { x: 0, y: 0, width: 100, height: 100 });
    // The rectangle's left side, 4 wide, reaches 2 into the region from x 101.
    expect(dark(...at(pixels, 99, 50))).toBe(true);
    expect(white(...at(pixels, 50, 50))).toBe(true);
  });

  it('leaves out a shape whose frame lies outside the region, since the frame clips it', async () => {
    const doc = board([
      rectangle({ id: 'frame', type: 'frame', name: null, x: 1000, index: 'a0' }),
      rectangle({ id: 'inside', strokeColor: '#ff0000', backgroundColor: '#ff0000', frameId: 'frame', index: 'a1' }),
    ]);
    expect(every(await drawn(doc, { x: 25, y: 25, width: 50, height: 50 }), white)).toBe(true);
  });

  it('stops with a RenderError where the signal aborts, before or while it draws', async () => {
    const doc = board([rectangle({ id: 'box', index: 'a1' })]);
    const options = { region: { x: 0, y: 0, width: 50, height: 50 }, maxWidth: 50, maxHeight: 50 };
    const cancelled = 'The client cancelled the call before render_board drew the picture.';
    const before = await renderBoard(doc, { ...options, signal: AbortSignal.abort() }).catch((error: unknown) => error);
    expect(before).toBeInstanceOf(RenderError);
    expect((before as Error).message).toBe(cancelled);

    const during = new AbortController();
    const drawing = renderBoard(doc, { ...options, signal: during.signal });
    during.abort();
    const stopped = await drawing.catch((error: unknown) => error);
    expect(stopped).toBeInstanceOf(RenderError);
    expect((stopped as Error).message).toBe(cancelled);
  });

  it("clears the timeout's timer once it draws the picture", async () => {
    const doc = board([rectangle({ id: 'box', index: 'a1' })]);
    const set = vi.spyOn(globalThis, 'setTimeout');
    const cleared = vi.spyOn(globalThis, 'clearTimeout');
    try {
      await renderBoard(doc, { region: { x: 0, y: 0, width: 50, height: 50 }, maxWidth: 50, maxHeight: 50, timeout: 1234.5 });
      // The timeout's timer, which renderBoard sets in milliseconds.
      const at = set.mock.calls.findIndex(([, delay]) => delay === 1_234_500);
      expect(at).not.toBe(-1);
      expect(cleared).toHaveBeenCalledWith(set.mock.results[at].value);
    } finally {
      set.mockRestore();
      cleared.mockRestore();
    }
  });

  it('takes its listener off the signal once it draws the picture', async () => {
    const doc = board([rectangle({ id: 'box', index: 'a1' })]);
    const client = new AbortController();
    await renderBoard(doc, { region: { x: 0, y: 0, width: 50, height: 50 }, maxWidth: 50, maxHeight: 50, signal: client.signal });
    expect(getEventListeners(client.signal, 'abort')).toEqual([]);
  });

  it('draws a board of 3,000 shapes, and logs how long each picture takes', async () => {
    const shapes = generateNKeysBetween(null, null, 3000).map((index, at) => {
      const fields = { id: `shape ${at}`, x: (at % 50) * 120, y: Math.trunc(at / 50) * 90, index };
      if (at % 3 === 0) return stroke(fields);
      if (at % 3 === 1) return rectangle({ ...fields, width: 80, height: 60 });
      return textShape({ ...fields, text: `Shape ${at}` });
    });
    const doc = board(shapes);
    for (const region of [undefined, { x: 2400, y: 2000, width: 960, height: 850 }]) {
      const started = performance.now();
      const result = await renderBoard(doc, { region, maxWidth: 1100, maxHeight: 1024 });
      const seconds = (performance.now() - started) / 1000;
      console.log(
        `renderBoard drew ${region === undefined ? 'the whole board' : 'a region of 960 by 850'} of 3,000 shapes as a PNG of ${result.width} by ${result.height} pixels in ${seconds.toFixed(2)} seconds`,
      );
      expect(decodePng(result.png).width).toBe(result.width);
    }
  }, 300_000);
});

describe('rasterize', () => {
  it('draws an SVG as a PNG', async () => {
    const pixels = decodePng(await rasterize(SQUARE));
    expect([pixels.width, pixels.height]).toEqual([4, 4]);
    expect([...colors(pixels)]).toEqual(['0,255,0,255']);
  });

  it("answers a RenderError that says how resvg's process stopped", async () => {
    const error = await rasterize('<svg').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RenderError);
    expect((error as Error).message).toMatch(
      /^resvg, which turns the board's SVG into the PNG in a process of its own, stopped with the exit code 1 before it drew the picture: \S/,
    );
  });

  it("answers a RenderError where Node can't start resvg's process", async () => {
    // A path that doesn't hold a program, in place of Node's, so that Node can't start the process.
    const dir = mkdtempSync(join(tmpdir(), 'chalkline-rasterize-'));
    const missing = join(dir, 'node');
    const node = process.execPath;
    // rasterize starts the process as it is called, so Node's path comes back before the call
    // answers, and the tests after this one start Node's process whatever this one answers.
    const drawing = (() => {
      process.execPath = missing;
      try {
        return rasterize(SQUARE);
      } finally {
        process.execPath = node;
        rmSync(dir, { recursive: true });
      }
    })();
    const error = await drawing.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RenderError);
    expect((error as Error).message).toBe(`render_board couldn't start resvg's process: spawn ${missing} ENOENT`);
  });

  it("doesn't start resvg's process where the signal aborted already", async () => {
    await expect(rasterize(SQUARE, AbortSignal.abort(new Error('aborted before')))).rejects.toThrow('aborted before');
  });

  it("ends resvg's process where the signal aborts while the process reads the SVG", async () => {
    // The SVG is longer than a pipe holds, so the process ends while the helper still writes it.
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10">${'<rect width="10" height="10"/>'.repeat(20_000)}</svg>`;
    const stop = new AbortController();
    const drawing = rasterize(svg, stop.signal);
    stop.abort(new Error('aborted while drawing'));
    await expect(drawing).rejects.toThrow('aborted while drawing');
  });
});
