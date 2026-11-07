import { indicesAbove } from '@chalkline/mcp/order';
import {
  CONVERTS,
  mermaidConverters,
  readRequest,
  REQUESTS,
  type Awareness,
  type MermaidRequest,
  type Point,
} from '@chalkline/sync';
import type * as Y from 'yjs';

/** The shared map that holds the board's elements by id. */
const ELEMENTS = 'elements';

/** How far below the board's lowest shape a diagram goes where its request doesn't say where. */
export const GAP = 80;

/** The transaction origin of the shapes and the request status that a page writes for a Mermaid request. */
export const CONVERTED = Symbol('chalkline.converted');

/** The fields of an Excalidraw element that the conversion reads and rewrites. */
export interface Element {
  id: string;
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  index?: string | null;
  containerId?: string | null;
  frameId?: string | null;
  groupIds?: readonly string[];
  boundElements?: readonly { id: string; type: string }[] | null;
  startBinding?: { elementId: string } | null;
  endBinding?: { elementId: string } | null;
  [field: string]: unknown;
}

/** Converts the Mermaid text of a whole diagram into Excalidraw elements, or rejects with the reason it can't. */
export type Convert = (text: string) => Promise<Element[]>;

/** What mermaid-to-excalidraw's parseMermaidToExcalidraw answers: Excalidraw skeletons, and the image it draws in their place for a kind of diagram it doesn't convert. */
export interface Parsed {
  elements: readonly unknown[];
  files?: unknown;
}

/**
 * The page's converter: `parse` reads the Mermaid text into Excalidraw
 * skeletons, as mermaid-to-excalidraw does, and `toElements` makes elements of
 * them, as Excalidraw's convertToExcalidrawElements does. It refuses a diagram
 * that mermaid-to-excalidraw draws only as an image, and one without a shape.
 */
export function mermaidConverter(
  parse: (text: string) => Promise<Parsed>,
  toElements: (skeletons: readonly unknown[]) => readonly object[],
): Convert {
  return async (text) => {
    const { elements, files } = await parse(text);
    if (typeof files === 'object' && files !== null && Object.keys(files).length > 0) {
      throw new Error(
        "mermaid-to-excalidraw draws this kind of diagram only as an image, which the board doesn't add: write a kind of diagram it converts to shapes, such as a flowchart, a sequence diagram or a class diagram.",
      );
    }
    const converted = toElements(elements) as readonly Element[];
    if (converted.length === 0) throw new Error("The diagram doesn't hold any shape to add.");
    return [...converted];
  };
}

/**
 * Copies of `elements` whose ids are `<requestId>-0`, `<requestId>-1` and on,
 * in their order, with each reference to an element among them renamed too:
 * a label's container, a frame, the elements bound to a shape and the shapes
 * an arrow's ends are bound to. Each group gets the id `<requestId>-group-<n>`.
 * Two pages that convert the same request make the same ids, so the board
 * holds one copy of the diagram.
 */
export function renameElements(requestId: string, elements: readonly Element[]): Element[] {
  const ids = new Map<string, string>();
  elements.forEach((element, place) => ids.set(element.id, `${requestId}-${place}`));
  const rename = (id: string) => ids.get(id) ?? id;
  const groups = new Map<string, string>();
  const group = (id: string) => {
    let renamed = groups.get(id);
    if (renamed === undefined) {
      renamed = `${requestId}-group-${groups.size}`;
      groups.set(id, renamed);
    }
    return renamed;
  };

  return elements.map((element) => {
    const copy: Element = { ...structuredClone(element), id: rename(element.id) };
    if (typeof element.containerId === 'string') copy.containerId = rename(element.containerId);
    if (typeof element.frameId === 'string') copy.frameId = rename(element.frameId);
    if (Array.isArray(element.groupIds)) copy.groupIds = element.groupIds.map(group);
    if (Array.isArray(element.boundElements)) {
      copy.boundElements = element.boundElements.map((bound) => ({ ...bound, id: rename(bound.id) }));
    }
    for (const end of ['startBinding', 'endBinding'] as const) {
      const binding = element[end];
      if (typeof binding === 'object' && binding !== null) copy[end] = { ...binding, elementId: rename(binding.elementId) };
    }
    return copy;
  });
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Where a diagram goes where its request doesn't say: at the left edge of the
 * board's shapes, GAP below the lowest of them, or at 0, 0 on an empty board.
 * Deleted elements, and values that aren't elements, are passed over.
 */
export function placeBelow(values: Iterable<unknown>): Point {
  let left = Number.POSITIVE_INFINITY;
  let bottom = Number.NEGATIVE_INFINITY;
  for (const value of values) {
    if (typeof value !== 'object' || value === null) continue;
    const { x, y, height, isDeleted } = value as Record<string, unknown>;
    if (isDeleted === true || !finite(x) || !finite(y) || !finite(height)) continue;
    left = Math.min(left, x);
    bottom = Math.max(bottom, y, y + height);
  }
  return Number.isFinite(left) ? { x: left, y: bottom + GAP } : { x: 0, y: 0 };
}

/** Copies of `elements` moved together so that their top left corner is at `at`. */
function moveTo(elements: readonly Element[], at: Point): Element[] {
  const left = Math.min(...elements.map((element) => element.x));
  const top = Math.min(...elements.map((element) => element.y));
  return elements.map((element) => ({ ...element, x: element.x + at.x - left, y: element.y + at.y - top }));
}

/** The ids of the shapes among `elements`, which leave out each label bound to a shape among them. */
function shapeIds(elements: readonly Element[]): string[] {
  const ids = new Set(elements.map((element) => element.id));
  return elements
    .filter((element) => !(element.type === 'text' && typeof element.containerId === 'string' && ids.has(element.containerId)))
    .map((element) => element.id);
}

type Outcome = { elements: Element[] } | { error: string };

async function outcomeOf(id: string, text: string, convert: Convert): Promise<Outcome> {
  try {
    return { elements: renameElements(id, await convert(text)) };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Carries out the Mermaid requests on the board that `doc` holds, as a page
 * does: it lists `mermaid` in this participant's awareness state under
 * CONVERTS, so that the agent's helper knows a page is in the room, and the
 * converter whose awareness client id is the lowest converts each pending
 * request with `convert`. In one transaction, it adds the diagram's elements
 * above every element on the board, at the request's `at` or below the board's
 * shapes, and sets the request's status to done with the shapes' ids, or sets
 * it to failed with the reason. It acts on the change events of the requests
 * and of the awareness states, so a page that joins converts the requests
 * written while no page was in the room, and the next page converts where the
 * converter leaves. Returns a function that stops it.
 */
export function bindRequests(doc: Y.Doc, awareness: Awareness, convert: Convert): () => void {
  const requests = doc.getMap<unknown>(REQUESTS);
  const elements = doc.getMap<unknown>(ELEMENTS);
  const working = new Set<string>();
  let stopped = false;

  const settle = async (id: string, request: MermaidRequest) => {
    const outcome = await outcomeOf(id, request.text, convert);
    // Another page may have carried out the request, or the page stopped, while this one converted it.
    if (stopped || readRequest(requests.get(id))?.status !== 'pending') return;
    doc.transact(() => {
      if ('error' in outcome) {
        requests.set(id, { ...request, status: 'failed', error: outcome.error });
        return;
      }
      const placed = moveTo(outcome.elements, request.at ?? placeBelow(elements.values()));
      const indices = indicesAbove(elements.values(), placed.length);
      placed.forEach((element, place) => elements.set(element.id, { ...element, index: indices[place] }));
      requests.set(id, { ...request, status: 'done', error: null, ids: shapeIds(placed) });
    }, CONVERTED);
  };

  const check = () => {
    if (stopped || mermaidConverters(awareness.getStates())[0] !== awareness.clientID) return;
    for (const [id, value] of requests) {
      const request = readRequest(value);
      if (request?.status !== 'pending' || working.has(id)) continue;
      working.add(id);
      void settle(id, request)
        .catch((error: unknown) => console.warn(`chalkline: couldn't carry out the Mermaid request ${id}`, error))
        .finally(() => working.delete(id));
    }
  };

  requests.observe(check);
  awareness.on('change', check);
  awareness.setLocalStateField(CONVERTS, ['mermaid']);
  check();
  return () => {
    stopped = true;
    requests.unobserve(check);
    awareness.off('change', check);
    const state = awareness.getLocalState();
    if (state !== null && CONVERTS in state) {
      const rest = { ...state };
      delete rest[CONVERTS];
      awareness.setLocalState(rest);
    }
  };
}
