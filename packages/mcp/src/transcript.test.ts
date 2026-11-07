import {
  appendEntry,
  Awareness,
  connectDoc,
  MemoryNetwork,
  readTranscript,
  transcriptOf,
  type TranscriptEntry,
  type TranscriptVia,
} from '@chalkline/sync';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ResourceUpdatedNotificationSchema, type CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { createServer } from './server';
import { TRANSCRIPT_URI, TranscriptLog, type TranscriptRead } from './transcript';

const entry = (id: string, speaker = 'Ada', via: TranscriptVia = 'speech'): TranscriptEntry => ({
  id,
  speaker,
  at: '2026-11-07T01:02:03.000Z',
  text: `said ${id}`,
  via,
});

/** A copy of `from`, as a peer that has synced with it holds it, whose own changes carry `clientID`. */
function copyOf(from: Y.Doc, clientID: number): Y.Doc {
  const doc = new Y.Doc();
  doc.clientID = clientID;
  Y.applyUpdate(doc, Y.encodeStateAsUpdate(from));
  return doc;
}

describe('TranscriptLog', () => {
  it("holds the board's entries, then each one appended, and leaves out a value that doesn't read as one", () => {
    const doc = new Y.Doc();
    const transcript = transcriptOf(doc);
    appendEntry(transcript, entry('one'));
    transcript.push([{ id: 'broken' }]);
    const log = new TranscriptLog(doc);
    appendEntry(transcript, entry('two'));
    transcript.push(['not an entry']);

    expect(log.after(0)).toEqual({ entries: [entry('one'), entry('two')], cursor: 2 });
    expect(log.after(1)).toEqual({ entries: [entry('two')], cursor: 2 });
    expect(log.after(2)).toEqual({ entries: [], cursor: 2 });
    expect(log.length).toBe(2);
  });

  it("answers an entry that the transcript puts before one the agent has read, after the agent's cursor", () => {
    const start = new Y.Doc();
    appendEntry(transcriptOf(start), entry('first'));
    // Ada and Grace each say something at the same time, after the first entry.
    const ada = copyOf(start, 2);
    const grace = copyOf(start, 1);
    appendEntry(transcriptOf(ada), entry('ada', 'Ada'));
    appendEntry(transcriptOf(grace), entry('grace', 'Grace'));

    const helper = copyOf(start, 3);
    const log = new TranscriptLog(helper);
    Y.applyUpdate(helper, Y.encodeStateAsUpdate(ada));
    const read = log.after(0);
    expect(read).toEqual({ entries: [entry('first'), entry('ada', 'Ada')], cursor: 2 });

    Y.applyUpdate(helper, Y.encodeStateAsUpdate(grace));
    // Yjs puts Grace's entry before Ada's, since Grace's client id is the lower of the two.
    expect(readTranscript(transcriptOf(helper)).map(({ id }) => id)).toEqual(['first', 'grace', 'ada']);
    expect(log.after(read.cursor)).toEqual({ entries: [entry('grace', 'Grace')], cursor: 3 });
  });

  it('answers at once where an entry follows the cursor', async () => {
    const doc = new Y.Doc();
    appendEntry(transcriptOf(doc), entry('one'));
    const log = new TranscriptLog(doc);

    expect(await log.next(0, new AbortController().signal)).toEqual({ entries: [entry('one')], cursor: 1 });
    expect(log.waiting).toBe(0);
  });

  it('waits for the next entry, and answers it with the cursor after it', async () => {
    const doc = new Y.Doc();
    const transcript = transcriptOf(doc);
    appendEntry(transcript, entry('one'));
    const log = new TranscriptLog(doc);
    let read: TranscriptRead | undefined;
    const waited = log.next(1, new AbortController().signal).then((value) => {
      read = value;
    });
    await Promise.resolve();
    expect(read).toBeUndefined();
    expect(log.waiting).toBe(1);

    // A value that doesn't read as an entry doesn't end the wait.
    transcript.push(['not an entry']);
    await Promise.resolve();
    expect(read).toBeUndefined();
    expect(log.waiting).toBe(1);

    appendEntry(transcript, entry('two', 'Grace'));
    await waited;
    expect(read).toEqual({ entries: [entry('two', 'Grace')], cursor: 2 });
    expect(log.waiting).toBe(0);
  });

  it('ends a wait with no entries once its signal aborts, and stops waiting', async () => {
    const log = new TranscriptLog(new Y.Doc());
    const controller = new AbortController();
    const waited = log.next(0, controller.signal);
    expect(log.waiting).toBe(1);

    controller.abort();
    expect(await waited).toEqual({ entries: [], cursor: 0 });
    expect(log.waiting).toBe(0);
    expect(await log.next(0, controller.signal)).toEqual({ entries: [], cursor: 0 });
    expect(log.waiting).toBe(0);
  });

  it('calls a listener once for each change that adds entries, until it stops', () => {
    const doc = new Y.Doc();
    const transcript = transcriptOf(doc);
    const log = new TranscriptLog(doc);
    let calls = 0;
    const stop = log.onAppend(() => {
      calls += 1;
    });
    doc.transact(() => {
      appendEntry(transcript, entry('one'));
      appendEntry(transcript, entry('two'));
    });
    transcript.push(['not an entry']);
    expect(calls).toBe(1);

    stop();
    appendEntry(transcript, entry('three'));
    expect(calls).toBe(1);
    expect(log.length).toBe(3);
  });
});

interface Board {
  network: MemoryNetwork;
  /** The page's transcript. */
  transcript: Y.Array<unknown>;
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
 * A page whose transcript holds `entries`, and chalkline-mcp's copy of the board, on one in-memory network, with a
 * client that connects with the name `clientName`.
 */
async function board(entries: TranscriptEntry[] = [], clientName = 'chalkline-test'): Promise<Board> {
  const network = new MemoryNetwork();
  const page = new Y.Doc();
  const transcript = transcriptOf(page);
  for (const value of entries) appendEntry(transcript, value);
  connectDoc(page, network.join('page'));
  const helper = new Y.Doc();
  const awareness = new Awareness(helper);
  awareness.setLocalState(null);
  awarenesses.push(awareness);
  connectDoc(helper, network.join('helper'));
  network.flush();

  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await createServer(helper, awareness).connect(serverSide);
  const client = new Client({ name: clientName, version: '0.0.0' });
  await client.connect(clientSide);
  clients.push(client);
  return { network, transcript, client };
}

async function readTool(client: Client, args: Record<string, unknown> = {}, signal?: AbortSignal): Promise<CallToolResult> {
  return (await client.callTool({ name: 'read_transcript', arguments: args }, undefined, { signal })) as CallToolResult;
}

async function post(client: Client, words: string): Promise<CallToolResult> {
  return (await client.callTool({ name: 'post_message', arguments: { text: words } })) as CallToolResult;
}

function read(result: CallToolResult): TranscriptRead {
  expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
  return result.structuredContent as TranscriptRead;
}

function text(result: CallToolResult): string {
  return result.content.map((part) => (part.type === 'text' ? part.text : '')).join('');
}

/** The transcript's resource, as the client reads it. */
async function resource(client: Client): Promise<TranscriptRead> {
  const { contents } = await client.readResource({ uri: TRANSCRIPT_URI });
  expect(contents).toHaveLength(1);
  const [content] = contents;
  expect(content).toMatchObject({ uri: TRANSCRIPT_URI, mimeType: 'application/json' });
  return JSON.parse((content as { text: string }).text) as TranscriptRead;
}

describe('read_transcript', () => {
  it('reads the entries the page said, and then the entries after the cursor it answered', async () => {
    const { network, transcript, client } = await board([entry('one'), entry('two')]);
    const first = read(await readTool(client));
    expect(first).toEqual({ entries: [entry('one'), entry('two')], cursor: 2 });

    appendEntry(transcript, entry('three', 'Grace'));
    network.flush();
    expect(read(await readTool(client, { cursor: first.cursor }))).toEqual({
      entries: [entry('three', 'Grace')],
      cursor: 3,
    });
  });

  it('waits for the next entry, and answers it once the page says it', async () => {
    const { network, transcript, client } = await board([entry('one')]);
    let answered = false;
    const waiting = readTool(client, { cursor: 1 }).then((result) => {
      answered = true;
      return result;
    });
    // A second read, which answers at once, comes back while the first still waits.
    expect(read(await readTool(client, { cursor: 0 }))).toEqual({ entries: [entry('one')], cursor: 1 });
    expect(answered).toBe(false);

    appendEntry(transcript, entry('two', 'Grace'));
    network.flush();
    expect(read(await waiting)).toEqual({ entries: [entry('two', 'Grace')], cursor: 2 });
  });

  it('stops waiting once the client cancels the call', async () => {
    const { network, transcript, client } = await board([entry('one')]);
    const controller = new AbortController();
    const cancelled = readTool(client, { cursor: 1 }, controller.signal);
    expect(read(await readTool(client, { cursor: 0 }))).toEqual({ entries: [entry('one')], cursor: 1 });
    controller.abort();
    await expect(cancelled).rejects.toThrow();

    appendEntry(transcript, entry('two', 'Grace'));
    network.flush();
    expect(read(await readTool(client, { cursor: 1 }))).toEqual({ entries: [entry('two', 'Grace')], cursor: 2 });
  });

  it("answers each entry's `via`, and an entry written before the chat, without `via`, as speech", async () => {
    const { network, transcript, client } = await board([entry('typed', 'Ada', 'typed'), entry('posted', 'claude-code', 'agent')]);
    const { id, speaker, at, text: words } = entry('old', 'Grace');
    transcript.push([{ id, speaker, at, text: words }]);
    network.flush();

    const answered = read(await readTool(client));
    expect(answered.entries.map((answer) => `${answer.id}: ${answer.via}`)).toEqual([
      'typed: typed',
      'posted: agent',
      'old: speech',
    ]);
    expect(answered.entries[2]).toEqual(entry('old', 'Grace'));
    expect(await resource(client)).toEqual(answered);
  });

  it('refuses a cursor past the transcript\'s end', async () => {
    const { client } = await board([entry('one')]);
    const result = await readTool(client, { cursor: 2 });
    expect(result.isError).toBe(true);
    expect(text(result)).toBe(
      "cursor is 2, and the transcript's end is at cursor 1 in this run of the helper: give a cursor that read_transcript answered, or 0 to read from the start.",
    );
  });
});

describe('post_message', () => {
  it("appends the agent's message under its client's name, which the page receives and read_transcript answers", async () => {
    const { network, transcript, client } = await board([entry('one')]);
    const before = Date.now();
    const result = await post(client, '  I drew a box  ');
    expect(result.isError, text(result)).not.toBe(true);
    const posted = (result.structuredContent as { entry: TranscriptEntry }).entry;

    expect(posted).toMatchObject({ speaker: 'chalkline-test', text: 'I drew a box', via: 'agent' });
    expect(posted.id).toMatch(/^[0-9a-f]{16}$/);
    expect(Date.parse(posted.at)).toBeGreaterThanOrEqual(before);
    expect(Date.parse(posted.at)).toBeLessThanOrEqual(Date.now());
    network.flush();
    expect(readTranscript(transcript)).toEqual([entry('one'), posted]);
    expect(read(await readTool(client, { cursor: 1 }))).toEqual({ entries: [posted], cursor: 2 });
  });

  it('posts under chalkline-mcp where the client gave a blank name', async () => {
    const { client } = await board([], '  ');
    const result = await post(client, 'hello');
    expect(result.isError, text(result)).not.toBe(true);

    expect((result.structuredContent as { entry: TranscriptEntry }).entry.speaker).toBe('chalkline-mcp');
  });

  it('refuses a blank message, and appends nothing', async () => {
    const { network, transcript, client } = await board();
    const result = await post(client, '   ');

    expect(result.isError).toBe(true);
    expect(text(result)).toBe("text is blank: give the words to post in the board's chat.");
    network.flush();
    expect(transcript.length).toBe(0);
  });
});

describe('the transcript resource', () => {
  it('holds every entry and the cursor after them, and notifies a subscribed client after each new entry', async () => {
    const { network, transcript, client } = await board([entry('one')]);
    const { resources } = await client.listResources();
    expect(resources.map(({ uri }) => uri)).toEqual([TRANSCRIPT_URI]);
    expect(await resource(client)).toEqual({ entries: [entry('one')], cursor: 1 });

    const updated: string[] = [];
    client.setNotificationHandler(ResourceUpdatedNotificationSchema, ({ params }) => {
      updated.push(params.uri);
    });
    await client.subscribeResource({ uri: TRANSCRIPT_URI });
    appendEntry(transcript, entry('two', 'Grace'));
    network.flush();
    expect(await resource(client)).toEqual({ entries: [entry('one'), entry('two', 'Grace')], cursor: 2 });
    expect(updated).toEqual([TRANSCRIPT_URI]);

    await client.unsubscribeResource({ uri: TRANSCRIPT_URI });
    appendEntry(transcript, entry('three'));
    network.flush();
    expect((await resource(client)).cursor).toBe(3);
    expect(updated).toEqual([TRANSCRIPT_URI]);
  });

  it("refuses a subscription to a resource the helper doesn't offer", async () => {
    const { client } = await board();
    await expect(client.subscribeResource({ uri: 'chalkline://board' })).rejects.toThrow(
      "chalkline://board isn't a resource of the helper's",
    );
  });
});
