import { Awareness, connectDoc, feedbackOf, getFeedback, MemoryNetwork, writeFeedback, type Feedback } from '@chalkline/sync';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ResourceUpdatedNotificationSchema, type CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { ELEMENTS } from './board';
import { FEEDBACK_URI, FeedbackLog, type FeedbackRead, type ListedFeedback } from './feedback';
import { createServer } from './server';

type Element = Record<string, unknown>;

/** A feedback Ada wrote on the area from (0, 0) to (200, 100), open, which `fields` change. */
const feedback = (id: string, fields: Partial<Feedback> = {}): Feedback => ({
  id,
  by: 'Ada',
  at: '2026-11-07T01:02:03.000Z',
  text: `make ${id} bigger`,
  region: { x: 0, y: 0, width: 200, height: 100 },
  shapes: [],
  status: 'open',
  answer: null,
  ...fields,
});

/** `record`, answered by an agent. */
const answered = (record: Feedback): Feedback => ({
  ...record,
  status: 'answered',
  answer: { by: 'claude-code', at: '2026-11-07T01:05:00.000Z', text: 'made it bigger' },
});

/** `record`, which a person reopened: open again, with the answer it keeps. */
const reopened = (record: Feedback): Feedback => ({ ...record, status: 'open' });

/** An element as the page draws it, with the fields Excalidraw sets on each. */
function drawn(fields: Element): Element {
  return { x: 0, y: 0, width: 100, height: 50, angle: 0, isDeleted: false, version: 1, versionNonce: 1, ...fields };
}

/**
 * A board whose region from (0, 0) to (200, 100) holds a labelled box and a rectangle whose corner
 * touches the region's corner, and whose ellipse lies far from it.
 */
const elements = (): Element[] => [
  drawn({ id: 'box', type: 'rectangle', x: 10, y: 10, index: 'a0', boundElements: [{ id: 'box-label', type: 'text' }] }),
  drawn({
    id: 'box-label',
    type: 'text',
    x: 20,
    y: 20,
    width: 40,
    height: 20,
    index: 'a1',
    text: 'Box',
    originalText: 'Box',
    containerId: 'box',
  }),
  drawn({ id: 'corner', type: 'rectangle', x: 200, y: 100, index: 'a2' }),
  drawn({ id: 'far', type: 'ellipse', x: 500, y: 500, index: 'a3' }),
];

describe('FeedbackLog', () => {
  it('holds each open feedback in the order of its time, then each one a change opens, new or reopened', () => {
    const doc = new Y.Doc();
    const map = feedbackOf(doc);
    const late = feedback('late', { at: '2026-11-07T01:02:04.000Z' });
    writeFeedback(map, late);
    writeFeedback(map, feedback('early'));
    writeFeedback(map, answered(feedback('done')));
    map.set('broken', { id: 'broken' });
    const log = new FeedbackLog(doc);
    expect(log.after(0)).toEqual({ feedback: [feedback('early'), late], cursor: 2 });

    writeFeedback(map, feedback('new'));
    // An answer, and a change of a feedback that stays open, don't open one.
    writeFeedback(map, answered(feedback('early')));
    writeFeedback(map, { ...late, text: 'make it a lot bigger' });
    writeFeedback(map, reopened(answered(feedback('done'))));
    expect(log.after(2)).toEqual({ feedback: [feedback('new'), reopened(answered(feedback('done')))], cursor: 4 });

    // The early feedback, answered, opens again as a person reopens it, and the log keeps each
    // record as it read when it opened.
    writeFeedback(map, reopened(answered(feedback('early'))));
    expect(log.after(4)).toEqual({ feedback: [reopened(answered(feedback('early')))], cursor: 5 });
    expect(log.after(0).feedback[0]).toEqual(feedback('early'));
    expect(log.length).toBe(5);
  });

  it('opens a feedback again where a value that reads as one takes the place of one that does not', () => {
    const doc = new Y.Doc();
    const map = feedbackOf(doc);
    writeFeedback(map, feedback('one'));
    const log = new FeedbackLog(doc);
    map.set('one', { id: 'one', status: 'open' });
    expect(log.length).toBe(1);
    writeFeedback(map, feedback('one'));
    expect(log.after(1)).toEqual({ feedback: [feedback('one')], cursor: 2 });
  });
});

interface Board {
  network: MemoryNetwork;
  /** The page's feedback. */
  feedback: Y.Map<unknown>;
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
 * A page whose board holds `shapes` and `records`, and chalkline-mcp's copy of the board, on one
 * in-memory network, with a client that connects with the name chalkline-test.
 */
async function board(shapes: Element[] = [], records: Feedback[] = []): Promise<Board> {
  const network = new MemoryNetwork();
  const page = new Y.Doc();
  const shared = page.getMap<Element>(ELEMENTS);
  const map = feedbackOf(page);
  page.transact(() => {
    for (const element of shapes) shared.set(String(element.id), element);
    for (const record of records) writeFeedback(map, record);
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
  return { network, feedback: map, client };
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}, signal?: AbortSignal): Promise<CallToolResult> {
  return (await client.callTool({ name, arguments: args }, undefined, { signal })) as CallToolResult;
}

function structured<T>(result: CallToolResult): T {
  expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
  return result.structuredContent as T;
}

function text(result: CallToolResult): string {
  return result.content.map((part) => (part.type === 'text' ? part.text : '')).join('');
}

/** What read_feedback answers, with the ids of each feedback's shapes in place of the shapes. */
function opened(result: CallToolResult): { opened: { feedback: Feedback; shapes: string[] }[]; cursor: number } {
  const read = structured<FeedbackRead>(result);
  return {
    opened: read.opened.map((each) => ({ feedback: each.feedback, shapes: each.shapes.map((shape) => shape.id) })),
    cursor: read.cursor,
  };
}

/** The open feedback's resource, as the client reads it. */
async function resource(client: Client): Promise<{ feedback: Feedback[]; cursor: number }> {
  const { contents } = await client.readResource({ uri: FEEDBACK_URI });
  expect(contents).toHaveLength(1);
  const [content] = contents;
  expect(content).toMatchObject({ uri: FEEDBACK_URI, mimeType: 'application/json' });
  return JSON.parse((content as { text: string }).text) as { feedback: Feedback[]; cursor: number };
}

describe('read_feedback', () => {
  it('answers each open feedback with the shapes its region meets, then a new one after the cursor it answered', async () => {
    const { network, feedback: map, client } = await board(elements(), [feedback('one', { shapes: ['box'] })]);
    const first = await call(client, 'read_feedback');
    expect(opened(first)).toEqual({ opened: [{ feedback: feedback('one', { shapes: ['box'] }), shapes: ['box', 'corner'] }], cursor: 1 });
    // The labelled box comes as get_board lists it, with its label.
    const [box] = structured<FeedbackRead>(first).opened[0]?.shapes ?? [];
    expect(box).toMatchObject({ id: 'box', kind: 'rectangle', x: 10, y: 10, width: 100, height: 50, label: 'Box' });

    // A region drawn from its bottom right corner, with a negative width and height.
    const two = feedback('two', { region: { x: 600, y: 600, width: -200, height: -200 } });
    writeFeedback(map, two);
    network.flush();
    expect(opened(await call(client, 'read_feedback', { cursor: 1 }))).toEqual({
      opened: [{ feedback: two, shapes: ['far'] }],
      cursor: 2,
    });
  });

  it('waits for a feedback, and answers one a person reopens once the page reopens it', async () => {
    const done = answered(feedback('done'));
    const { network, feedback: map, client } = await board(elements(), [done]);
    let answeredRead = false;
    const waiting = call(client, 'read_feedback').then((result) => {
      answeredRead = true;
      return result;
    });
    // Another call, which answers at once, comes back while the read still waits.
    expect(structured<{ feedback: ListedFeedback[] }>(await call(client, 'get_board')).feedback).toEqual([]);
    expect(answeredRead).toBe(false);

    writeFeedback(map, reopened(done));
    network.flush();
    expect(opened(await waiting)).toEqual({ opened: [{ feedback: reopened(done), shapes: ['box', 'corner'] }], cursor: 1 });
  });

  it('stops waiting once the client cancels the call', async () => {
    const { network, feedback: map, client } = await board([], [feedback('one')]);
    const controller = new AbortController();
    const cancelled = call(client, 'read_feedback', { cursor: 1 }, controller.signal);
    expect(opened(await call(client, 'read_feedback'))).toEqual({ opened: [{ feedback: feedback('one'), shapes: [] }], cursor: 1 });
    controller.abort();
    await expect(cancelled).rejects.toThrow();

    writeFeedback(map, feedback('two'));
    network.flush();
    expect(opened(await call(client, 'read_feedback', { cursor: 1 }))).toEqual({
      opened: [{ feedback: feedback('two'), shapes: [] }],
      cursor: 2,
    });
  });

  it("refuses a cursor past the feedback's end", async () => {
    const { client } = await board([], [feedback('one')]);
    const result = await call(client, 'read_feedback', { cursor: 2 });
    expect(result.isError).toBe(true);
    expect(text(result)).toBe(
      "cursor is 2, and the feedback's end is at cursor 1 in this run of the helper: give a cursor that read_feedback answered, or 0 to read from the start.",
    );
  });
});

describe('answer_feedback', () => {
  it("sets the answer under the client's name, which the page receives, and answers a feedback answered already as it stands", async () => {
    const { network, feedback: map, client } = await board([], [feedback('one')]);
    const before = Date.now();
    const { feedback: record } = structured<{ feedback: Feedback }>(
      await call(client, 'answer_feedback', { id: 'one', text: '  made the box bigger  ' }),
    );
    expect(record).toEqual({
      ...feedback('one'),
      status: 'answered',
      answer: { by: 'chalkline-test', at: expect.any(String), text: 'made the box bigger' },
    });
    const at = Date.parse(record.answer?.at ?? '');
    expect(at).toBeGreaterThanOrEqual(before);
    expect(at).toBeLessThanOrEqual(Date.now());
    network.flush();
    expect(getFeedback(map, 'one')).toEqual(record);

    const again = await call(client, 'answer_feedback', { id: 'one', text: 'made it red' });
    expect(structured<{ feedback: Feedback }>(again).feedback).toEqual(record);
    network.flush();
    expect(getFeedback(map, 'one')).toEqual(record);
  });

  it("refuses an id that isn't a feedback's on the board, and lists the open feedback's ids", async () => {
    const { network, feedback: map, client } = await board([], [feedback('one'), feedback('two'), answered(feedback('done'))]);
    const result = await call(client, 'answer_feedback', { id: 'missing', text: 'made it bigger' });
    expect(result.isError).toBe(true);
    expect(text(result)).toBe(
      `id is "missing", which isn't the id of a feedback on the board: the open feedback's ids are "one", "two".`,
    );
    network.flush();
    expect(map.has('missing')).toBe(false);

    const empty = await board([], [answered(feedback('done'))]);
    const none = await call(empty.client, 'answer_feedback', { id: 'missing', text: 'made it bigger' });
    expect(none.isError).toBe(true);
    expect(text(none)).toBe(`id is "missing", which isn't the id of a feedback on the board: the board doesn't hold an open feedback.`);
  });

  it('refuses a blank text, and leaves the feedback open', async () => {
    const { network, feedback: map, client } = await board([], [feedback('one')]);
    const result = await call(client, 'answer_feedback', { id: 'one', text: '   ' });
    expect(result.isError).toBe(true);
    expect(text(result)).toBe('text is blank: give a short text of what you changed for the feedback.');
    network.flush();
    expect(getFeedback(map, 'one')).toEqual(feedback('one'));
  });
});

describe('get_board', () => {
  it("lists each open feedback's id, writer, text and region, and leaves out an answered one", async () => {
    const two = feedback('two', { by: 'Grace', at: '2026-11-07T01:02:04.000Z', region: { x: 5, y: 6, width: 7, height: 8 } });
    const { client } = await board(elements(), [two, feedback('one', { shapes: ['box'] }), answered(feedback('done'))]);
    expect(structured<{ feedback: ListedFeedback[] }>(await call(client, 'get_board')).feedback).toEqual([
      { id: 'one', by: 'Ada', text: 'make one bigger', region: { x: 0, y: 0, width: 200, height: 100 } },
      { id: 'two', by: 'Grace', text: 'make two bigger', region: { x: 5, y: 6, width: 7, height: 8 } },
    ]);
  });
});

describe('the feedback resource', () => {
  it('holds the open feedback, and notifies a subscribed client after each change that opens one', async () => {
    const { network, feedback: map, client } = await board([], [feedback('one')]);
    const { resources } = await client.listResources();
    expect(resources.map(({ uri }) => uri)).toContain(FEEDBACK_URI);
    expect(await resource(client)).toEqual({ feedback: [feedback('one')], cursor: 1 });

    const updated: string[] = [];
    client.setNotificationHandler(ResourceUpdatedNotificationSchema, ({ params }) => {
      updated.push(params.uri);
    });
    await client.subscribeResource({ uri: FEEDBACK_URI });
    const two = feedback('two', { at: '2026-11-07T01:02:04.000Z' });
    writeFeedback(map, two);
    network.flush();
    expect(await resource(client)).toEqual({ feedback: [feedback('one'), two], cursor: 2 });
    expect(updated).toEqual([FEEDBACK_URI]);

    // An answer doesn't open a feedback, and a reopen does.
    const { feedback: record } = structured<{ feedback: Feedback }>(
      await call(client, 'answer_feedback', { id: 'one', text: 'made it bigger' }),
    );
    expect(await resource(client)).toEqual({ feedback: [two], cursor: 2 });
    expect(updated).toEqual([FEEDBACK_URI]);
    network.flush();
    writeFeedback(map, reopened(record));
    network.flush();
    expect(await resource(client)).toEqual({ feedback: [reopened(record), two], cursor: 3 });
    expect(updated).toEqual([FEEDBACK_URI, FEEDBACK_URI]);

    await client.unsubscribeResource({ uri: FEEDBACK_URI });
    writeFeedback(map, feedback('three', { at: '2026-11-07T01:02:05.000Z' }));
    network.flush();
    expect((await resource(client)).cursor).toBe(4);
    expect(updated).toEqual([FEEDBACK_URI, FEEDBACK_URI]);
  });

  it('takes a subscription to the transcript and to the feedback, each notified alone', async () => {
    const { network, feedback: map, client } = await board();
    const updated: string[] = [];
    client.setNotificationHandler(ResourceUpdatedNotificationSchema, ({ params }) => {
      updated.push(params.uri);
    });
    await client.subscribeResource({ uri: 'chalkline://transcript' });
    writeFeedback(map, feedback('one'));
    network.flush();
    expect((await resource(client)).cursor).toBe(1);
    expect(updated).toEqual([]);

    await client.subscribeResource({ uri: FEEDBACK_URI });
    writeFeedback(map, feedback('two'));
    network.flush();
    expect((await resource(client)).cursor).toBe(2);
    expect(updated).toEqual([FEEDBACK_URI]);
    await expect(client.subscribeResource({ uri: 'chalkline://board' })).rejects.toThrow(
      "chalkline://board isn't a resource of the helper's: subscribe to chalkline://transcript or chalkline://feedback.",
    );
  });
});
