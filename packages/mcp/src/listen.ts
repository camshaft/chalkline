import type { TranscriptEntry, Transport } from '@chalkline/sync';
import type * as Y from 'yjs';
import { ELEMENTS, finite, stringOf } from './board';
import { agentWordsOf, changerOf, creatorOf } from './creator';
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
 * group.
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
    group.push(...said);
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

/** A line that `chalkline-mcp listen` prints. */
export type Line = Heard | Written | Sketched;

/**
 * How long a person's text, or the strokes they draw, stay unchanged before a line tells of them,
 * where `--board-pause` doesn't set another length, in milliseconds.
 */
export const BOARD_PAUSE_MS = 3000;

export interface BoardListenOptions<T> {
  /**
   * When the listener started, in milliseconds since the epoch: a text or a stroke that a person
   * last changed at or before this time is left out.
   */
  after: number;
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
 * The words of the text that `value` holds, when its page last changed it, whether an agent's
 * helper made that change, as the element's change mark records it, and whether the words are the
 * ones the mark records an agent wrote, where it holds a text with words.
 */
function writtenOf(value: unknown): { words: string; updated: number; byAgent: boolean; agentWrote: boolean } | undefined {
  const fields = liveElement(value);
  if (fields === undefined || fields.type !== 'text') return undefined;
  const words = stringOf(fields.originalText) ?? stringOf(fields.text);
  if (words === undefined || words.trim() === '') return undefined;
  return {
    words,
    updated: fields.updated,
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
 * The part of the board that the person's freehand stroke `value` covers, and when they last
 * changed it, where it holds one: the bounds of its points, or its x, y, width and height where
 * its points don't read as points. A stroke that an agent drew, which holds its creator mark, and
 * a stroke whose last change an agent's helper made, as its change mark records it, aren't a
 * person's.
 */
function strokeOf(value: unknown): { box: Box; updated: number } | undefined {
  const fields = liveElement(value);
  if (fields === undefined || fields.type !== 'freedraw') return undefined;
  if (creatorOf(value) !== undefined || changerOf(value) !== undefined) return undefined;
  const { x, y, width, height } = fields;
  if (!finite(x) || !finite(y)) return undefined;
  const points = pointsOf(fields.points);
  if (points !== undefined) {
    return { box: around(points.map(([px, py]): [number, number] => [x + px, y + py])), updated: fields.updated };
  }
  if (!finite(width) || !finite(height)) return undefined;
  return { box: { x, y, width, height }, updated: fields.updated };
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
 * text without words are left out, and so is a text that a person last changed at or before
 * `options.after`, though the listener receives it later.
 */
export function listenTexts(doc: Y.Doc, options: BoardListenOptions<Written>): Listener {
  const elements = doc.getMap<unknown>(ELEMENTS);
  /** The words of each text the listener told of, that a person wrote before the listener started, or that an agent wrote, as its change mark records them. */
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
    if (written.byAgent || written.updated <= options.after || (written.agentWrote && !told.has(id))) {
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
 * whose last change an agent's helper made, a deleted stroke, and a stroke that a person last
 * changed at or before `options.after` are left out.
 */
export function listenSketches(doc: Y.Doc, options: BoardListenOptions<Sketched>): Listener {
  const elements = doc.getMap<unknown>(ELEMENTS);
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
    options.onLine({
      at: new Date(Math.max(...drawn.map(({ updated }) => updated))).toISOString(),
      kind: 'sketch',
      ids: drawn.map(({ id }) => id),
      box: around(drawn.flatMap(({ box }) => corners(box))),
    });
  };

  const off = watchElements(elements, (id) => {
    const stroke = strokeOf(elements.get(id));
    if (stroke === undefined || stroke.updated <= options.after) return;
    strokes = strokes.filter((other) => other !== id);
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

export interface BoardListenerOptions {
  /** When the listener started, in milliseconds since the epoch: what was said, written or drawn at or before it is left out. */
  after: number;
  /** How long a pause after words ends their group, in milliseconds. */
  pauseMs: number;
  /** How long a text or a sketch stays unchanged before its line, in milliseconds. */
  boardPauseMs: number;
  /** Called with each line. */
  print: (line: Line) => void;
}

/**
 * Listens to what people on the board that `doc` holds say, write and draw: the groups of words
 * that `listen` makes of the board's transcript, the texts that `listenTexts` tells of and the
 * sketches that `listenSketches` makes, each line to `options.print`.
 */
export function listenToBoard(doc: Y.Doc, options: BoardListenerOptions): Listener {
  const { after, pauseMs, boardPauseMs, print } = options;
  const listeners = [
    listen(new TranscriptLog(doc), { after, pauseMs, onHeard: print }),
    listenTexts(doc, { after, pauseMs: boardPauseMs, onLine: print }),
    listenSketches(doc, { after, pauseMs: boardPauseMs, onLine: print }),
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
