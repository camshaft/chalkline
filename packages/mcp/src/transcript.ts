import { appendEntry, newEntryId, readEntry, transcriptOf, type TranscriptEntry } from '@chalkline/sync';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  ErrorCode,
  McpError,
  SubscribeRequestSchema,
  UnsubscribeRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type * as Y from 'yjs';
import { answer, refusal } from './answer';

/** The address of the transcript's MCP resource. */
export const TRANSCRIPT_URI = 'chalkline://transcript';

/** What read_transcript answers, and what the transcript's resource holds. */
export type TranscriptRead = {
  /** The entries after the read's cursor, in the order the helper received them. */
  entries: TranscriptEntry[];
  /** The cursor after the last of them: the next read passes it to read the entries after these. */
  cursor: number;
};

const entrySchema = z.object({
  id: z.string(),
  speaker: z.string(),
  at: z.string(),
  text: z.string(),
  via: z.enum(['speech', 'typed', 'agent']),
});

/** The speaker of the agent's posts: its client, by the name it gave as it connected. */
function agentName(server: McpServer): string {
  const name = server.server.getClientVersion()?.name;
  return name !== undefined && name.trim() !== '' ? name : 'chalkline-mcp';
}

/**
 * Each entry of `entries` once, in the order of its first version: an id that comes more than once,
 * as a speech entry that its page replaced while the speaker's browser went on extending its words,
 * holds its last version, where its first stood.
 */
export function latestOf(entries: readonly TranscriptEntry[]): TranscriptEntry[] {
  const places = new Map<string, number>();
  const latest: TranscriptEntry[] = [];
  for (const entry of entries) {
    const place = places.get(entry.id);
    if (place === undefined) {
      places.set(entry.id, latest.length);
      latest.push(entry);
    } else {
      latest[place] = entry;
    }
  }
  return latest;
}

/**
 * The board's transcript as this run of the helper received it: each entry that reads as one, in
 * the order the helper's copy of the board first held it. A cursor counts these entries. The
 * transcript's own order can put an entry that a peer appended at the same time as another before
 * an entry that the agent has read already; this log puts it after, so that a read from the
 * agent's cursor answers it. An entry that a page replaced comes again with its id and its new
 * words, and counts again; a read answers each id once, with its last version, where its first
 * stood.
 */
export class TranscriptLog {
  readonly #entries: TranscriptEntry[] = [];
  /** The reads that wait for an entry. */
  readonly #waiting = new Set<() => void>();
  readonly #listeners = new Set<() => void>();

  constructor(doc: Y.Doc) {
    const transcript = transcriptOf(doc);
    this.#add(transcript.toArray());
    transcript.observe((event) => {
      this.#add(event.changes.delta.flatMap((change) => (Array.isArray(change.insert) ? change.insert : [])));
    });
  }

  /** How many entries the helper has received: the cursor at the transcript's end. */
  get length(): number {
    return this.#entries.length;
  }

  /** How many reads wait for an entry. */
  get waiting(): number {
    return this.#waiting.size;
  }

  /**
   * The entries after `cursor`, each id once with its last version, as `latestOf` answers them, and
   * the cursor after the last of them.
   */
  after(cursor: number): TranscriptRead {
    return { entries: latestOf(this.#entries.slice(cursor)), cursor: this.#entries.length };
  }

  /**
   * The entries after `cursor`: at once where the helper has received any, else on the change that
   * adds one, or with no entries once `signal` aborts.
   */
  next(cursor: number, signal: AbortSignal): Promise<TranscriptRead> {
    if (cursor < this.#entries.length || signal.aborted) return Promise.resolve(this.after(cursor));
    return new Promise((resolve) => {
      const end = (): void => {
        this.#waiting.delete(end);
        signal.removeEventListener('abort', end);
        resolve(this.after(cursor));
      };
      this.#waiting.add(end);
      signal.addEventListener('abort', end);
    });
  }

  /** Calls `listener` after each change that adds entries, until the function it answers is called. */
  onAppend(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  #add(values: unknown[]): void {
    const before = this.#entries.length;
    for (const value of values) {
      const entry = readEntry(value);
      if (entry !== null) this.#entries.push(entry);
    }
    if (this.#entries.length === before) return;
    for (const end of [...this.#waiting]) end();
    for (const listener of [...this.#listeners]) listener();
  }
}

/**
 * Adds read_transcript and post_message to `server`, and the transcript as the resource
 * chalkline://transcript, with notifications/resources/updated after each change that adds an
 * entry, to a client that subscribes to it. Call it before the server connects: it adds subscriptions to the server's resources
 * capability, which a server can't change once it is connected.
 */
export function registerTranscript(server: McpServer, doc: Y.Doc): TranscriptLog {
  const log = new TranscriptLog(doc);

  server.registerTool(
    'read_transcript',
    {
      title: "Read the board's transcript",
      description: [
        "Reads the board's transcript, which the page shows as its chat: what people on the board said or typed, and what an agent posted with post_message.",
        "It answers each entry after `cursor`, with its id, its speaker's name, its time (ISO 8601), its words, and how they came, as `via`: \"speech\" for a final speech result, \"typed\" for a message a person typed in the chat, or \"agent\" for an agent's post; and the cursor to give the next call.",
        'Where no entry follows the cursor, it answers once someone on the board says, types or posts one, or with no entries once the client cancels the call.',
        "Left out, the cursor is 0, the transcript's start.",
        'A cursor counts the entries this run of the helper has received, in the order it received them, so it holds within one run of the helper.',
        "An entry that a page replaced, as a speech entry whose words the speaker's browser went on extending, comes again with the same id and its new words; where one answer holds an entry more than once, it holds the last version alone, where the first stood.",
        `The resource ${TRANSCRIPT_URI} holds the same entries, and a client that subscribes to it is notified after each change that adds an entry.`,
      ].join(' '),
      inputSchema: { cursor: z.number().int().min(0).optional() },
      outputSchema: { entries: z.array(entrySchema), cursor: z.number().int().min(0) },
    },
    async ({ cursor = 0 }, extra) => {
      if (cursor > log.length) {
        return refusal(
          `cursor is ${cursor}, and the transcript's end is at cursor ${log.length} in this run of the helper: give a cursor that read_transcript answered, or 0 to read from the start.`,
        );
      }
      return answer(await log.next(cursor, extra.signal));
    },
  );

  server.registerTool(
    'post_message',
    {
      title: "Post a message in the board's chat",
      description: [
        "Posts `text` in the board's chat, where the people on the board read what they said and typed: it appends an entry to the transcript with the agent's name, the name its client gave as it connected, as its speaker, the time now, the words, and `via` \"agent\", and answers that entry.",
        'Every page on the board shows it in its chat, and read_transcript answers it as it answers every entry.',
        "`chalkline-mcp listen` leaves out each entry with `via` \"agent\", so the agent doesn't receive its own posts as people's words.",
      ].join(' '),
      inputSchema: { text: z.string().describe('The words to post.') },
      outputSchema: { entry: entrySchema },
    },
    ({ text }) => {
      const words = text.trim();
      if (words === '') return refusal("text is blank: give the words to post in the board's chat.");
      const entry: TranscriptEntry = {
        id: newEntryId(),
        speaker: agentName(server),
        at: new Date().toISOString(),
        text: words,
        via: 'agent',
      };
      appendEntry(transcriptOf(doc), entry);
      return answer({ entry });
    },
  );

  server.registerResource(
    'transcript',
    TRANSCRIPT_URI,
    {
      title: "The board's transcript",
      description:
        "Every entry of the board's transcript that the helper has received, in the order it received them, and the cursor after the last, as read_transcript answers them from cursor 0. A client that subscribes to it is notified after each change that adds an entry.",
      mimeType: 'application/json',
    },
    (uri) => ({ contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(log.after(0)) }] }),
  );

  let subscribed = false;
  const offered = (uri: string): void => {
    if (uri !== TRANSCRIPT_URI) {
      throw new McpError(ErrorCode.InvalidParams, `${uri} isn't a resource of the helper's: subscribe to ${TRANSCRIPT_URI}.`);
    }
  };
  server.server.registerCapabilities({ resources: { subscribe: true } });
  server.server.setRequestHandler(SubscribeRequestSchema, ({ params }) => {
    offered(params.uri);
    subscribed = true;
    return {};
  });
  server.server.setRequestHandler(UnsubscribeRequestSchema, ({ params }) => {
    offered(params.uri);
    subscribed = false;
    return {};
  });
  log.onAppend(() => {
    if (!subscribed) return;
    server.server.sendResourceUpdated({ uri: TRANSCRIPT_URI }).catch((error: unknown) => {
      console.error("the transcript's notification failed:", error);
    });
  });

  return log;
}
