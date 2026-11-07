// The helper's presence in the room (designs/chalkline A6): the agent's client's name, marked as an
// agent, its status, and a pointer at the shapes it last added or changed. Each page shows it among
// its participants and draws its cursor and name on the canvas from this state.
import { readRequest, REQUESTS, type Awareness } from '@chalkline/sync';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type * as Y from 'yjs';
import { boardElements } from './render';
import { loadExcalidraw, type Excalidraw } from './skeleton';

/** The name the helper shows where its client gives none as it connects. */
export const HELPER_NAME = 'chalkline-mcp';

/** Where the agent's cursor shows on each page, in the board's coordinates. */
export type HelperPointer = { x: number; y: number; tool: 'pointer' };

/** Whether one of the helper's tool calls runs: `working` from a call's start until no call runs. */
export type HelperStatus = 'idle' | 'working';

/** The helper's awareness state, which every participant of the room reads. */
export type HelperState = {
  /** The agent's client's name, its title where it gives one. */
  name: string;
  agent: true;
  status: HelperStatus;
  /** The center of the bounds of `shapes`, absent until the helper's first call that adds or changes shapes. */
  pointer?: HelperPointer;
  /** The ids of the shapes that the last call that added or changed shapes added or changed. */
  shapes?: string[];
};

/** The name the client gave as it connected: its title, else its name, else HELPER_NAME. */
function clientName(server: McpServer): string {
  const client = server.server.getClientVersion();
  for (const name of [client?.title, client?.name]) {
    if (name !== undefined && name.trim() !== '') return name;
  }
  return HELPER_NAME;
}

/**
 * The center of the bounds of the shapes `ids` of the board that `doc` holds, as Excalidraw's
 * getCommonBounds computes them, or undefined where the board doesn't hold any of them.
 */
async function centerOf(doc: Y.Doc, ids: readonly string[]): Promise<{ x: number; y: number } | undefined> {
  if (ids.length === 0) return undefined;
  const excalidraw = await loadExcalidraw();
  const wanted = new Set(ids);
  const elements = excalidraw
    .getNonDeletedElements(
      excalidraw.restoreElements(boardElements(doc) as unknown as Parameters<Excalidraw['restoreElements']>[0], null),
    )
    .filter((element) => wanted.has(element.id));
  if (elements.length === 0) return undefined;
  const [minX, minY, maxX, maxY] = excalidraw.getCommonBounds(elements);
  return { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
}

/**
 * Keeps the helper's awareness state: it writes the state once the client has initialized, with the
 * client's name, and again on each change of the status, the shapes or the pointer, on the events
 * that change them and never on a timer. A write that wouldn't change the state isn't made, since
 * each write goes to every peer.
 */
export class HelperPresence {
  readonly #server: McpServer;
  readonly #doc: Y.Doc;
  readonly #awareness: Awareness;
  /** The client's name, unset until the client initializes. */
  #name: string | undefined;
  /** How many tool calls run, not counting the ones that wait for an event. */
  #running = 0;
  #shapes: string[] | undefined;
  #pointer: HelperPointer | undefined;
  /** The number of the latest drew, so that an earlier one that ends later doesn't undo it. */
  #turn = 0;
  /** The Mermaid requests the helper wrote that a page hasn't carried out yet. */
  readonly #written = new Set<string>();

  constructor(server: McpServer, doc: Y.Doc, awareness: Awareness) {
    this.#server = server;
    this.#doc = doc;
    this.#awareness = awareness;
    const initialized = server.server.oninitialized;
    server.server.oninitialized = () => {
      initialized?.();
      this.#name = clientName(this.#server);
      this.#write();
    };
    // A page marks a request the helper wrote done with the ids of the diagram's shapes, whether or
    // not a call still waits on it, and the helper points at them then.
    const requests = doc.getMap<unknown>(REQUESTS);
    requests.observe(() => {
      for (const id of [...this.#written]) {
        const request = readRequest(requests.get(id));
        if (request?.status === 'pending') continue;
        this.#written.delete(id);
        if (request?.status === 'done') void this.drew(request.ids ?? []);
      }
    });
  }

  /** Runs a tool call's `work`, with the status working while it runs. */
  async run<T>(work: () => T | Promise<T>): Promise<T> {
    this.#running += 1;
    this.#write();
    try {
      return await work();
    } finally {
      this.#running -= 1;
      this.#write();
    }
  }

  /** Waits for `event` inside a running call, which doesn't count as running while it waits. */
  async waiting<T>(event: Promise<T>): Promise<T> {
    this.#running -= 1;
    this.#write();
    try {
      return await event;
    } finally {
      this.#running += 1;
      this.#write();
    }
  }

  /** Notes the Mermaid request `id` that the helper wrote, whose shapes it points at once a page adds them. */
  wrote(id: string): void {
    this.#written.add(id);
  }

  /**
   * Sets the shapes the helper last added or changed to `ids`, and moves its pointer to their
   * center; where the board doesn't hold any of them, the pointer stays where it was.
   */
  async drew(ids: readonly string[]): Promise<void> {
    this.#turn += 1;
    const turn = this.#turn;
    let center: { x: number; y: number } | undefined;
    try {
      center = await centerOf(this.#doc, ids);
    } catch (error) {
      // The shapes are on the board all the same, and the pointer stays where it was.
      console.error("couldn't find the center of the shapes the helper drew:", error);
    }
    if (turn !== this.#turn) return;
    this.#shapes = [...ids];
    if (center !== undefined) this.#pointer = { x: center.x, y: center.y, tool: 'pointer' };
    this.#write();
  }

  #write(): void {
    if (this.#name === undefined) return;
    const state: HelperState = { name: this.#name, agent: true, status: this.#running > 0 ? 'working' : 'idle' };
    if (this.#pointer !== undefined) state.pointer = this.#pointer;
    if (this.#shapes !== undefined) state.shapes = this.#shapes;
    if (JSON.stringify(this.#awareness.getLocalState()) === JSON.stringify(state)) return;
    this.#awareness.setLocalState(state);
  }
}

const presences = new WeakMap<McpServer, HelperPresence>();

/** Shows the helper of `server` in the room's presence that `awareness` holds, and answers its presence. */
export function trackPresence(server: McpServer, doc: Y.Doc, awareness: Awareness): HelperPresence {
  const presence = new HelperPresence(server, doc, awareness);
  presences.set(server, presence);
  return presence;
}

/** Runs a tool call's `work` on `server`, with the helper's status working while it runs where trackPresence tracks `server`. */
export async function running<T>(server: McpServer, work: () => T | Promise<T>): Promise<T> {
  const presence = presences.get(server);
  return presence === undefined ? await work() : presence.run(work);
}

/** Waits for `event` inside a running call on `server`, which doesn't count as running while it waits. */
export async function waiting<T>(server: McpServer, event: Promise<T>): Promise<T> {
  const presence = presences.get(server);
  return presence === undefined ? await event : presence.waiting(event);
}
