import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types';
import type * as Y from 'yjs';
import { backToFront, ELEMENTS } from './board';
import { loadExcalidraw, type Excalidraw } from './skeleton';

// render_board draws the picture in the helper, from its copy of the board, and doesn't ask a page
// for it through a request as add_mermaid does: it draws with no page open, it draws the shapes
// that get_board reads, and the picture's bytes stay out of the shared state that every
// participant keeps. Excalidraw's exportToSvg draws the board as SVG under jsdom, and resvg turns
// the SVG into a PNG in a Node process of its own, since a panic of resvg's aborts the process it
// runs in. The helper loads Excalidraw's fonts as nothing, so resvg draws every text in FONT, the
// one font it loads.

/**
 * The font resvg draws every text in: DejaVu Sans, from the dejavu-fonts-ttf package, on every
 * machine. resvg loads none of the machine's fonts. Where a text holds a character that its font
 * lacks, resvg draws the whole text in the first loaded font that holds that character, wherever
 * that font holds each other character of the text too: a machine font that holds every character
 * as a box, as one of macOS's fonts does, then draws the whole text as boxes. A character that
 * DejaVu Sans lacks, such as most emoji, draws as that font's box for a missing character.
 */
const FONT = createRequire(import.meta.url).resolve('dejavu-fonts-ttf/ttf/DejaVuSans.ttf');

/** The shared map that holds the board's files, such as an image's picture, by id, as the page keeps them. */
export const FILES = 'files';

/** The space renderBoard leaves around the board's shapes where it draws the whole board, in the board's units. */
export const MARGIN = 10;

const SVG = 'http://www.w3.org/2000/svg';

/** The file of resvg's module, which the rasterizer's process loads, found as the helper finds its own modules. */
const RESVG = createRequire(import.meta.url).resolve('@resvg/resvg-js');

/** resvg's options: the picture on white, at the size the SVG sets. */
const RESVG_OPTIONS = {
  background: '#ffffff',
  fitTo: { mode: 'original' },
  // Excalidraw names its own fonts in the SVG, which resvg doesn't find, so it draws each text in
  // the first font it loads, FONT.
  font: { loadSystemFonts: false, fontFiles: [FONT] },
};

/**
 * The rasterizer, a script that Node runs in a process of its own: it reads an SVG on its standard
 * input and writes resvg's PNG of the SVG on its standard output. It loads resvg's module from the
 * file its first argument holds, and reads resvg's options from the JSON its second argument holds.
 * Where resvg throws, it writes the error's message on its standard error and exits with code 1.
 */
const RASTERIZER = `
const { Resvg } = require(process.argv[1]);
const chunks = [];
process.stdin.on('data', (chunk) => chunks.push(chunk));
process.stdin.on('end', () => {
  let png;
  try {
    const svg = Buffer.concat(chunks).toString('utf8');
    png = new Resvg(svg, JSON.parse(process.argv[2])).render().asPng();
  } catch (error) {
    process.stderr.write(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
    return;
  }
  process.stdout.write(png);
});
`;

/** A part of the board, in the board's units: its top left corner, its width and its height. */
export interface Region {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A picture of a part of the board. */
export interface Picture {
  /** The picture as a PNG file. */
  png: Buffer;
  /** The part of the board that the picture shows. */
  region: Region;
  /** The picture's width in pixels. */
  width: number;
  /** The picture's height in pixels. */
  height: number;
}

/** A refusal of render_board's call, whose message says what to change. */
export class RenderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RenderError';
  }
}

/** What renderBoard draws, and what stops it. */
export interface RenderOptions {
  /** The part of the board to draw; the whole board, with MARGIN around its shapes, where it is left out. */
  region?: Region;
  /** The widest the picture may be, in pixels. */
  maxWidth: number;
  /** The highest the picture may be, in pixels. */
  maxHeight: number;
  /** The seconds the render may take before it stops with a RenderError; it doesn't stop at a time where this is left out. */
  timeout?: number;
  /** A signal whose abort stops the render with a RenderError, such as the client's cancel of the call. */
  signal?: AbortSignal;
}

type ExportOptions = Parameters<Excalidraw['exportToSvg']>[0];

/**
 * Draws `region` of the board that `doc` holds, or the whole board with MARGIN around its shapes
 * where `region` is left out, as Excalidraw exports it, on white. The picture keeps the region's
 * shape, and is at most `maxWidth` pixels wide and `maxHeight` pixels high. Throws a RenderError
 * where the board doesn't hold a shape and `region` is left out, where resvg fails or stops before
 * it draws the picture, where `signal` aborts, and where `timeout` seconds pass first. On the
 * signal's abort or at the timeout, renderBoard ends resvg's process and throws the RenderError as
 * soon as Excalidraw's export, which runs in the helper, yields.
 */
export async function renderBoard(doc: Y.Doc, options: RenderOptions): Promise<Picture> {
  const { timeout, signal } = options;
  const stop = new AbortController();
  const cancel = () =>
    stop.abort(new RenderError('The client cancelled the call before render_board drew the picture.'));
  signal?.addEventListener('abort', cancel, { once: true });
  if (signal?.aborted) cancel();
  const timer =
    timeout === undefined
      ? undefined
      : setTimeout(
          () =>
            stop.abort(
              new RenderError(
                `render_board didn't draw the picture within ${timeout} seconds, the call's timeout: draw a smaller region, or give a longer timeout.`,
              ),
            ),
          timeout * 1000,
        );
  try {
    stop.signal.throwIfAborted();
    const stopped = new Promise<never>((_, reject) => {
      stop.signal.addEventListener('abort', () => reject(stop.signal.reason), { once: true });
    });
    return await Promise.race([draw(doc, options, stop.signal), stopped]);
  } finally {
    void timer;
    signal?.removeEventListener('abort', cancel);
  }
}

/** Draws the picture renderBoard answers, and hands `signal` to resvg's process. */
async function draw(
  doc: Y.Doc,
  { region, maxWidth, maxHeight }: RenderOptions,
  signal: AbortSignal,
): Promise<Picture> {
  const excalidraw = await loadExcalidraw();
  const elements = excalidraw.getNonDeletedElements(
    excalidraw.restoreElements(boardElements(doc) as unknown as Parameters<Excalidraw['restoreElements']>[0], null),
  );
  // The whole board's bounds: those of the frames, and of the shapes outside frames.
  const roots = rootElements(elements);
  const bounds = roots.length === 0 ? null : excalidraw.getCommonBounds(roots);
  const drawn = region ?? (bounds === null ? null : withMargin(bounds));
  if (drawn === null) {
    throw new RenderError(
      "The board doesn't hold a shape, so it has no bounds to draw: set region to draw a part of the board.",
    );
  }
  const scale = Math.min(maxWidth / drawn.width, maxHeight / drawn.height);
  const width = Math.min(maxWidth, Math.max(1, Math.round(drawn.width * scale)));
  const height = Math.min(maxHeight, Math.max(1, Math.round(drawn.height * scale)));

  const shown = near(excalidraw, elements, drawn);
  const svg =
    shown.length === 0
      ? document.createElementNS(SVG, 'svg')
      : await excalidraw.exportToSvg({
          elements: shown,
          appState: {
            exportBackground: false,
            // exportToSvg counts a frame's name in the bounds it moves the shapes by.
            frameRendering: { enabled: true, name: false, outline: true, clip: true },
          },
          files: boardFiles(doc) as ExportOptions['files'],
          exportPadding: 0,
          skipInliningFonts: true,
          // Each image then sets its width and height in the board's units. With the image that a
          // <use> shares at width and height 100%, resvg drew an image on part of its place only.
          reuseImages: false,
        });
  // exportToSvg moves the shapes so that the top left corner of the bounds of the frames, and of
  // the shapes outside frames, that it draws is the origin of the SVG.
  const [minX, minY] = shown.length === 0 ? [0, 0] : excalidraw.getCommonBounds(rootElements(shown));
  // exportToSvg sets xmlns as an attribute, which XMLSerializer writes a second time beside the
  // namespace it declares for the svg element, and resvg refuses an attribute written twice.
  svg.removeAttribute('xmlns');
  svg.setAttribute('viewBox', `${drawn.x - minX} ${drawn.y - minY} ${drawn.width} ${drawn.height}`);
  svg.setAttribute('width', String(width));
  svg.setAttribute('height', String(height));
  svg.setAttribute('preserveAspectRatio', 'none');
  const png = await rasterize(new XMLSerializer().serializeToString(svg), signal);
  return { png, region: drawn, width, height };
}

/**
 * The elements of `elements` that can show in `drawn`, which renderBoard draws in place of the
 * whole board: each element whose bounds meet the area of `drawn` grown by half its width and half
 * its height on each side, so that a stroke wider than its shape's bounds still shows at the
 * region's edge, and whose frame, where it is in one, meets that area too, since its frame clips it.
 *
 * resvg 0.34 draws each group that has a mask, a clip path or an opacity, such as a labelled arrow
 * or an image, on a layer that it fits into an area four times the picture's width wide and four
 * times its height high, which starts twice the picture's width left of and twice its height above
 * the picture's top left corner, and it panics where the layer lies wholly outside that area
 * (render_group in its render.rs, fit_to_rect in its geom.rs). The grown area lies inside resvg's
 * area, so each layer of the elements drawn meets resvg's area.
 */
function near<T extends ExcalidrawElement>(excalidraw: Excalidraw, elements: readonly T[], drawn: Region): T[] {
  const left = drawn.x - drawn.width / 2;
  const top = drawn.y - drawn.height / 2;
  const right = drawn.x + drawn.width * 1.5;
  const bottom = drawn.y + drawn.height * 1.5;
  const meets = (element: T) => {
    const [minX, minY, maxX, maxY] = excalidraw.getCommonBounds([element]);
    return maxX >= left && minX <= right && maxY >= top && minY <= bottom;
  };
  const frames = new Map(
    elements.filter((element) => isFrame(element)).map((frame): [string, boolean] => [frame.id, meets(frame)]),
  );
  return elements.filter(
    (element) => meets(element) && (element.frameId === null || frames.get(element.frameId) !== false),
  );
}

/**
 * Turns `svg` into a PNG with resvg, in a Node process of its own, so that a panic of resvg's,
 * which aborts the process it runs in, ends that process and not the helper. Rejects with a
 * RenderError where the process fails or stops before it writes the PNG, and with the reason of
 * `signal` where `signal` aborts, which ends the process.
 */
export function rasterize(svg: string, signal?: AbortSignal): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const child = spawn(process.execPath, ['-e', RASTERIZER, RESVG, JSON.stringify(RESVG_OPTIONS)]);
    const kill = () => child.kill('SIGKILL');
    signal?.addEventListener('abort', kill, { once: true });
    const png: Buffer[] = [];
    const said: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => png.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => said.push(chunk));
    child.stdin.on('error', () => {
      // A process that stops before it reads the whole SVG closes its input, and the close of the
      // process answers the call.
    });
    child.on('error', (error) => {
      signal?.removeEventListener('abort', kill);
      reject(new RenderError(`render_board couldn't start resvg's process: ${error.message}`));
    });
    child.on('close', (code, ended) => {
      signal?.removeEventListener('abort', kill);
      if (code === 0) {
        resolve(Buffer.concat(png));
      } else if (signal?.aborted) {
        reject(signal.reason);
      } else {
        const how = code === null ? `on the signal ${ended}` : `with the exit code ${code}`;
        const message = Buffer.concat(said).toString('utf8').trim();
        reject(
          new RenderError(
            `resvg, which turns the board's SVG into the PNG in a process of its own, stopped ${how} before it drew the picture${message === '' ? '.' : `: ${message}`}`,
          ),
        );
      }
    });
    child.stdin.end(svg);
  });
}

/** The board's elements from back to front, as copies, without the deleted ones and the values that aren't elements. */
function boardElements(doc: Y.Doc): Record<string, unknown>[] {
  const elements: Record<string, unknown>[] = [];
  for (const value of doc.getMap<unknown>(ELEMENTS).values()) {
    if (typeof value !== 'object' || value === null) continue;
    const element = value as Record<string, unknown>;
    if (typeof element.id !== 'string' || typeof element.type !== 'string' || element.isDeleted === true) continue;
    // Excalidraw's restore may change the objects it reads, and these are the board's own.
    elements.push(structuredClone(element));
  }
  return elements.sort((a, b) => backToFront(order(a), order(b)));
}

function order(element: Record<string, unknown>): { id: string; index: string | null } {
  return { id: String(element.id), index: typeof element.index === 'string' ? element.index : null };
}

/** The board's files by id, as exportToSvg reads them for its images. */
function boardFiles(doc: Y.Doc): Record<string, unknown> {
  const files: Record<string, unknown> = {};
  for (const value of doc.getMap<unknown>(FILES).values()) {
    if (typeof value !== 'object' || value === null) continue;
    const file = value as Record<string, unknown>;
    if (typeof file.id === 'string' && typeof file.mimeType === 'string' && typeof file.dataURL === 'string') {
      files[file.id] = file;
    }
  }
  return files;
}

/** The elements whose bounds exportToSvg draws from: each frame, and each element that isn't in a frame of `elements`. */
function rootElements<T extends { id: string; type: string; frameId: string | null }>(elements: readonly T[]): T[] {
  const frames = new Set(elements.filter((element) => isFrame(element)).map((element) => element.id));
  return elements.filter((element) => frames.has(element.id) || !element.frameId || !frames.has(element.frameId));
}

function isFrame(element: { type: string }): boolean {
  return element.type === 'frame' || element.type === 'magicframe';
}

function withMargin([minX, minY, maxX, maxY]: readonly [number, number, number, number]): Region {
  return { x: minX - MARGIN, y: minY - MARGIN, width: maxX - minX + 2 * MARGIN, height: maxY - minY + 2 * MARGIN };
}
