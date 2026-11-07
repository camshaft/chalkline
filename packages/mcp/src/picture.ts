import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types';
import type * as Y from 'yjs';
import { backToFront, ELEMENTS, groupsOf, indicesAt, newId, ShapeError } from './board';
import { withCreator, type Creator } from './creator';
import { deleteShapes, selected, withLabels } from './edit';
import { boardElements, FILES, renderBoard, RenderError, withMargin, type Region } from './render';
import type { FlattenRequest, ImageRequest, Place } from './shapes';
import { convertSkeletons, loadExcalidraw, type Excalidraw, type Skeleton } from './skeleton';

// add_image and flatten write a picture as the page writes one that a person drops on the board:
// an image element whose fileId names a file of the board's files map, which holds the picture as
// a data URL, so that every page of the room loads it, and render_board draws it. Each writes its
// change in one transaction whose origin is the call's agent, which the server's record of the
// agent's changes reads (agent-changes.ts).

/** The most bytes a picture may hold: Excalidraw's limit for a file that a person adds to a board, 4 MiB. */
export const MAX_FILE_BYTES = 4 * 1024 * 1024;

/** How many pixels flatten's picture holds for each of the board's units, across and down, where the call leaves scale out. */
export const FLATTEN_SCALE = 2;

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';

/** The kinds of picture add_image places, by their MIME types. */
type MimeType = 'image/png' | 'image/jpeg' | 'image/svg+xml';

/** A picture that add_image read: its bytes, its kind, and its size in pixels where the picture says it. */
interface Read {
  bytes: Buffer;
  mimeType: MimeType;
  size: { width: number; height: number } | undefined;
}

/** A file of the board's files map, as the page keeps it, which an image element's fileId names. */
export interface PictureFile {
  id: string;
  mimeType: MimeType;
  dataURL: string;
  created: number;
  lastRetrieved: number;
}

/** What add_image answers: the image element's id, its file's id, and its size on the board. */
export interface AddedImage {
  id: string;
  file: string;
  width: number;
  height: number;
}

/** What flatten answers: the image element's id, its file's id, the shapes it deleted, and the picture's region and size. */
export interface Flattened {
  id: string;
  file: string;
  ids: string[];
  region: Region;
  width: number;
  height: number;
}

/**
 * Places the picture that `request.path` or `request.data_url` holds, a PNG, a JPEG or an SVG, on
 * the board that `doc` holds, with its top left corner at `request.x` and `request.y`, as wide as
 * `request.width`, and as high as `request.height`, or as high as keeps the picture's proportions
 * where that is left out. The image element and the picture's file go on the board in one
 * transaction, the element at `request.place` in the stacking order, in front of every shape where
 * that is left out, and the element records `creator` as its creator. Throws a ShapeError, and adds
 * nothing, where the call sets both sources or neither, the picture can't be read, holds more than
 * MAX_FILE_BYTES, isn't a PNG, a JPEG or an SVG, or doesn't say its size and the call leaves height
 * out, or where `request.place` names an id that indicesAt refuses.
 */
export async function addImage(doc: Y.Doc, request: ImageRequest, creator: Creator): Promise<AddedImage> {
  const picture = await readPicture(request);
  const height = request.height ?? heightFor(picture, request.width);
  const file = fileOf(picture);
  const id = newId();
  const element = await pictureElement({ id, fileId: file.id, x: request.x, y: request.y, width: request.width, height, groupIds: [] });
  doc.transact(() => {
    const [index] = indicesAt(doc.getMap<unknown>(ELEMENTS), request.place ?? 'front', 1);
    writePicture(doc, element, index, file, creator);
  }, creator);
  return { id, file: file.id, width: request.width, height };
}

/**
 * Turns shapes of the board that `doc` holds into one picture: the shapes `request.ids`, and every
 * shape of each group of `request.groups`, or each shape that lies wholly inside `request.region`,
 * each with its label. It draws them as render_board draws them, on a transparent background, at
 * `request.scale` pixels for each of the board's units, FLATTEN_SCALE where that is left out: the
 * part of the board `request.region` sets, or the bounds of the shapes with MARGIN around them. In
 * one transaction, it then deletes the shapes, as delete_shapes deletes them, and places the picture
 * where it drew them, just above the frontmost of them in the stacking order, in each group that
 * every one of them is in, with `creator` as its creator. Throws a ShapeError, and changes nothing,
 * where the call names neither shapes nor a region, or both, where a region doesn't hold a whole shape,
 * where the shapes are refused as delete_shapes refuses them, as they are when the call starts and
 * once the picture is drawn, where the picture can't be drawn, or where it holds more than
 * MAX_FILE_BYTES. `signal`'s abort stops the drawing, as it stops render_board's.
 */
export async function flatten(doc: Y.Doc, request: FlattenRequest, creator: Creator, signal?: AbortSignal): Promise<Flattened> {
  const shared = doc.getMap<unknown>(ELEMENTS);
  const ids = request.ids ?? [];
  const groups = request.groups ?? [];
  const region = request.region ?? undefined;
  const named = ids.length > 0 || groups.length > 0;
  if (!named && region === undefined) {
    throw new ShapeError("The call doesn't say which shapes to turn into a picture: give ids, groups or both, or give region.");
  }
  if (named && region !== undefined) {
    throw new ShapeError('The call sets region beside ids or groups: give the shapes by their ids and groups, or by a region, and not both.');
  }

  const excalidraw = await loadExcalidraw();
  const elements = liveElements(excalidraw, doc);
  const chosen = named
    ? selected(shared, ids, groups, (container) => `flatten "${container}", which turns its label into the picture with it`)
    : inside(excalidraw, elements, region as Region);
  if (chosen.length === 0) {
    const area = region as Region;
    throw new ShapeError(
      `No shape lies wholly inside the region at (${area.x}, ${area.y}), ${area.width} wide and ${area.height} high: get_board lists each shape's position and size.`,
    );
  }
  const drawn = withLabels(shared, chosen);
  const area = region ?? withMargin(excalidraw.getCommonBounds(elements.filter((element) => drawn.has(element.id))));
  const scale = request.scale ?? FLATTEN_SCALE;

  let png: Buffer;
  let width: number;
  let height: number;
  try {
    ({ png, width, height } = await renderBoard(doc, {
      region: area,
      maxWidth: Math.max(1, Math.round(area.width * scale)),
      maxHeight: Math.max(1, Math.round(area.height * scale)),
      only: drawn,
      transparent: true,
      signal,
    }));
  } catch (error) {
    if (error instanceof RenderError) throw new ShapeError(error.message.replaceAll('render_board', 'flatten'));
    throw error;
  }
  if (png.length > MAX_FILE_BYTES) {
    throw new ShapeError(
      `The picture is ${png.length} bytes, more than the ${MAX_FILE_BYTES} bytes, 4 MiB, a board's picture may hold: give a smaller scale, or turn fewer shapes into a picture.`,
    );
  }

  const file = fileOf({ bytes: png, mimeType: 'image/png', size: { width, height } });
  const id = newId();
  const element = await pictureElement({
    id,
    fileId: file.id,
    x: area.x,
    y: area.y,
    width: area.width,
    height: area.height,
    groupIds: sharedGroups(shared, chosen),
  });
  let deleted: string[] = [];
  doc.transact(() => {
    const [index] = indicesAt(shared, frontPlace(shared, chosen), 1);
    deleted = deleteShapes(doc, chosen, [], creator);
    writePicture(doc, element, index, file, creator);
  }, creator);
  return { id, file: file.id, ids: deleted, region: area, width, height };
}

/** The picture that `request` names, read from its file or its data URL. Throws a ShapeError as addImage says. */
async function readPicture(request: ImageRequest): Promise<Read> {
  const path = request.path ?? undefined;
  const dataUrl = request.data_url ?? undefined;
  if (path !== undefined && dataUrl !== undefined) {
    throw new ShapeError('The call sets both path and data_url: give the picture one way, by path or by data_url.');
  }
  let bytes: Buffer;
  if (path !== undefined) {
    bytes = await fromFile(path);
  } else if (dataUrl !== undefined) {
    bytes = await fromDataUrl(dataUrl);
  } else {
    throw new ShapeError(
      "The call doesn't give a picture: give path, the path of a PNG, JPEG or SVG file, or data_url, the picture as a data URL.",
    );
  }
  if (bytes.length > MAX_FILE_BYTES) {
    throw new ShapeError(
      `The picture is ${bytes.length} bytes, more than the ${MAX_FILE_BYTES} bytes, 4 MiB, a board's picture may hold: give a smaller picture.`,
    );
  }
  const read = await recognized(bytes);
  if (read === undefined) {
    throw new ShapeError(
      `The picture isn't a PNG, a JPEG or an SVG whose svg element is in the namespace ${SVG_NAMESPACE}: give a picture of one of those kinds.`,
    );
  }
  return read;
}

async function fromFile(path: string): Promise<Buffer> {
  try {
    const { size } = await stat(path);
    if (size > MAX_FILE_BYTES) {
      throw new ShapeError(
        `The file "${path}" is ${size} bytes, more than the ${MAX_FILE_BYTES} bytes, 4 MiB, a board's picture may hold: give a smaller picture.`,
      );
    }
    return await readFile(path);
  } catch (error) {
    if (error instanceof ShapeError) throw error;
    throw new ShapeError(`chalkline-mcp couldn't read the file "${path}": ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function fromDataUrl(dataUrl: string): Promise<Buffer> {
  let url: URL;
  try {
    url = new URL(dataUrl);
  } catch {
    throw new ShapeError("data_url isn't a URL: give the picture as a data URL, such as data:image/png;base64,..., or give path.");
  }
  if (url.protocol !== 'data:') {
    throw new ShapeError(
      `data_url is a URL of the scheme ${url.protocol}, and not a data URL: give the picture as a data URL, such as data:image/png;base64,..., or give path.`,
    );
  }
  try {
    const response = await fetch(url);
    return Buffer.from(await response.arrayBuffer());
  } catch (error) {
    throw new ShapeError(`chalkline-mcp couldn't decode data_url: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** The picture `bytes` hold, with its kind and its size, where they are a PNG, a JPEG or an SVG. */
async function recognized(bytes: Buffer): Promise<Read | undefined> {
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length >= 24 && png.every((byte, at) => bytes[at] === byte) && bytes.toString('latin1', 12, 16) === 'IHDR') {
    return { bytes, mimeType: 'image/png', size: positive(bytes.readUInt32BE(16), bytes.readUInt32BE(20)) };
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { bytes, mimeType: 'image/jpeg', size: jpegSize(bytes) };
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
  if (!text.includes('<svg')) return undefined;
  // DOMParser is jsdom's, which loadExcalidraw installs.
  await loadExcalidraw();
  const root = new DOMParser().parseFromString(text, 'image/svg+xml').documentElement;
  if (root === null || root.localName !== 'svg' || root.namespaceURI !== SVG_NAMESPACE) return undefined;
  return { bytes, mimeType: 'image/svg+xml', size: svgSize(root) };
}

/** A JPEG's size, from its first start-of-frame segment, where it holds one. */
function jpegSize(bytes: Buffer): { width: number; height: number } | undefined {
  let at = 2;
  while (at + 4 <= bytes.length) {
    if (bytes[at] !== 0xff) return undefined;
    const marker = bytes[at + 1];
    if (marker === 0xff) {
      at += 1;
      continue;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      at += 2;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) return undefined;
    const length = bytes.readUInt16BE(at + 2);
    const frame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (frame && at + 9 <= bytes.length) return positive(bytes.readUInt16BE(at + 7), bytes.readUInt16BE(at + 5));
    at += 2 + length;
  }
  return undefined;
}

/** An SVG's size, from its width and height in pixels, and its viewBox for what they leave out. */
function svgSize(root: Element): { width: number; height: number } | undefined {
  const width = pixels(root.getAttribute('width'));
  const height = pixels(root.getAttribute('height'));
  const box = (root.getAttribute('viewBox') ?? '').trim().split(/[\s,]+/).map(Number);
  const view = box.length === 4 ? positive(box[2], box[3]) : undefined;
  if (width !== undefined && height !== undefined) return positive(width, height);
  if (view === undefined) return undefined;
  if (width !== undefined) return positive(width, (width * view.height) / view.width);
  if (height !== undefined) return positive((height * view.width) / view.height, height);
  return view;
}

/** A length of an SVG's width or height attribute in pixels, where it is a number with px or no unit. */
function pixels(value: string | null): number | undefined {
  const match = /^\s*([0-9]*\.?[0-9]+(?:[eE][+-]?[0-9]+)?)\s*(?:px)?\s*$/.exec(value ?? '');
  return match === null ? undefined : Number(match[1]);
}

function positive(width: number, height: number): { width: number; height: number } | undefined {
  return Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0 ? { width, height } : undefined;
}

/** The height that keeps `picture`'s proportions at `width`. Throws a ShapeError where the picture doesn't say its size. */
function heightFor(picture: Read, width: number): number {
  if (picture.size === undefined) {
    throw new ShapeError("The picture doesn't say its width and height, so add_image can't keep its proportions: give height.");
  }
  return (width * picture.size.height) / picture.size.width;
}

/** The board's file of `picture`, whose id is the SHA-1 of its bytes in hexadecimal, as Excalidraw names a file. */
function fileOf(picture: Read): PictureFile {
  const created = Date.now();
  return {
    id: createHash('sha1').update(picture.bytes).digest('hex'),
    mimeType: picture.mimeType,
    dataURL: `data:${picture.mimeType};base64,${picture.bytes.toString('base64')}`,
    created,
    lastRetrieved: created,
  };
}

interface PictureFields {
  id: string;
  fileId: string;
  x: number;
  y: number;
  width: number;
  height: number;
  groupIds: string[];
}

/** The image element that shows the file `fields.fileId`, as Excalidraw makes one, with its picture loaded. */
async function pictureElement(fields: PictureFields): Promise<ExcalidrawElement> {
  const skeleton = { type: 'image', ...fields, status: 'saved', scale: [1, 1], crop: null } as unknown as Skeleton;
  const [element] = await convertSkeletons([skeleton], { regenerateIds: false });
  if (element === undefined || element.id !== fields.id) {
    throw new Error(`convertToExcalidrawElements didn't make the image ${fields.id}`);
  }
  return element as ExcalidrawElement;
}

/** Writes `element`, at `index` in the stacking order and with `creator` as its creator, and `file`, where the board doesn't hold it yet. */
function writePicture(doc: Y.Doc, element: ExcalidrawElement, index: string, file: PictureFile, creator: Creator): void {
  const files = doc.getMap<unknown>(FILES);
  if (!files.has(file.id)) files.set(file.id, file);
  doc.getMap<unknown>(ELEMENTS).set(element.id, withCreator({ ...structuredClone(element), index }, creator));
}

/** The board's elements, as Excalidraw restores them, from back to front, without the deleted ones. */
function liveElements(excalidraw: Excalidraw, doc: Y.Doc): readonly ExcalidrawElement[] {
  return excalidraw.getNonDeletedElements(
    excalidraw.restoreElements(boardElements(doc) as unknown as Parameters<Excalidraw['restoreElements']>[0], null),
  );
}

/** The ids of the shapes of `elements` whose bounds lie wholly inside `region`, from back to front, without labels. */
function inside(excalidraw: Excalidraw, elements: readonly ExcalidrawElement[], region: Region): string[] {
  return elements
    .filter((element) => !(element.type === 'text' && typeof element.containerId === 'string'))
    .filter((element) => {
      const [minX, minY, maxX, maxY] = excalidraw.getCommonBounds([element]);
      return minX >= region.x && minY >= region.y && maxX <= region.x + region.width && maxY <= region.y + region.height;
    })
    .map((element) => element.id);
}

/** The place just above the frontmost shape of `ids`, or the front where that shape doesn't have an index. */
function frontPlace(shared: Y.Map<unknown>, ids: readonly string[]): Place {
  const stacked = ids.map((id) => {
    const index = (shared.get(id) as { index?: unknown } | undefined)?.index;
    return { id, index: typeof index === 'string' ? index : null };
  });
  const front = stacked.sort(backToFront).at(-1);
  return front === undefined || front.index === null ? 'front' : { above: front.id };
}

/** The groups that every shape of `ids` is in, in the order the first shape lists them. */
function sharedGroups(shared: Y.Map<unknown>, ids: readonly string[]): string[] {
  const lists = ids.map((id) => groupsOf((shared.get(id) as { groupIds?: unknown } | undefined)?.groupIds));
  const [first = [], ...rest] = lists;
  return first.filter((group) => rest.every((list) => list.includes(group)));
}
