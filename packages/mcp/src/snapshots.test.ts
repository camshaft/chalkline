import { Awareness, connectDoc, getSnapshotMark, MemoryNetwork, snapshotsOf, writeSnapshotMark, type SnapshotMark } from '@chalkline/sync';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { ELEMENTS } from './board';
import { createServer } from './server';
import { BROWSER_SNAPSHOTS } from './snapshots';

type Element = Record<string, unknown>;

/** A rectangle of the board, which `fields` change. */
const element = (id: string, fields: Element = {}): Element => ({
  id,
  type: 'rectangle',
  x: 0,
  y: 0,
  width: 100,
  height: 50,
  version: 1,
  versionNonce: 1,
  index: `a${id}`,
  isDeleted: false,
  ...fields,
});

/** A mark that claude-code saved, which `fields` change. */
const mark = (id: string, fields: Partial<SnapshotMark> = {}): SnapshotMark => ({
  id,
  by: 'claude-code',
  at: '2026-11-01T10:00:00.000Z',
  label: null,
  shapes: 1,
  ...fields,
});

interface Board {
  network: MemoryNetwork;
  /** The page's snapshot marks. */
  marks: Y.Map<unknown>;
  /** An MCP client connected to chalkline-mcp's server. */
  client: Client;
}

const clients: Client[] = [];
const awarenesses: Awareness[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
  for (const awareness of awarenesses.splice(0)) awareness.destroy();
});

/**
 * A page whose board holds `elements` and `records`, and chalkline-mcp's copy of the board, on one in-memory
 * network, with a client that connects with the name chalkline-test.
 */
async function board(elements: Element[] = [], records: SnapshotMark[] = []): Promise<Board> {
  const network = new MemoryNetwork();
  const page = new Y.Doc();
  const shared = page.getMap<Element>(ELEMENTS);
  const marks = snapshotsOf(page);
  page.transact(() => {
    for (const each of elements) shared.set(String(each.id), each);
    for (const record of records) writeSnapshotMark(marks, record);
  });
  connectDoc(page, network.join('page'));
  const helper = new Y.Doc();
  const awareness = new Awareness(helper);
  awareness.setLocalState(null);
  awarenesses.push(awareness);
  connectDoc(helper, network.join('helper'));
  network.flush();

  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await createServer(helper, awareness).connect(serverSide);
  const client = new Client({ name: 'chalkline-test', version: '0.0.0' });
  await client.connect(clientSide);
  clients.push(client);
  return { network, marks, client };
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<CallToolResult> {
  return (await client.callTool({ name, arguments: args })) as CallToolResult;
}

function structured<T>(result: CallToolResult): T {
  expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
  return result.structuredContent as T;
}

function text(result: CallToolResult): string {
  return result.content.map((part) => (part.type === 'text' ? part.text : '')).join('');
}

describe('save_snapshot', () => {
  it("writes a mark with the agent's name, the label and the board's shape count, which reaches the page", async () => {
    const { network, marks, client } = await board([
      element('box', { boundElements: [{ id: 'box-label', type: 'text' }] }),
      element('box-label', { type: 'text', containerId: 'box' }),
      element('gone', { isDeleted: true }),
      element('corner'),
    ]);

    const before = Date.now();
    const { mark: saved } = structured<{ mark: SnapshotMark }>(
      await call(client, 'save_snapshot', { label: '  before the redesign  ' }),
    );

    // The bound label and the deleted rectangle aren't shapes, so the mark counts the box and the corner.
    expect(saved).toEqual({
      id: expect.any(String),
      by: 'chalkline-test',
      at: expect.any(String),
      label: 'before the redesign',
      shapes: 2,
    });
    expect(Date.parse(saved.at)).toBeGreaterThanOrEqual(before);
    expect(Date.parse(saved.at)).toBeLessThanOrEqual(Date.now());
    network.flush();
    expect(getSnapshotMark(marks, saved.id)).toEqual(saved);
  });

  it('writes a mark without a label where the label is left out or blank, each with a new id', async () => {
    const { network, marks, client } = await board([element('box')]);

    const { mark: first } = structured<{ mark: SnapshotMark }>(await call(client, 'save_snapshot'));
    const { mark: second } = structured<{ mark: SnapshotMark }>(await call(client, 'save_snapshot', { label: '   ' }));

    expect(first.label).toBeNull();
    expect(second.label).toBeNull();
    expect(second.id).not.toBe(first.id);
    network.flush();
    expect([...marks.keys()].sort()).toEqual([first.id, second.id].sort());
  });

  it("refuses a board that doesn't have any shapes, and doesn't write a mark", async () => {
    const { network, marks, client } = await board([
      element('gone', { isDeleted: true }),
      element('box-label', { type: 'text', containerId: 'box' }),
    ]);

    const refused = await call(client, 'save_snapshot', { label: 'nothing here' });

    expect(refused.isError).toBe(true);
    expect(text(refused)).toContain("the board doesn't have any shapes");
    network.flush();
    expect(marks.size).toBe(0);
  });
});

describe('list_snapshots', () => {
  it("lists the board's marks oldest first, by time and then by id, with the note on the browsers' snapshots", async () => {
    const { network, marks, client } = await board(
      [element('box')],
      [
        mark('b', { at: '2026-11-01T11:00:00.000Z', label: 'before the redesign' }),
        mark('c', { at: '2026-11-01T10:00:00.000Z', shapes: 4 }),
        mark('a', { at: '2026-11-01T11:00:00.000Z' }),
      ],
    );
    // A value that doesn't read as a mark, as a peer could write, isn't listed.
    marks.set('broken', { id: 'broken', by: '', at: 'yesterday' });
    network.flush();

    expect(structured(await call(client, 'list_snapshots'))).toEqual({
      marks: [
        mark('c', { at: '2026-11-01T10:00:00.000Z', shapes: 4 }),
        mark('a', { at: '2026-11-01T11:00:00.000Z' }),
        mark('b', { at: '2026-11-01T11:00:00.000Z', label: 'before the redesign' }),
      ],
      note: BROWSER_SNAPSHOTS,
    });

    const { mark: saved } = structured<{ mark: SnapshotMark }>(await call(client, 'save_snapshot', { label: 'now' }));
    const listed = structured<{ marks: SnapshotMark[] }>(await call(client, 'list_snapshots'));
    expect(listed.marks.map((each) => each.id)).toEqual(['c', 'a', 'b', saved.id]);
  });

  it("answers an empty list and the note on a board that doesn't hold a mark", async () => {
    const { client } = await board([element('box')]);

    expect(structured(await call(client, 'list_snapshots'))).toEqual({ marks: [], note: BROWSER_SNAPSHOTS });
  });
});
