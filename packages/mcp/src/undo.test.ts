// undo_change through chalkline-mcp's MCP server, with a page on the same in-memory network: each
// tool that changes the board answers the id of the change it records, the page lists the change,
// and undo_change writes the board back as it was before the change, for the page too.
import { Awareness, connectAwareness, connectDoc, MemoryNetwork } from '@chalkline/sync';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { agentChangesOf, listAgentChanges, olderChangesDropped, recordAgentChange } from './agent-changes';
import { ELEMENTS } from './board';
import { createServer } from './server';

type Element = Record<string, unknown>;

interface Board {
  network: MemoryNetwork;
  /** The page's copy of the board. */
  doc: Y.Doc;
  /** The page's elements. */
  elements: Y.Map<Element>;
  /** chalkline-mcp's copy of the board. */
  helper: Y.Doc;
  /** An MCP client of chalkline-mcp's server, which connects as the agent chalkline-test. */
  client: Client;
}

const clients: Client[] = [];
const awarenesses: Awareness[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
  for (const awareness of awarenesses.splice(0)) awareness.destroy();
});

/** Delivers each message once the code that sent it yields, as a live network does. */
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

/** A page and chalkline-mcp's copy of the board on one in-memory network, and a client of chalkline-mcp. */
async function board(): Promise<Board> {
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

  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await createServer(helper, helperAwareness).connect(serverSide);
  const client = new Client({ name: 'chalkline-test', version: '0.0.0' });
  await client.connect(clientSide);
  clients.push(client);
  return { network, doc, elements: doc.getMap<Element>(ELEMENTS), helper, client };
}

async function call(client: Client, name: string, args: Element = {}): Promise<CallToolResult> {
  return (await client.callTool({ name, arguments: args })) as CallToolResult;
}

/** The structured answer of a call that the tool didn't refuse. */
function answered<T>(result: CallToolResult): T {
  expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
  return result.structuredContent as T;
}

function text(result: CallToolResult): string {
  return result.content.map((part) => (part.type === 'text' ? part.text : '')).join('');
}

/** Adds a rectangle with add_shapes, and returns its id and the id of the change. */
async function addRectangle(client: Client): Promise<{ id: string; change: string }> {
  const { ids, change } = answered<{ ids: string[]; change: string }>(
    await call(client, 'add_shapes', { shapes: [{ type: 'rectangle', x: 10, y: 20, width: 200, height: 80 }] }),
  );
  expect(ids).toHaveLength(1);
  expect(typeof change).toBe('string');
  return { id: String(ids[0]), change };
}

describe('undo_change', () => {
  it("answers the id of each change, and the page lists the agent's changes newest first", async () => {
    const { network, doc, client } = await board();
    const { ids, change: added } = answered<{ ids: string[]; change: string }>(
      await call(client, 'add_shapes', {
        shapes: [
          { type: 'rectangle', x: 10, y: 20, width: 200, height: 80 },
          { type: 'rectangle', x: 300, y: 20, width: 200, height: 80 },
        ],
      }),
    );
    expect(ids).toHaveLength(2);
    // The add stays on the list while the board shows the first rectangle as the add left it.
    const deleted = answered<{ ids: string[]; change: string }>(await call(client, 'delete_shapes', { ids: [ids[1]] }));
    expect(deleted.ids).toEqual([ids[1]]);
    expect(typeof deleted.change).toBe('string');
    expect(deleted.change).not.toBe(added);

    network.flush();
    const listed = listAgentChanges(agentChangesOf(doc));
    expect(listed.map((change) => [change.id, change.by.name, change.tool, change.summary, change.undo])).toEqual([
      [deleted.change, 'chalkline-test', 'delete_shapes', 'chalkline-test deleted 1 shape', null],
      [added, 'chalkline-test', 'add_shapes', 'chalkline-test added 2 shapes', null],
    ]);
  });

  it("drops a change from the board's list on every peer once the board no longer shows anything it wrote, and the newest still undoes", async () => {
    const { network, doc, elements, helper, client } = await board();
    const { id, change: added } = await addRectangle(client);
    network.flush();
    const shape = elements.get(id) as Element;
    const { change: moved } = answered<{ change: string }>(await call(client, 'update_shape', { id, x: Number(shape.x) + 300 }));
    network.flush();

    // The rectangle is no longer where the add left it, so the add leaves the list, on the page and on
    // chalkline-mcp's copy alike, and the list says that older changes aren't kept.
    for (const peer of [doc, helper]) {
      const changes = agentChangesOf(peer);
      expect(changes.toArray().some((value) => (value as Element).id === added)).toBe(false);
      expect(listAgentChanges(changes).map((change) => change.id)).toEqual([moved]);
      expect(olderChangesDropped(changes)).toBe(true);
    }
    const refused = await call(client, 'undo_change', { id: added });
    expect(refused.isError).toBe(true);
    expect(text(refused)).toContain('no longer shows anything it wrote');

    answered(await call(client, 'undo_change', { id: moved }));
    network.flush();
    expect(elements.get(id)).toMatchObject({ x: shape.x, y: shape.y, isDeleted: false });
  });

  it('undoes a deletion for the page, which shows the shape again, and records the undo', async () => {
    const { network, doc, elements, client } = await board();
    const { id } = await addRectangle(client);
    const { change } = answered<{ change: string }>(await call(client, 'delete_shapes', { ids: [id] }));
    network.flush();
    expect(elements.get(id)).toMatchObject({ type: 'rectangle', isDeleted: true });

    const undo = answered<{ id: string; change: string; restored: string[]; kept: unknown[] }>(
      await call(client, 'undo_change', { id: change }),
    );
    expect(undo).toMatchObject({ change, restored: [id], kept: [] });

    network.flush();
    expect(elements.get(id)).toMatchObject({ type: 'rectangle', isDeleted: false });
    const [deletion] = listAgentChanges(agentChangesOf(doc));
    expect(deletion?.id).toBe(change);
    expect(deletion?.undo).toMatchObject({ id: undo.id, change, by: 'chalkline-test', restored: [id], kept: [] });
  });

  it('undoes an addition, which deletes the shape for the page', async () => {
    const { network, elements, client } = await board();
    const { id, change } = await addRectangle(client);
    network.flush();
    expect(elements.get(id)).toMatchObject({ isDeleted: false });

    const undo = answered<{ restored: string[]; kept: unknown[] }>(await call(client, 'undo_change', { id: change }));
    expect(undo).toMatchObject({ restored: [id], kept: [] });
    network.flush();
    expect(elements.get(id)).toMatchObject({ type: 'rectangle', isDeleted: true });
  });

  it('leaves a shape that the page changed after the change as it is, and names it', async () => {
    const { network, elements, client } = await board();
    const { id, change } = await addRectangle(client);
    network.flush();
    const shape = elements.get(id) as Element;
    const moved = Number(shape.x) + 300;
    elements.set(id, { ...shape, x: moved, version: Number(shape.version) + 1 });
    network.flush();

    const undo = answered<{ restored: string[]; kept: { id: string; name: string }[] }>(
      await call(client, 'undo_change', { id: change }),
    );
    expect(undo.restored).toEqual([]);
    expect(undo.kept).toEqual([{ id, name: 'a rectangle' }]);
    network.flush();
    expect(elements.get(id)).toMatchObject({ isDeleted: false, x: moved });
  });

  it("refuses a change that someone undid already, an id the board doesn't record, and another agent's change", async () => {
    const { network, doc, helper, client } = await board();
    const { change } = await addRectangle(client);
    answered(await call(client, 'undo_change', { id: change }));

    const again = await call(client, 'undo_change', { id: change });
    expect(again.isError).toBe(true);
    expect(text(again)).toContain('already');

    const missing = await call(client, 'undo_change', { id: 'missing' });
    expect(missing.isError).toBe(true);
    expect(text(missing)).toContain("doesn't record");

    const other = recordAgentChange(agentChangesOf(helper), {
      by: { kind: 'agent', name: 'Other agent' },
      tool: 'add_shapes',
      summary: 'Other agent added 1 shape',
      elements: [{ id: 'other-shape', before: null, after: { id: 'other-shape', type: 'ellipse', isDeleted: false } }],
    });
    expect(other).not.toBeNull();
    const refused = await call(client, 'undo_change', { id: String(other) });
    expect(refused.isError).toBe(true);
    expect(text(refused)).toContain("Other agent's");

    network.flush();
    const listed = listAgentChanges(agentChangesOf(doc));
    expect(listed.find((listedChange) => listedChange.id === other)?.undo).toBeNull();
  });
});
