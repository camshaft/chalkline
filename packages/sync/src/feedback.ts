import * as Y from 'yjs';

/** The feedback map's name in the room's Yjs document. */
export const FEEDBACK = 'feedback';

/**
 * Where a feedback stands: "open" until the agent answers it, then
 * "answered", until a person reopens it.
 */
export type FeedbackStatus = 'open' | 'answered';

const STATUSES: readonly string[] = ['open', 'answered'];

/**
 * What a record of the feedback map is: "feedback", a comment that a person writes on an area they
 * mark, or "ask", a request that a person sends with Ask an agent on the shapes they selected. A
 * record without a kind is a feedback, as each record that a page wrote before kinds is.
 */
export type FeedbackKind = 'feedback' | 'ask';

const KINDS: readonly string[] = ['feedback', 'ask'];

/** A rectangle on the board, in the board's coordinates. */
export interface Region {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The agent's answer to a feedback. */
export interface FeedbackAnswer {
  /** The agent's name. */
  by: string;
  /** When the agent answered, as an ISO 8601 time. */
  at: string;
  /** What the agent changed, in a short text. */
  text: string;
}

/**
 * A comment that a person writes on an area of the board, which every page
 * shows and the agent answers.
 */
export interface Feedback {
  /** The feedback's id, unique on the board, and its key in the map. */
  id: string;
  /** The writer's name. */
  by: string;
  /** When the person wrote it, as an ISO 8601 time. */
  at: string;
  /** What the person wrote. */
  text: string;
  /** The area the feedback is for, in the board's coordinates. */
  region: Region;
  /** The ids of the shapes that overlapped the region when the person sent it. */
  shapes: string[];
  status: FeedbackStatus;
  /**
   * The agent's answer, or null before the first one. A reopened feedback
   * keeps its answer.
   */
  answer: FeedbackAnswer | null;
  /**
   * When a person last reopened the feedback, as an ISO 8601 time, or null
   * before the first reopen. A record without it, such as one from a page that
   * doesn't record when a person reopens a feedback, reads with null.
   */
  reopened: string | null;
  /**
   * What the record is, where it says: "ask" for a request that a person sent with Ask an agent on
   * the shapes they selected, whose `shapes` are those shapes' ids and whose `region` is their
   * bounds, or "feedback". A record without a kind is a feedback, as `feedbackKind` reads it.
   */
  kind?: FeedbackKind;
}

/**
 * The board's feedback: a Y.Map from each feedback's id to its record. Each
 * change writes the whole record under its key, so of two writes of one
 * feedback the one Yjs orders last stays.
 */
export function feedbackOf(doc: Y.Doc): Y.Map<unknown> {
  return doc.getMap<unknown>(FEEDBACK);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const filled = (value: unknown): value is string => typeof value === 'string' && value.trim() !== '';

const isTime = (value: unknown): value is string => filled(value) && !Number.isNaN(Date.parse(value));

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

const isStatus = (value: unknown): value is FeedbackStatus => typeof value === 'string' && STATUSES.includes(value);

const isKind = (value: unknown): value is FeedbackKind => typeof value === 'string' && KINDS.includes(value);

function readRegion(value: unknown): Region | null {
  if (!isRecord(value)) return null;
  const { x, y, width, height } = value;
  if (!finite(x) || !finite(y) || !finite(width) || !finite(height)) return null;
  return { x, y, width, height };
}

function readAnswer(value: unknown): FeedbackAnswer | null {
  if (!isRecord(value)) return null;
  const { by, at, text } = value;
  if (!filled(by) || !isTime(at) || !filled(text)) return null;
  return { by, at, text };
}

/**
 * Reads one feedback, which may come from any peer: a value that isn't an
 * object, that lacks one of the fields `id`, `by`, `at`, `text`, `region`,
 * `shapes`, `status` and `answer`, that holds one of the wrong type or a
 * blank text, or that holds a time that doesn't parse, reads as null. So does
 * a value whose `region` lacks a finite `x`, `y`, `width` or `height`, whose
 * `shapes` holds anything but text, whose `status` isn't "open" or
 * "answered", whose `answer` isn't null or a `by`, `at` and `text` that read
 * as the feedback's own do, whose `reopened` isn't null or a time that
 * parses, or whose `kind` is there and isn't "feedback" or "ask". A value
 * that lacks `reopened` reads with `reopened` null. A `kind` that the value
 * doesn't hold, or holds as undefined, is left out of the record, which
 * `feedbackKind` reads as a feedback. Other fields are left out, and the
 * record it answers is a copy.
 */
export function readFeedback(value: unknown): Feedback | null {
  if (!isRecord(value)) return null;
  const { id, by, at, text, region, shapes, status, answer, reopened, kind } = value;
  if (!filled(id) || !filled(by) || !isTime(at) || !filled(text)) return null;
  const area = readRegion(region);
  if (area === null) return null;
  if (!Array.isArray(shapes) || !shapes.every((shape) => typeof shape === 'string')) return null;
  if (!isStatus(status)) return null;
  let reply: FeedbackAnswer | null = null;
  if (answer !== null) {
    reply = readAnswer(answer);
    if (reply === null) return null;
  }
  if (reopened !== undefined && reopened !== null && !isTime(reopened)) return null;
  const opened = isTime(reopened) ? reopened : null;
  const record: Feedback = { id, by, at, text, region: area, shapes: [...shapes], status, answer: reply, reopened: opened };
  if (kind !== undefined) {
    if (!isKind(kind)) return null;
    record.kind = kind;
  }
  return record;
}

/** What `record` is: its `kind`, or "feedback" where it doesn't hold one. */
export function feedbackKind(record: Pick<Feedback, 'kind'>): FeedbackKind {
  return record.kind ?? 'feedback';
}

/**
 * The feedback that `feedback` holds under `id`, or null where it doesn't
 * hold one, where its value doesn't read as a feedback, or where the value's
 * `id` isn't `id`.
 */
export function getFeedback(feedback: Y.Map<unknown>, id: string): Feedback | null {
  const record = readFeedback(feedback.get(id));
  return record !== null && record.id === id ? record : null;
}

/**
 * Every feedback of `feedback` that `getFeedback` reads under its key, in the
 * order of `at`, and of `id` where two times are equal, so that every copy
 * lists them in one order.
 */
export function listFeedback(feedback: Y.Map<unknown>): Feedback[] {
  const records: Feedback[] = [];
  for (const id of feedback.keys()) {
    const record = getFeedback(feedback, id);
    if (record !== null) records.push(record);
  }
  return records.sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * Writes `record` whole under its id, which sends it to every peer: a new
 * feedback, or a change of one, such as the reopen that `reopenFeedback`
 * writes. It keeps only the record's fields, as a copy.
 * Where the record doesn't read as a feedback, it throws a TypeError and
 * doesn't write anything, so that a writer doesn't make a feedback absent
 * for every reader.
 */
export function writeFeedback(feedback: Y.Map<unknown>, record: Feedback): void {
  const value = readFeedback(record);
  if (value === null) throw new TypeError(`not a feedback: ${JSON.stringify(record)}`);
  feedback.set(value.id, value);
}

/**
 * Answers the feedback that `feedback` holds under `id`: sets its `status`
 * to "answered" and its `answer` to `answer`, and returns the record as it
 * then stands. Where `getFeedback` doesn't read a feedback under `id`, it
 * returns null and doesn't write anything; where the feedback is answered
 * already, it returns the record as it stands and doesn't change it. Where
 * `answer` doesn't read as one, it throws a TypeError and doesn't write
 * anything.
 */
export function answerFeedback(feedback: Y.Map<unknown>, id: string, answer: FeedbackAnswer): Feedback | null {
  const record = getFeedback(feedback, id);
  if (record === null) return null;
  if (record.status === 'answered') return record;
  const answered = readFeedback({ ...record, status: 'answered', answer });
  if (answered === null) throw new TypeError(`not an answer: ${JSON.stringify(answer)}`);
  feedback.set(id, answered);
  return getFeedback(feedback, id);
}

/**
 * Reopens the feedback that `feedback` holds under `id`: sets its `status`
 * to "open" and its `reopened` to `at`, the time of the reopen, keeps its
 * answer, and returns the record as it then stands. Where `getFeedback`
 * doesn't read a feedback under `id`, it returns null and doesn't write
 * anything; where the feedback is open already, it returns the record as it
 * stands and doesn't change it. Where `at` isn't a time that parses, it
 * throws a TypeError and doesn't write anything.
 */
export function reopenFeedback(feedback: Y.Map<unknown>, id: string, at: string): Feedback | null {
  const record = getFeedback(feedback, id);
  if (record === null) return null;
  if (record.status === 'open') return record;
  const reopened = readFeedback({ ...record, status: 'open', reopened: at });
  if (reopened === null) throw new TypeError(`not a time: ${JSON.stringify(at)}`);
  feedback.set(id, reopened);
  return getFeedback(feedback, id);
}
