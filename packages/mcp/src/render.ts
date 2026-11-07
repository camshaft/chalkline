import { Resvg } from '@resvg/resvg-js';
import type * as Y from 'yjs';
import { backToFront, ELEMENTS } from './board';
import { loadExcalidraw, type Excalidraw } from './skeleton';

// render_board draws the picture in the helper, from its copy of the board, and doesn't ask a page
// for it through a request as add_mermaid does: it draws with no page open, it draws the shapes
// that get_board reads, and the picture's bytes stay out of the shared state that every
// participant keeps. Excalidraw's exportToSvg draws the board as SVG under jsdom, and resvg turns
// the SVG into a PNG. The helper loads Excalidraw's fonts as nothing, so resvg draws text in a font
// of the helper's machine.

/** The shared map that holds the board's files, such as an image's picture, by id, as the page keeps them. */
export const FILES = 'files';

/** The space renderBoard leaves around the board's shapes where it draws the whole board, in the board's units. */
export const MARGIN = 10;

const SVG = 'http://www.w3.org/2000/svg';

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

type ExportOptions = Parameters<Excalidraw['exportToSvg']>[0];

/**
 * Draws `region` of the board that `doc` holds, or the whole board with MARGIN around its shapes
 * where `region` is left out, as Excalidraw exports it, on white. The picture keeps the region's
 * shape, and is at most `maxWidth` pixels wide and `maxHeight` pixels high. Throws a RenderError
 * where the board doesn't hold a shape and `region` is left out.
 */
export async function renderBoard(
  doc: Y.Doc,
  { region, maxWidth, maxHeight }: { region?: Region; maxWidth: number; maxHeight: number },
): Promise<Picture> {
  const excalidraw = await loadExcalidraw();
  const elements = excalidraw.getNonDeletedElements(
    excalidraw.restoreElements(boardElements(doc) as unknown as Parameters<Excalidraw['restoreElements']>[0], null),
  );
  // exportToSvg moves the shapes so that the top left corner of the bounds of the frames, and of
  // the shapes outside frames, is the origin of the SVG it draws.
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

  const svg =
    bounds === null
      ? document.createElementNS(SVG, 'svg')
      : await excalidraw.exportToSvg({
          elements,
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
  const [minX, minY] = bounds ?? [0, 0];
  // exportToSvg sets xmlns as an attribute, which XMLSerializer writes a second time beside the
  // namespace it declares for the svg element, and resvg refuses an attribute written twice.
  svg.removeAttribute('xmlns');
  svg.setAttribute('viewBox', `${drawn.x - minX} ${drawn.y - minY} ${drawn.width} ${drawn.height}`);
  svg.setAttribute('width', String(width));
  svg.setAttribute('height', String(height));
  svg.setAttribute('preserveAspectRatio', 'none');
  const png = new Resvg(new XMLSerializer().serializeToString(svg), {
    background: '#ffffff',
    fitTo: { mode: 'original' },
  })
    .render()
    .asPng();
  return { png, region: drawn, width, height };
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
