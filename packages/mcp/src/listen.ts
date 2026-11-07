import {
  feedbackKind,
  feedbackOf,
  getFeedback,
  type Feedback,
  type FeedbackKind,
  type TranscriptEntry,
  type Transport,
} from '@chalkline/sync';
import type * as Y from 'yjs';
import { ELEMENTS, finite, stringOf } from './board';
import { agentWordsOf, changerOf, creatorOf, drawingChangedOf, drawingOf, wordsChangedOf } from './creator';
import { TranscriptLog } from './transcript';

/**
 * One line that `chalkline-mcp listen` prints: the words people on the board said or typed in the
 * chat with no pause of the listener's length between them.
 */
export type Heard = {
  /** When the group's last words were said, as the speaker's browser recorded them (ISO 8601). */
  at: string;
  /** Each person who said the group's words, once, in the order they first spoke. */
  speakers: string[];
  /** The words of the group's entries, in the order the listener received them, joined by spaces. */
  text: string;
};

/** How long a pause ends a group where `--pause` doesn't set another length, in milliseconds. */
export const PAUSE_MS = 1000;

export interface ListenOptions {
  /**
   * When the listener started, in milliseconds since the epoch: an entry said at or before this
   * time is left out.
   */
  after: number;
  /** How long a pause after an entry ends its group, in milliseconds. */
  pauseMs: number;
  /** Called with each group once the pause after it has passed. */
  onHeard: (heard: Heard) => void;
}

export interface Listener {
  /** Passes on at once the group that waits for its pause, where one does. */
  flush(): void;
  /** Stops listening, and drops the group that waits for its pause. */
  stop(): void;
}

/** The line of a group: `entries` holds at least one entry, in the order the listener received them. */
function heardOf(entries: readonly TranscriptEntry[]): Heard {
  const speakers: string[] = [];
  for (const { speaker } of entries) if (!speakers.includes(speaker)) speakers.push(speaker);
  return { at: entries[entries.length - 1].at, speakers, text: entries.map(({ text }) => text).join(' ') };
}

/**
 * Listens to the board's transcript through `log`. Each entry said after `options.after` joins the
 * group that waits for its pause, and starts the pause again; once `options.pauseMs` passes without
 * another entry, the group goes to `options.onHeard`. An entry said at or before `options.after` is
 * left out, though the listener receives it later, as a peer's copy of the board brings the
 * transcript's earlier entries. The pause counts from the moment the listener receives each entry,
 * so the entries that arrive in one change, as when the listener joins the room again, make one
 * group. An entry that comes again with the id of one in the group, as a speech entry that its page
 * replaced with longer words, takes that one's place in the group.
 */
export function listen(log: TranscriptLog, options: ListenOptions): Listener {
  let cursor = 0;
  let group: TranscriptEntry[] = [];
  let pause: ReturnType<typeof setTimeout> | undefined;

  const flush = (): void => {
    clearTimeout(pause);
    pause = undefined;
    if (group.length === 0) return;
    const heard = heardOf(group);
    group = [];
    options.onHeard(heard);
  };

  const take = (): void => {
    const read = log.after(cursor);
    cursor = read.cursor;
    // A typed message joins a group as a speech result does. An agent's post, an entry with `via` "agent", is
    // left out, so that an agent doesn't receive its own posts, or another agent's, as people's words.
    const said = read.entries.filter(({ at, via }) => via !== 'agent' && Date.parse(at) > options.after);
    if (said.length === 0) return;
    for (const entry of said) {
      const place = group.findIndex(({ id }) => id === entry.id);
      if (place === -1) {
        group.push(entry);
      } else {
        group[place] = entry;
      }
    }
    clearTimeout(pause);
    pause = setTimeout(flush, options.pauseMs);
  };

  const off = log.onAppend(take);
  take();
  return {
    flush,
    stop: () => {
      off();
      clearTimeout(pause);
      pause = undefined;
      group = [];
    },
  };
}

/** A line that `chalkline-mcp listen` prints for a text a person wrote on the board, a shape's label among them. */
export type Written = {
  /** When the person last changed the text, as their page recorded it (ISO 8601). */
  at: string;
  kind: 'text';
  /** The text's words. */
  text: string;
};

/** A part of the board, in the board's coordinates. */
export type Box = { x: number; y: number; width: number; height: number };

/** A line that `chalkline-mcp listen` prints for the freehand strokes a person drew on the board. */
export type Sketched = {
  /** When the person last changed one of the strokes, as their page recorded it (ISO 8601). */
  at: string;
  kind: 'sketch';
  /** The strokes' ids, as get_board and read_changes list them, in the order the person last changed them. */
  ids: string[];
  /** The part of the board the strokes cover. */
  box: Box;
};

/** A line that `chalkline-mcp listen` prints for a feedback that becomes open: a new one, or one a person reopens. */
export type FeedbackOpened = {
  /**
   * When the feedback became open (ISO 8601): its time, as its writer's page recorded it, for a new
   * feedback, and the time a person reopened it, as their page recorded it, for a reopened feedback.
   * Where the page that reopened it doesn't record that time, it is the time the listener received
   * the reopening.
   */
  at: string;
  /**
   * What the record is, as `feedbackKind` reads it: "ask" for an ask that a person sent with Ask
   * an agent on the shapes they selected, and "feedback" for a feedback and for a record that
   * doesn't hold a kind.
   */
  kind: FeedbackKind;
  /** The feedback's id, as read_feedback lists it, to pass to answer_feedback. */
  id: string;
  /** The writer's name. */
  by: string;
  /** What the person wrote. */
  text: string;
  /**
   * The ids of the shapes that overlapped the feedback's area when the person sent it, or, for an
   * ask, the ids of the shapes the person selected.
   */
  shapes: string[];
};

/** A line that `chalkline-mcp listen` prints. */
export type Line = Heard | Written | Sketched | FeedbackOpened;

/**
 * How long a person's text, or the strokes they draw, stay unchanged before a line tells of them,
 * where `--board-pause` doesn't set another length, in milliseconds.
 */
export const BOARD_PAUSE_MS = 3000;

export interface BoardListenOptions<T> {
  /**
   * The time a person's change has to come after, in milliseconds since the epoch: when the
   * listener started, or the earlier time that `--after` sets. A text or a stroke that a person
   * last changed at or before this time is left out.
   */
  after: number;
  /**
   * When the listener started, in milliseconds since the epoch, where `after` is an earlier time;
   * `after` where it is left out. A text whose copy doesn't record when its words last changed, as
   * a text that a page wrote before the pages recorded the words mark, is left out where the
   * listener first receives it with a change at or before this time, since a page may change such
   * a text without changing its words, as where it saves the text again. So is a freehand stroke
   * whose copy doesn't record when its place and points last changed, as a stroke that a page drew
   * before the pages recorded the drawing mark, since a page may save such a stroke again with the
   * same place and points.
   */
  start?: number;
  /** How long a text or the strokes stay unchanged before their line, in milliseconds. */
  pauseMs: number;
  /** Called with each line. */
  onLine: (line: T) => void;
}

/**
 * The fields of `value` where it is an element of the board that isn't deleted and that holds the
 * time its page last changed it.
 */
function liveElement(value: unknown): (Record<string, unknown> & { updated: number }) | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const fields = value as Record<string, unknown>;
  if (fields.isDeleted === true || !finite(fields.updated)) return undefined;
  return fields as Record<string, unknown> & { updated: number };
}

/**
 * The words of the text that `value` holds, when they last changed, as its words mark records it,
 * else when its page last changed the text, whether its words mark records that time, whether an
 * agent's helper made that change, as the element's change mark records it, and whether the words
 * are the ones the mark records an agent wrote, where it holds a text with words.
 */
function writtenOf(value: unknown): { words: string; updated: number; marked: boolean; byAgent: boolean; agentWrote: boolean } | undefined {
  const fields = liveElement(value);
  if (fields === undefined || fields.type !== 'text') return undefined;
  const words = stringOf(fields.originalText) ?? stringOf(fields.text);
  if (words === undefined || words.trim() === '') return undefined;
  const changed = wordsChangedOf(value);
  return {
    words,
    updated: changed ?? fields.updated,
    marked: changed !== undefined,
    byAgent: changerOf(value) !== undefined,
    agentWrote: words === agentWordsOf(value),
  };
}

/** The points of a freehand stroke, each relative to its x and y, where `value` holds at least one and each reads as one. */
function pointsOf(value: unknown): [number, number][] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const points: [number, number][] = [];
  for (const point of value) {
    if (!Array.isArray(point)) return undefined;
    const [x, y]: unknown[] = point;
    if (!finite(x) || !finite(y)) return undefined;
    points.push([x, y]);
  }
  return points;
}

/** The smallest box that holds each of `points`, which holds at least one point. */
function around(points: readonly (readonly [number, number])[]): Box {
  let [left, top] = points[0];
  let [right, bottom] = points[0];
  for (const [x, y] of points) {
    left = Math.min(left, x);
    top = Math.min(top, y);
    right = Math.max(right, x);
    bottom = Math.max(bottom, y);
  }
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/** The top left and bottom right corners of `box`. */
function corners({ x, y, width, height }: Box): [number, number][] {
  return [
    [x, y],
    [x + width, y + height],
  ];
}

/**
 * The part of the board that the person's freehand stroke `value` covers, when they last changed
 * its place or its points, as its drawing mark records it, else when its page last changed the
 * stroke, whether its drawing mark records that time, and the digest of its place and points, where
 * it holds one: the bounds of its points, or its x, y, width and height where its points don't read
 * as points. A stroke that an agent drew, which holds its creator mark, and a stroke whose last
 * change an agent's helper made, as its change mark records it, aren't a person's.
 */
function strokeOf(value: unknown): { box: Box; updated: number; marked: boolean; drawing: string } | undefined {
  const fields = liveElement(value);
  const drawing = drawingOf(value);
  if (fields === undefined || drawing === undefined) return undefined;
  if (creatorOf(value) !== undefined || changerOf(value) !== undefined) return undefined;
  const { x, y, width, height } = fields;
  if (!finite(x) || !finite(y)) return undefined;
  const changed = drawingChangedOf(value);
  const drawn = { updated: changed ?? fields.updated, marked: changed !== undefined, drawing };
  const points = pointsOf(fields.points);
  if (points !== undefined) {
    return { box: around(points.map(([px, py]): [number, number] => [x + px, y + py])), ...drawn };
  }
  if (!finite(width) || !finite(height)) return undefined;
  return { box: { x, y, width, height }, ...drawn };
}

/**
 * Calls `seen` with the id of each element the board holds, and then with the id of each element
 * that a change of the board sets, until the function it answers is called.
 */
function watchElements(elements: Y.Map<unknown>, seen: (id: string) => void): () => void {
  const observer = (event: Y.YMapEvent<unknown>): void => {
    for (const id of event.keysChanged) seen(id);
  };
  elements.observe(observer);
  for (const id of [...elements.keys()]) seen(id);
  return () => elements.unobserve(observer);
}

/**
 * Listens to the texts people write on the board that `doc` holds, shapes' labels among them, and
 * the changes people make to the texts an agent wrote. Once a person's text stays unchanged for
 * `options.pauseMs` after a change, its line goes to `options.onLine`, so that a text typed one key
 * at a time makes one line, and a text whose words the listener told of already, as where a person
 * moves it, doesn't make another. A change that an agent's helper made, as the element's change
 * mark records it, doesn't make a line, and the listener keeps the words the agent wrote as told,
 * so that a person's move of the agent's text doesn't make one either, though the listener first
 * receives the text after that move, as a peer's copy of the board brings it. A deleted text and a
 * text without words are left out, and so is a text whose words a person last changed at or before
 * `options.after`, as its words mark records it where the text holds one, though the listener
 * receives it later, after a move. A text whose copy doesn't record when its words last changed,
 * as a text that a page wrote before the pages recorded the words mark, is left out too where the
 * listener first receives it with a change at or before `options.start`, since a page may change
 * such a text without changing its words, as where it saves the text again; a later change of its
 * words makes a line.
 */
export function listenTexts(doc: Y.Doc, options: BoardListenOptions<Written>): Listener {
  const elements = doc.getMap<unknown>(ELEMENTS);
  const start = options.start ?? options.after;
  /**
   * The words of each text the listener told of, that a person wrote before the listener started,
   * that an agent wrote, as its change mark records them, or that the listener first received
   * without a record of when they changed, with a change at or before `start`.
   */
  const told = new Map<string, string>();
  /** The pause after each text's last change, where a line may follow it. */
  const pauses = new Map<string, ReturnType<typeof setTimeout>>();

  const settle = (id: string): void => {
    clearTimeout(pauses.get(id));
    pauses.delete(id);
  };

  const tell = (id: string): void => {
    settle(id);
    const written = writtenOf(elements.get(id));
    if (written === undefined || written.words === told.get(id)) return;
    told.set(id, written.words);
    options.onLine({ at: new Date(written.updated).toISOString(), kind: 'text', text: written.words });
  };

  const off = watchElements(elements, (id) => {
    const written = writtenOf(elements.get(id));
    settle(id);
    if (written === undefined) return;
    const unrecordedBeforeStart = !written.marked && written.updated <= start;
    if (written.byAgent || written.updated <= options.after || (!told.has(id) && (written.agentWrote || unrecordedBeforeStart))) {
      told.set(id, written.words);
      return;
    }
    pauses.set(id, setTimeout(() => tell(id), options.pauseMs));
  });

  return {
    flush: () => {
      for (const id of [...pauses.keys()]) tell(id);
    },
    stop: () => {
      off();
      for (const pause of pauses.values()) clearTimeout(pause);
      pauses.clear();
    },
  };
}

/**
 * Listens to the freehand strokes people draw on the board that `doc` holds. Once each stroke that
 * a person drew or changed since the last line stays unchanged for `options.pauseMs`, one line
 * goes to `options.onLine` with those strokes and the part of the board they cover, so that a
 * sketch of several strokes makes one line. A stroke that holds an agent's creator mark, a stroke
 * whose last change an agent's helper made, a deleted stroke, and a stroke whose place and points a
 * person last changed at or before `options.after` are left out, by the time its drawing mark
 * records where it holds one, though the listener receives it later. A stroke whose place and
 * points are those of the last line that told of it, or of the copy the listener first received
 * of a stroke it left out, doesn't make a line, so that a page's save of a stroke that leaves them
 * as they are, as where Excalidraw sets a new version or index on it, doesn't make one. A stroke
 * whose copy doesn't record when its place and points last changed, as a stroke that a page drew
 * before the pages recorded the drawing mark, is left out too where the listener first receives it
 * with a change at or before `options.start`; a later change of its place or its points makes a
 * line.
 */
export function listenSketches(doc: Y.Doc, options: BoardListenOptions<Sketched>): Listener {
  const elements = doc.getMap<unknown>(ELEMENTS);
  const start = options.start ?? options.after;
  /**
   * The digest of the place and points of each stroke a line told of, that a person last changed
   * at or before `options.after`, or that the listener first received without a record of when
   * they changed, with a change at or before `start`.
   */
  const told = new Map<string, string>();
  /** The strokes changed since the last line, in the order of their last change. */
  let strokes: string[] = [];
  let pause: ReturnType<typeof setTimeout> | undefined;

  const flush = (): void => {
    clearTimeout(pause);
    pause = undefined;
    const drawn = strokes.flatMap((id) => {
      const stroke = strokeOf(elements.get(id));
      return stroke === undefined ? [] : [{ id, ...stroke }];
    });
    strokes = [];
    if (drawn.length === 0) return;
    for (const { id, drawing } of drawn) told.set(id, drawing);
    options.onLine({
      at: new Date(Math.max(...drawn.map(({ updated }) => updated))).toISOString(),
      kind: 'sketch',
      ids: drawn.map(({ id }) => id),
      box: around(drawn.flatMap(({ box }) => corners(box))),
    });
  };

  const off = watchElements(elements, (id) => {
    const stroke = strokeOf(elements.get(id));
    if (stroke === undefined) return;
    if (stroke.updated <= options.after || (!told.has(id) && !stroke.marked && stroke.updated <= start)) {
      told.set(id, stroke.drawing);
      return;
    }
    // A stroke whose place and points are those the listener told of doesn't wait for a line, and
    // doesn't hold back the line of the others: a change back to them before the pause ends takes
    // the stroke out of the strokes changed since the last line.
    strokes = strokes.filter((other) => other !== id);
    if (stroke.drawing === told.get(id)) return;
    strokes.push(id);
    clearTimeout(pause);
    pause = setTimeout(flush, options.pauseMs);
  });

  return {
    flush,
    stop: () => {
      off();
      clearTimeout(pause);
      pause = undefined;
      strokes = [];
    },
  };
}

/**
 * The time `record`, an open feedback, became open, or undefined where it became open at or before
 * `after`. Where the record holds `reopened`, it became open then, as the page of the person who
 * reopened it recorded it. Otherwise, where `wasClosed`, as where the listener read it as answered
 * before, it became open now, as the listener receives it. Where the listener first receives it,
 * it became open at its time where no agent answered it, and now where a person reopened it after
 * an agent's answer on a page that doesn't record when; such a feedback whose answer came at or
 * before `after` returns undefined, since a person may have reopened it before `after` too.
 */
function openedAt(record: Feedback, wasClosed: boolean, after: number): string | undefined {
  if (record.reopened !== null) return Date.parse(record.reopened) > after ? record.reopened : undefined;
  if (wasClosed) return new Date().toISOString();
  if (record.answer === null) return Date.parse(record.at) > after ? record.at : undefined;
  return Date.parse(record.answer.at) > after ? new Date().toISOString() : undefined;
}

/** Orders two lines by their time. */
const byTime = (a: FeedbackOpened, b: FeedbackOpened): number => Date.parse(a.at) - Date.parse(b.at);

export interface FeedbackListenOptions {
  /**
   * The time a feedback has to become open after, in milliseconds since the epoch: when the
   * listener started, or the earlier time that `--after` sets.
   */
  after: number;
  /** Called with each line. */
  onLine: (line: FeedbackOpened) => void;
}

/**
 * Listens to the feedback people write on the board that `doc` holds. Each feedback that becomes
 * open sends its line to `options.onLine` at once: a new feedback, by its time, and a feedback a
 * person reopens after an agent's answer, by the time of the reopen that its record holds, or,
 * where the page that reopened it doesn't record that time, by the time the listener receives the
 * reopening. A feedback's other changes, such as an agent's answer, and a peer's copy of a record
 * the listener read already, don't make a line. A feedback written at or before `options.after` is
 * left out, though the listener receives it later, as a peer's copy of the board brings it, and so
 * is one reopened at or before `options.after`. So is a feedback reopened on a page that doesn't
 * record when, which the listener first receives open, where its answer came at or before
 * `options.after`, since a person may have reopened it before then too. A change that deletes a
 * feedback, or that writes a value under its id that doesn't read as a feedback, makes the listener
 * read it as not open, so that its next open copy makes a line.
 */
export function listenFeedback(doc: Y.Doc, options: FeedbackListenOptions): Listener {
  const feedback = feedbackOf(doc);
  /** Whether the listener last read each feedback as open. */
  const open = new Map<string, boolean>();

  const read = (ids: Iterable<string>): void => {
    const lines: FeedbackOpened[] = [];
    for (const id of ids) {
      const record = getFeedback(feedback, id);
      const wasOpen = open.get(id);
      if (record === null) {
        if (wasOpen !== undefined) open.set(id, false);
        continue;
      }
      open.set(id, record.status === 'open');
      if (record.status !== 'open' || wasOpen === true) continue;
      const at = openedAt(record, wasOpen === false, options.after);
      if (at === undefined) continue;
      lines.push({ at, kind: feedbackKind(record), id, by: record.by, text: record.text, shapes: record.shapes });
    }
    // The feedback that one change opens, as where a peer's copy of the board arrives, comes in the
    // order of its time.
    lines.sort(byTime);
    for (const line of lines) options.onLine(line);
  };

  const observer = (event: Y.YMapEvent<unknown>): void => read(event.keysChanged);
  feedback.observe(observer);
  read([...feedback.keys()]);
  return {
    // A feedback's line doesn't wait for a pause, so flush doesn't hold one to pass on.
    flush: () => undefined,
    stop: () => feedback.unobserve(observer),
  };
}

export interface BoardListenerOptions {
  /**
   * The time that what was said, written or drawn, and each feedback's opening, has to come after,
   * in milliseconds since the epoch: when the listener started, or the earlier time that `--after`
   * sets.
   */
  after: number;
  /** When the listener started, in milliseconds since the epoch, which `listenTexts` and `listenSketches` read as their `start`. */
  start: number;
  /** How long a pause after words ends their group, in milliseconds. */
  pauseMs: number;
  /** How long a text or a sketch stays unchanged before its line, in milliseconds. */
  boardPauseMs: number;
  /** Called with each line. */
  print: (line: Line) => void;
}

/**
 * Listens to what people on the board that `doc` holds say, write and draw, and to the feedback
 * they write: the groups of words that `listen` makes of the board's transcript, the texts that
 * `listenTexts` tells of, the sketches that `listenSketches` makes and the feedback that
 * `listenFeedback` tells of, each line to `options.print`.
 */
export function listenToBoard(doc: Y.Doc, options: BoardListenerOptions): Listener {
  const { after, start, pauseMs, boardPauseMs, print } = options;
  const listeners = [
    listen(new TranscriptLog(doc), { after, pauseMs, onHeard: print }),
    listenTexts(doc, { after, start, pauseMs: boardPauseMs, onLine: print }),
    listenSketches(doc, { after, start, pauseMs: boardPauseMs, onLine: print }),
    listenFeedback(doc, { after, onLine: print }),
  ];
  return {
    flush: () => {
      for (const listener of listeners) listener.flush();
    },
    stop: () => {
      for (const listener of listeners) listener.stop();
    },
  };
}

/** The line `watchRoom` logs as the listener's last peer leaves. */
export const LOST =
  'lost the room: no one on the board is connected, so the listener receives nothing until someone connects again';

/**
 * Logs, through `log`, each peer of `transport` that connects and leaves, where the listener loses
 * the room as its last peer leaves, and where it joins the room again as a peer connects after
 * that. What people said while the listener was away comes once a peer that holds it connects, as
 * that peer's copy of the board arrives.
 */
export function watchRoom(transport: Pick<Transport, 'onPeerJoin' | 'onPeerLeave'>, log: (line: string) => void): void {
  const peers = new Set<string>();
  let lost = false;
  transport.onPeerJoin((peerId) => {
    peers.add(peerId);
    if (lost) {
      lost = false;
      log(`joined the room again: connected to ${peerId}`);
    } else {
      log(`connected to ${peerId}`);
    }
  });
  transport.onPeerLeave((peerId) => {
    if (!peers.delete(peerId)) return;
    log(`${peerId} left`);
    if (peers.size > 0) return;
    lost = true;
    log(LOST);
  });
}
