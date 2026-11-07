import {
  appendEntry,
  Awareness,
  connectAwareness,
  connectDoc,
  CONVERTS,
  MemoryNetwork,
  newEntryId,
  readRequest,
  REQUESTS,
  transcriptOf,
} from '@chalkline/sync';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { Resvg } from '@resvg/resvg-js';
import { afterEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { ELEMENTS } from './board';
import { HELPER_NAME, type HelperState } from './presence';
import { createServer } from './server';

type Element = Record<string, unknown>;

const clients: Client[] = [];
const awarenesses: Awareness[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
  for (const awareness of awarenesses.splice(0)) awareness.destroy();
});

/**
 * Delivers each message once the code that sent it yields, as a live network does, so that a
 * tool's call can wait on an answer from the page.
 */
function deliverSoon(network: MemoryNetwork): void {
  const deliver = network.deliver.bind(network);
  let queued = false;
  network.deliver = (...args: Parameters<MemoryNetwork['deliver']>) => {
    deliver(...args);
    if (queued) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      network.flush();
    });
  };
}

/** The helper's awareness state. */
function stateOf(awareness: Awareness): HelperState | null {
  return awareness.getLocalState() as HelperState | null;
}

/** Resolves with the helper's state once `test` holds of it, read at once and on each change of `awareness`. */
function helperState(awareness: Awareness, test: (state: HelperState | null) => boolean): Promise<HelperState | null> {
  return new Promise((resolve) => {
    const check = () => {
      const state = stateOf(awareness);
      if (!test(state)) return;
      awareness.off('change', check);
      resolve(state);
    };
    awareness.on('change', check);
    check();
  });
}

/** The statuses the helper's state takes, in order, each one once each time it changes to it. */
function statusesOf(awareness: Awareness): string[] {
  const seen: string[] = [];
  awareness.on('change', () => {
    const status = stateOf(awareness)?.status;
    if (status !== undefined && status !== seen.at(-1)) seen.push(status);
  });
  return seen;
}

/** Resolves once `seen` holds `count` statuses, on the change of `awareness` that adds the last. */
async function untilSeen(awareness: Awareness, seen: string[], count: number): Promise<void> {
  await helperState(awareness, () => seen.length >= count);
}

/**
 * A page and chalkline-mcp's copy of the board on one in-memory network, and an MCP client of
 * the helper that gives `info` as it connects. It answers once the helper shows in the room.
 */
async function board(info: { name: string; title?: string } = { name: 'chalkline-test' }) {
  const network = new MemoryNetwork();
  deliverSoon(network);
  const doc = new Y.Doc();
  const awareness = new Awareness(doc);
  const pagePeer = network.join('page');
  connectDoc(doc, pagePeer);
  connectAwareness(awareness, pagePeer);
  const helper = new Y.Doc();
  const helperAwareness = new Awareness(helper);
  helperAwareness.setLocalState(null);
  awarenesses.push(awareness, helperAwareness);
  const helperPeer = network.join('helper');
  connectDoc(helper, helperPeer);
  connectAwareness(helperAwareness, helperPeer);
  network.flush();

  const statuses = statusesOf(helperAwareness);
  const shown = helperState(helperAwareness, (state) => state !== null);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await createServer(helper, helperAwareness).connect(serverSide);
  const client = new Client({ version: '0.0.0', ...info });
  await client.connect(clientSide);
  clients.push(client);
  await shown;
  return { network, doc, elements: doc.getMap<Element>(ELEMENTS), awareness, helperAwareness, client, statuses };
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const result = (await client.callTool({ name, arguments: args })) as CallToolResult;
  expect(result.isError).toBeFalsy();
  return result.structuredContent as Record<string, unknown>;
}

/** A rectangle as a page's Excalidraw writes it. */
function rectangle(id: string, x: number, y: number, width: number, height: number): Element {
  return {
    id,
    type: 'rectangle',
    x,
    y,
    width,
    height,
    angle: 0,
    strokeColor: '#1e1e1e',
    backgroundColor: 'transparent',
    fillStyle: 'solid',
    strokeWidth: 2,
    strokeStyle: 'solid',
    roughness: 1,
    opacity: 100,
    groupIds: [],
    frameId: null,
    roundness: null,
    seed: 1,
    version: 1,
    versionNonce: 1,
    isDeleted: false,
    boundElements: null,
    updated: 1,
    link: null,
    locked: false,
  };
}

/** Two rectangles whose bounds run from 0, 0 to 300, 200, whose center is 150, 100. */
const TWO_BOXES = [
  { type: 'rectangle', x: 0, y: 0, width: 100, height: 50 },
  { type: 'rectangle', x: 200, y: 100, width: 100, height: 100 },
];

describe("the helper's presence", () => {
  it("shows the client's name, marked as an agent, idle, once the client initializes, and reaches the page", async () => {
    const { network, awareness, helperAwareness, statuses } = await board();

    expect(stateOf(helperAwareness)).toEqual({ name: 'chalkline-test', agent: true, status: 'idle' });
    expect(statuses).toEqual(['idle']);
    network.flush();
    expect(awareness.getStates().get(helperAwareness.clientID)).toEqual({
      name: 'chalkline-test',
      agent: true,
      status: 'idle',
    });
  });

  it("shows the client's title where it gives one, and the helper's name where its name is blank", async () => {
    const titled = await board({ name: 'claude-code', title: 'Claude' });
    const blank = await board({ name: ' ' });

    expect(stateOf(titled.helperAwareness)?.name).toBe('Claude');
    expect(stateOf(blank.helperAwareness)?.name).toBe(HELPER_NAME);
  });

  it('shows working while add_shapes runs, then idle with the new shapes and the pointer at their center', async () => {
    const { client, helperAwareness, statuses } = await board();
    let answered = false;
    const adding = call(client, 'add_shapes', { shapes: TWO_BOXES }).then((added) => {
      answered = true;
      return added;
    });

    const working = await helperState(helperAwareness, (state) => state?.status === 'working');
    expect(answered).toBe(false);
    expect(working).toEqual({ name: 'chalkline-test', agent: true, status: 'working' });

    const added = await adding;
    expect(stateOf(helperAwareness)).toEqual({
      name: 'chalkline-test',
      agent: true,
      status: 'idle',
      pointer: { x: 150, y: 100, tool: 'pointer' },
      shapes: added.ids,
    });
    expect(statuses).toEqual(['idle', 'working', 'idle']);
  });

  it('leaves the shapes and the pointer as they are after reorder_shapes and delete_shapes', async () => {
    const { client, helperAwareness, statuses } = await board();
    const added = await call(client, 'add_shapes', { shapes: TWO_BOXES });
    const [first] = added.ids as string[];
    const drawn = stateOf(helperAwareness);

    await call(client, 'reorder_shapes', { ids: [first], place: 'front' });
    expect(stateOf(helperAwareness)).toEqual(drawn);
    await call(client, 'delete_shapes', { ids: [first] });
    expect(stateOf(helperAwareness)).toEqual(drawn);
    expect(statuses).toEqual(['idle', 'working', 'idle', 'working', 'idle', 'working', 'idle']);
  });

  it('points at the shapes that connect, update_shape and scale_shapes change', async () => {
    const { client, helperAwareness } = await board();
    const added = await call(client, 'add_shapes', { shapes: TWO_BOXES });
    const [left, right] = added.ids as string[];

    const connected = await call(client, 'connect', { start: left, end: right });
    expect(stateOf(helperAwareness)?.shapes).toEqual([connected.id]);

    await call(client, 'update_shape', { id: left, x: 1000, y: 1000 });
    expect(stateOf(helperAwareness)).toMatchObject({ shapes: [left], pointer: { x: 1050, y: 1025, tool: 'pointer' } });

    const scaled = await call(client, 'scale_shapes', { ids: [right], factor: 2 });
    expect(stateOf(helperAwareness)?.shapes).toEqual((scaled.shapes as { id: string }[]).map((shape) => shape.id));

    const grouped = await call(client, 'add_shapes', { shapes: TWO_BOXES, group: true });
    const moved = await call(client, 'update_shape', { group: grouped.group, x: 500, y: 500 });
    const ids = (moved.shapes as { id: string }[]).map((shape) => shape.id);
    expect(ids).toEqual(expect.arrayContaining(grouped.ids as string[]));
    expect(stateOf(helperAwareness)).toMatchObject({ shapes: ids, pointer: { x: 650, y: 600, tool: 'pointer' } });
  });

  it('shows working while add_image and flatten run, then points at the picture each places', async () => {
    const { client, helperAwareness, statuses } = await board();
    // A red picture of 40 by 20 pixels, which add_image places 80 wide and so 40 high, from 10, 20 to 90, 60.
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"><rect width="40" height="20" fill="#ff0000"/></svg>';
    const picture = new Resvg(svg).render().asPng();
    const dataUrl = `data:image/png;base64,${picture.toString('base64')}`;
    const image = await call(client, 'add_image', { data_url: dataUrl, x: 10, y: 20, width: 80 });
    expect(stateOf(helperAwareness)).toMatchObject({ status: 'idle', shapes: [image.id], pointer: { x: 50, y: 40, tool: 'pointer' } });

    // flatten deletes the two boxes and places its picture over the region it drew, so the pointer goes to that region's center.
    const added = await call(client, 'add_shapes', { shapes: TWO_BOXES });
    const flat = await call(client, 'flatten', { ids: added.ids });
    const region = flat.region as { x: number; y: number; width: number; height: number };
    expect(stateOf(helperAwareness)).toMatchObject({
      status: 'idle',
      shapes: [flat.id],
      pointer: { x: region.x + region.width / 2, y: region.y + region.height / 2, tool: 'pointer' },
    });
    expect(statuses).toEqual(['idle', 'working', 'idle', 'working', 'idle', 'working', 'idle']);
  });

  it('shows working while save_snapshot and list_snapshots run, and leaves the shapes and the pointer as they are', async () => {
    const { client, helperAwareness, statuses } = await board();
    await call(client, 'add_shapes', { shapes: TWO_BOXES });
    const drawn = stateOf(helperAwareness);

    await call(client, 'save_snapshot', { label: 'before the redesign' });
    expect(stateOf(helperAwareness)).toEqual(drawn);
    const listed = await call(client, 'list_snapshots');
    expect(listed.marks).toHaveLength(1);
    expect(stateOf(helperAwareness)).toEqual(drawn);
    expect(statuses).toEqual(['idle', 'working', 'idle', 'working', 'idle', 'working', 'idle']);
  });

  it.each(['read_transcript', 'read_changes', 'read_feedback'])(
    'shows idle while %s waits for an event, and working again until it answers once the client cancels it',
    async (tool) => {
      const { client, helperAwareness, statuses } = await board();
      const controller = new AbortController();
      const reading = client.callTool({ name: tool, arguments: {} }, undefined, { signal: controller.signal });
      const ended = reading.then(
        () => 'answered',
        () => 'cancelled',
      );

      await untilSeen(helperAwareness, statuses, 3);
      expect(statuses).toEqual(['idle', 'working', 'idle']);

      controller.abort();
      await untilSeen(helperAwareness, statuses, 5);
      expect(statuses).toEqual(['idle', 'working', 'idle', 'working', 'idle']);
      expect(await ended).toBe('cancelled');
    },
  );

  it('shows working again once a waiting read_transcript receives an entry, and idle once it answers', async () => {
    const { client, doc, helperAwareness, statuses } = await board();
    const reading = call(client, 'read_transcript');
    await untilSeen(helperAwareness, statuses, 3);

    appendEntry(transcriptOf(doc), {
      id: newEntryId(),
      speaker: 'Ada',
      at: new Date().toISOString(),
      text: 'Draw a box',
      via: 'typed',
    });
    const read = await reading;

    expect((read.entries as { text: string }[]).map((entry) => entry.text)).toEqual(['Draw a box']);
    expect(statuses).toEqual(['idle', 'working', 'idle', 'working', 'idle']);
  });

  it("shows idle while add_mermaid and get_request wait for a page, and points at the diagram's shapes once the page adds them", async () => {
    const { network, doc, elements, awareness, helperAwareness, client, statuses } = await board();
    const requests = doc.getMap<unknown>(REQUESTS);
    awareness.setLocalStateField(CONVERTS, ['mermaid']);
    network.flush();

    const adding = call(client, 'add_mermaid', { text: 'flowchart LR\n  A --> B' });
    await untilSeen(helperAwareness, statuses, 3);
    expect(statuses).toEqual(['idle', 'working', 'idle']);
    network.flush();
    const [id] = [...requests.keys()];
    expect(readRequest(requests.get(id))?.status).toBe('pending');

    const getting = call(client, 'get_request', { id });
    await untilSeen(helperAwareness, statuses, 5);
    expect(statuses).toEqual(['idle', 'working', 'idle', 'working', 'idle']);
    expect(stateOf(helperAwareness)).toEqual({ name: 'chalkline-test', agent: true, status: 'idle' });

    // The page adds the diagram's shapes, then marks the request done with their ids.
    elements.set('r-0', rectangle('r-0', 0, 0, 100, 50));
    elements.set('r-1', rectangle('r-1', 200, 100, 100, 100));
    requests.set(id, { ...(readRequest(requests.get(id)) ?? {}), status: 'done', ids: ['r-0', 'r-1'] });
    const answers = await Promise.all([adding, getting]);

    for (const answered of answers) expect(answered).toEqual({ id, status: 'done', ids: ['r-0', 'r-1'] });
    const drawn = await helperState(helperAwareness, (state) => state?.pointer !== undefined && state.status === 'idle');
    expect(drawn).toEqual({
      name: 'chalkline-test',
      agent: true,
      status: 'idle',
      pointer: { x: 150, y: 100, tool: 'pointer' },
      shapes: ['r-0', 'r-1'],
    });
  });
});
