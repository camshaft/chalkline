import { answerFeedback, feedbackOf, getFeedback, listFeedback, type Feedback, type Region } from '@chalkline/sync';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type * as Y from 'yjs';
import { answer, refusal } from './answer';
import { ELEMENTS, readBoard } from './board';
import { running, waiting } from './presence';
import { boardElements } from './render';
import { boardShapeSchema, type BoardShape } from './shapes';
import { loadExcalidraw, type Excalidraw } from './skeleton';
import { subscriptionsOf } from './subscriptions';
import { agentName } from './transcript';

/** The address of the open feedback's MCP resource. */
export const FEEDBACK_URI = 'chalkline://feedback';

/** The feedback that became open after a cursor, and the cursor after the last of them. */
export type Openings = {
  /** Each feedback's record as the helper read it when it became open, in the order it received them. */
  feedback: Feedback[];
  /** The cursor after the last of them: the next read passes it to read the openings after these. */
  cursor: number;
};

/** A feedback that became open, as read_feedback answers it. */
export type Opened = {
  /** The feedback's record, as the helper read it when it became open. */
  feedback: Feedback;
  /** The board's shapes that meet the feedback's region at the read, as get_board lists them. */
  shapes: BoardShape[];
};

/** What read_feedback answers. */
export type FeedbackRead = {
  opened: Opened[];
  cursor: number;
};

/** What get_board lists of each open feedback. */
export type ListedFeedback = {
  id: string;
  by: string;
  text: string;
  region: Region;
};

const regionSchema = z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() });

const feedbackSchema = z.object({
  id: z.string(),
  by: z.string(),
  at: z.string(),
  text: z.string(),
  region: regionSchema,
  shapes: z.array(z.string()),
  status: z.enum(['open', 'answered']),
  answer: z.object({ by: z.string(), at: z.string(), text: z.string() }).nullable(),
});

/** An open feedback as get_board lists it. */
export const listedFeedbackSchema = z.object({ id: z.string(), by: z.string(), text: z.string(), region: regionSchema });

/**
 * The openings of the board's feedback as this run of the helper received them: each feedback that
 * the helper's copy of the board held as open when the log began, in listFeedback's order, then
 * each one that a change made open, a new feedback or one a person reopened, where the log last
 * read it as answered, absent or not a feedback. Each opening keeps the record as it read when it
 * became open. A cursor counts these openings.
 */
export class FeedbackLog {
  readonly #openings: Feedback[] = [];
  /** The id of each feedback that the log last read as open. */
  readonly #open = new Set<string>();
  /** The reads that wait for an opening. */
  readonly #waiting = new Set<() => void>();
  readonly #listeners = new Set<() => void>();

  constructor(doc: Y.Doc) {
    const feedback = feedbackOf(doc);
    this.#read(feedback, new Set(feedback.keys()));
    feedback.observe((event) => {
      this.#read(feedback, event.keysChanged);
    });
  }

  /** How many openings the helper has received: the cursor at the log's end. */
  get length(): number {
    return this.#openings.length;
  }

  /** How many reads wait for an opening. */
  get waiting(): number {
    return this.#waiting.size;
  }

  /** The openings after `cursor`, and the cursor after the last of them. */
  after(cursor: number): Openings {
    return { feedback: this.#openings.slice(cursor), cursor: this.#openings.length };
  }

  /**
   * The openings after `cursor`: at once where the helper has received any, else on the change that
   * opens a feedback, or with none once `signal` aborts.
   */
  next(cursor: number, signal: AbortSignal): Promise<Openings> {
    if (cursor < this.#openings.length || signal.aborted) return Promise.resolve(this.after(cursor));
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

  /** Calls `listener` after each change that opens a feedback, until the function it answers is called. */
  onOpen(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /** Reads the feedback under `keys`, which a change wrote or deleted, and adds each that it opened. */
  #read(feedback: Y.Map<unknown>, keys: Set<string>): void {
    for (const id of keys) {
      if (getFeedback(feedback, id)?.status !== 'open') this.#open.delete(id);
    }
    const opened = listFeedback(feedback).filter(
      (record) => keys.has(record.id) && record.status === 'open' && !this.#open.has(record.id),
    );
    if (opened.length === 0) return;
    for (const record of opened) {
      this.#open.add(record.id);
      this.#openings.push(record);
    }
    for (const end of [...this.#waiting]) end();
    for (const listener of [...this.#listeners]) listener();
  }
}

/** The board's open feedback, in listFeedback's order. */
export function openFeedback(doc: Y.Doc): Feedback[] {
  return listFeedback(feedbackOf(doc)).filter((record) => record.status === 'open');
}

/** The board's open feedback as get_board lists it: each one's id, writer, text and region. */
export function listedFeedback(doc: Y.Doc): ListedFeedback[] {
  return openFeedback(doc).map(({ id, by, text, region }) => ({ id, by, text, region }));
}

/**
 * The board's shapes, as get_board lists them, whose bounds meet each of `regions`, edges included:
 * one list for each region, in its order. A shape's bounds are Excalidraw's, with its rotation and
 * its points, and a shape whose label alone meets a region is listed too. A region whose width or
 * height is negative reaches left of its x or above its y.
 */
export async function shapesIn(doc: Y.Doc, regions: readonly Region[]): Promise<BoardShape[][]> {
  if (regions.length === 0) return [];
  const excalidraw = await loadExcalidraw();
  const elements = excalidraw.getNonDeletedElements(
    excalidraw.restoreElements(boardElements(doc) as unknown as Parameters<Excalidraw['restoreElements']>[0], null),
  );
  const bounds = elements.map((element) => ({
    // A label's bounds count for the shape it labels, which get_board lists in its place.
    ids:
      'containerId' in element && typeof element.containerId === 'string'
        ? [element.id, element.containerId]
        : [element.id],
    box: excalidraw.getCommonBounds([element]),
  }));
  const shapes = readBoard(doc.getMap<unknown>(ELEMENTS).values());
  return regions.map((region) => {
    const left = Math.min(region.x, region.x + region.width);
    const right = Math.max(region.x, region.x + region.width);
    const top = Math.min(region.y, region.y + region.height);
    const bottom = Math.max(region.y, region.y + region.height);
    const met = new Set<string>();
    for (const { ids, box } of bounds) {
      const [minX, minY, maxX, maxY] = box;
      if (maxX < left || minX > right || maxY < top || minY > bottom) continue;
      for (const id of ids) met.add(id);
    }
    return shapes.filter((shape) => met.has(shape.id));
  });
}

/**
 * Adds read_feedback and answer_feedback to `server`, and the open feedback as the resource
 * chalkline://feedback, with notifications/resources/updated after each change that opens a
 * feedback, to a client that subscribes to it. Call it before the server connects, as
 * registerTranscript says.
 */
export function registerFeedback(server: McpServer, doc: Y.Doc): FeedbackLog {
  const log = new FeedbackLog(doc);

  server.registerTool(
    'read_feedback',
    {
      title: "Read the people's feedback on areas of the board",
      description: [
        'Reads the feedback that people write on areas of the board: each feedback that became open after `cursor`, a new one or one a person reopened, in the order the helper received them.',
        "Each comes with its record as the helper read it when it became open: its id, its writer as `by`, its time (ISO 8601), its text, its region in the units get_board reads, the ids of the shapes that met the region when the person sent it, its status, and the agent's last answer or null; and with the board's shapes that meet its region now, as get_board lists them.",
        'It answers the cursor to pass to the next call. Where no feedback became open after the cursor, it answers once a person writes or reopens one, or with none once the client cancels the call.',
        "Left out, the cursor is 0, the log's start, which holds each feedback that was open when the helper joined the board.",
        'A cursor counts the openings this run of the helper has received, so it holds within one run of the helper.',
        'Change the board for a feedback with the drawing tools, then answer it with answer_feedback.',
        `The resource ${FEEDBACK_URI} holds the open feedback, and a client that subscribes to it is notified after each change that opens one.`,
      ].join(' '),
      inputSchema: { cursor: z.number().int().min(0).optional() },
      outputSchema: {
        opened: z.array(z.object({ feedback: feedbackSchema, shapes: z.array(boardShapeSchema) })),
        cursor: z.number().int().min(0),
      },
    },
    ({ cursor = 0 }, extra) =>
      running(server, async () => {
        if (cursor > log.length) {
          return refusal(
            `cursor is ${cursor}, and the feedback's end is at cursor ${log.length} in this run of the helper: give a cursor that read_feedback answered, or 0 to read from the start.`,
          );
        }
        // The time the call waits for a feedback to open doesn't count as working.
        const { feedback, cursor: end } = await waiting(server, log.next(cursor, extra.signal));
        const shapes = await shapesIn(
          doc,
          feedback.map((record) => record.region),
        );
        const read: FeedbackRead = {
          opened: feedback.map((record, index) => ({ feedback: record, shapes: shapes[index] ?? [] })),
          cursor: end,
        };
        return answer(read);
      }),
  );

  server.registerTool(
    'answer_feedback',
    {
      title: 'Answer a feedback',
      description: [
        'Answers a feedback, by its id, with a short text of what the agent changed for it: it sets the feedback\'s status to "answered" and its answer to the agent\'s name, the name its client gave as it connected, the time now and the text, which every page shows beside the feedback, and answers the record.',
        'A person who wants more reopens the feedback, which read_feedback then answers again.',
        'On a feedback answered already, it answers the record as it stands and changes nothing.',
        "It refuses an id that isn't a feedback's on the board, and lists the open feedback's ids in the refusal.",
      ].join(' '),
      inputSchema: {
        id: z.string().describe("The feedback's id, as read_feedback and get_board list it."),
        text: z.string().describe('What the agent changed for the feedback, in a short text.'),
      },
      outputSchema: { feedback: feedbackSchema },
    },
    ({ id, text }) =>
      running(server, () => {
        const words = text.trim();
        if (words === '') return refusal('text is blank: give a short text of what you changed for the feedback.');
        const record = answerFeedback(feedbackOf(doc), id, {
          by: agentName(server),
          at: new Date().toISOString(),
          text: words,
        });
        if (record === null) {
          const open = openFeedback(doc).map((each) => JSON.stringify(each.id));
          return refusal(
            `id is ${JSON.stringify(id)}, which isn't the id of a feedback on the board: ${
              open.length === 0 ? "the board doesn't hold an open feedback" : `the open feedback's ids are ${open.join(', ')}`
            }.`,
          );
        }
        return answer({ feedback: record });
      }),
  );

  server.registerResource(
    'feedback',
    FEEDBACK_URI,
    {
      title: "The board's open feedback",
      description:
        "Each open feedback of the board, in the order of its time, with its record as read_feedback answers it, and the cursor at the end of read_feedback's openings. A client that subscribes to it is notified after each change that opens a feedback.",
      mimeType: 'application/json',
    },
    (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: 'application/json',
          text: JSON.stringify({ feedback: openFeedback(doc), cursor: log.length }),
        },
      ],
    }),
  );

  const subscriptions = subscriptionsOf(server);
  subscriptions.offer(FEEDBACK_URI);
  log.onOpen(() => {
    subscriptions.updated(FEEDBACK_URI, "the feedback's notification");
  });

  return log;
}
