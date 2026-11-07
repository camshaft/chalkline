import { appendEntry, connectDoc, MemoryNetwork, transcriptOf, type TranscriptEntry, type TranscriptVia } from '@chalkline/sync';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { ELEMENTS } from './board';
import { withCreator, type Creator } from './creator';
import {
  BOARD_PAUSE_MS,
  listen,
  listenSketches,
  listenTexts,
  listenToBoard,
  LOST,
  PAUSE_MS,
  watchRoom,
  type BoardListenOptions,
  type Heard,
  type Line,
  type Listener,
  type Sketched,
  type Written,
} from './listen';
import { LISTEN_USAGE, parseListenArgs } from './listen-cli';
import { TranscriptLog } from './transcript';

/** When the listener starts in these tests. */
const START = Date.parse('2026-11-07T03:00:00.000Z');

/** The time `seconds` after the listener starts, or before it where `seconds` is below 0. */
const at = (seconds: number): string => new Date(START + seconds * 1000).toISOString();

/** An entry said, or typed or posted as `via` says, `seconds` after the listener starts. */
const said = (id: string, seconds: number, text: string, speaker = 'Ada', via: TranscriptVia = 'speech'): TranscriptEntry => ({
  id,
  speaker,
  at: at(seconds),
  text,
  via,
});

interface Listening {
  doc: Y.Doc;
  transcript: Y.Array<unknown>;
  /** Each line the listener would print, in order. */
  heard: Heard[];
  listener: Listener;
}

/** A board's copy whose transcript holds `entries`, and a listener of it that starts at `START`. */
function listening(entries: TranscriptEntry[] = [], pauseMs = PAUSE_MS): Listening {
  const doc = new Y.Doc();
  const transcript = transcriptOf(doc);
  for (const entry of entries) appendEntry(transcript, entry);
  const heard: Heard[] = [];
  const listener = listen(new TranscriptLog(doc), { after: START, pauseMs, onHeard: (line) => heard.push(line) });
  return { doc, transcript, heard, listener };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('listen', () => {
  it('leaves out each entry said before the listener started, though it arrives after the start', () => {
    const { transcript, heard } = listening([said('old', -60, 'an old request')]);
    // A peer's copy of the board brings an entry said before the start, and one said at the start.
    appendEntry(transcript, said('late', -5, 'what Grace said before', 'Grace'));
    appendEntry(transcript, said('start', 0, 'said as the listener started'));
    vi.advanceTimersByTime(10 * PAUSE_MS);
    expect(heard).toEqual([]);

    appendEntry(transcript, said('new', 1, 'draw a box'));
    vi.advanceTimersByTime(PAUSE_MS);
    expect(heard).toEqual([{ at: at(1), speakers: ['Ada'], text: 'draw a box' }]);
  });

  it('prints the entries said within the pause of each other as one line', () => {
    const { transcript, heard } = listening();
    appendEntry(transcript, said('one', 1, 'draw a smiley face', 'Ada'));
    vi.advanceTimersByTime(PAUSE_MS - 1);
    appendEntry(transcript, said('two', 2, 'in blue', 'Grace'));
    vi.advanceTimersByTime(PAUSE_MS - 1);
    appendEntry(transcript, said('three', 3, 'please', 'Ada'));
    vi.advanceTimersByTime(PAUSE_MS - 1);
    expect(heard).toEqual([]);

    vi.advanceTimersByTime(1);
    expect(heard).toEqual([{ at: at(3), speakers: ['Ada', 'Grace'], text: 'draw a smiley face in blue please' }]);
  });

  it('prints the entries said further apart than the pause as two lines', () => {
    const { transcript, heard } = listening();
    appendEntry(transcript, said('one', 1, 'draw a box'));
    vi.advanceTimersByTime(PAUSE_MS);
    expect(heard).toEqual([{ at: at(1), speakers: ['Ada'], text: 'draw a box' }]);

    appendEntry(transcript, said('two', 3, 'now an arrow to it', 'Grace'));
    vi.advanceTimersByTime(PAUSE_MS);
    expect(heard).toEqual([
      { at: at(1), speakers: ['Ada'], text: 'draw a box' },
      { at: at(3), speakers: ['Grace'], text: 'now an arrow to it' },
    ]);
  });

  it('prints a typed message as it prints speech, in one group with the words said within the pause', () => {
    const { transcript, heard } = listening();
    appendEntry(transcript, said('one', 1, 'draw a box', 'Ada'));
    appendEntry(transcript, said('two', 2, 'in red', 'Grace', 'typed'));
    vi.advanceTimersByTime(PAUSE_MS);
    expect(heard).toEqual([{ at: at(2), speakers: ['Ada', 'Grace'], text: 'draw a box in red' }]);
  });

  it("leaves out an agent's post, and prints the person's words around it", () => {
    const { transcript, heard } = listening();
    appendEntry(transcript, said('posted', 1, 'I drew a box', 'claude-code', 'agent'));
    vi.advanceTimersByTime(10 * PAUSE_MS);
    expect(heard).toEqual([]);

    appendEntry(transcript, said('typed', 2, 'thanks, now an arrow', 'Ada', 'typed'));
    appendEntry(transcript, said('again', 3, 'I drew the arrow', 'claude-code', 'agent'));
    vi.advanceTimersByTime(PAUSE_MS);
    expect(heard).toEqual([{ at: at(2), speakers: ['Ada'], text: 'thanks, now an arrow' }]);
  });

  it('prints an entry written before the chat, without `via`, as speech', () => {
    const { transcript, heard } = listening();
    transcript.push([{ id: 'old-page', speaker: 'Grace', at: at(1), text: 'draw a circle' }]);
    vi.advanceTimersByTime(PAUSE_MS);
    expect(heard).toEqual([{ at: at(1), speakers: ['Grace'], text: 'draw a circle' }]);
  });

  it('ends a group at the pause the listener is given', () => {
    const { transcript, heard } = listening([], 500);
    appendEntry(transcript, said('one', 1, 'draw a box'));
    vi.advanceTimersByTime(499);
    expect(heard).toEqual([]);

    vi.advanceTimersByTime(1);
    expect(heard).toEqual([{ at: at(1), speakers: ['Ada'], text: 'draw a box' }]);
  });

  it('prints the entries that arrive in one change as one line', () => {
    const { doc, transcript, heard } = listening();
    // As where the listener joins the room again, and a peer's copy brings what was said meanwhile.
    doc.transact(() => {
      appendEntry(transcript, said('one', 10, 'draw a box'));
      appendEntry(transcript, said('two', 40, 'and label it start', 'Grace'));
    });
    vi.advanceTimersByTime(PAUSE_MS);
    expect(heard).toEqual([{ at: at(40), speakers: ['Ada', 'Grace'], text: 'draw a box and label it start' }]);
  });

  it('prints the group that waits for its pause at once on flush, and drops it on stop', () => {
    const { transcript, heard, listener } = listening();
    listener.flush();
    expect(heard).toEqual([]);

    appendEntry(transcript, said('one', 1, 'draw a box'));
    listener.flush();
    expect(heard).toEqual([{ at: at(1), speakers: ['Ada'], text: 'draw a box' }]);
    vi.advanceTimersByTime(PAUSE_MS);
    expect(heard).toHaveLength(1);

    appendEntry(transcript, said('two', 2, 'and a circle'));
    listener.stop();
    appendEntry(transcript, said('three', 3, 'and an arrow'));
    vi.advanceTimersByTime(PAUSE_MS);
    listener.flush();
    expect(heard).toHaveLength(1);
  });

  it("receives a page's words through the board's network, and leaves out what the page held before the start", () => {
    const network = new MemoryNetwork();
    const page = new Y.Doc();
    const transcript = transcriptOf(page);
    appendEntry(transcript, said('old', -60, 'an old request'));
    connectDoc(page, network.join('page'));
    const helper = new Y.Doc();
    const heard: Heard[] = [];
    listen(new TranscriptLog(helper), { after: START, pauseMs: PAUSE_MS, onHeard: (line) => heard.push(line) });
    connectDoc(helper, network.join('listener'));
    network.flush();
    vi.advanceTimersByTime(PAUSE_MS);
    expect(heard).toEqual([]);

    appendEntry(transcript, said('one', 1, 'draw a smiley face'));
    network.flush();
    vi.advanceTimersByTime(PAUSE_MS);
    expect(heard).toEqual([{ at: at(1), speakers: ['Ada'], text: 'draw a smiley face' }]);
  });
});

/** An element of a person's page, changed `seconds` after the listener starts. */
const element = (fields: Record<string, unknown>, seconds: number): Record<string, unknown> => ({
  type: 'rectangle',
  x: 0,
  y: 0,
  width: 100,
  height: 20,
  isDeleted: false,
  version: 1,
  versionNonce: 1,
  updated: START + seconds * 1000,
  ...fields,
});

/** A text of a person's page that holds `words`, changed `seconds` after the listener starts. */
const text = (id: string, words: string, seconds: number, fields: Record<string, unknown> = {}): Record<string, unknown> =>
  element({ id, type: 'text', text: words, originalText: words, ...fields }, seconds);

/** A freehand stroke of a person's page at `x` and `y` through `points`, changed `seconds` after the listener starts. */
const stroke = (id: string, x: number, y: number, points: number[][], seconds: number): Record<string, unknown> =>
  element({ id, type: 'freedraw', x, y, points }, seconds);

/** The agent whose creator mark the agent's shapes of these tests hold. */
const claude: Creator = { kind: 'agent', name: 'Claude' };

interface Watching<T> {
  elements: Y.Map<unknown>;
  /** Each line the listener would print, in order. */
  lines: T[];
  listener: Listener;
}

/** A board's copy that holds `values`, and a listener of `kind` of it that starts at `START`. */
function watching<T>(
  kind: (doc: Y.Doc, options: BoardListenOptions<T>) => Listener,
  values: Record<string, unknown>[] = [],
  pauseMs = BOARD_PAUSE_MS,
): Watching<T> {
  const doc = new Y.Doc();
  const elements = doc.getMap<unknown>(ELEMENTS);
  for (const value of values) elements.set(String(value.id), value);
  const lines: T[] = [];
  const listener = kind(doc, { after: START, pauseMs, onLine: (line) => lines.push(line) });
  return { elements, lines, listener };
}

describe('listenTexts', () => {
  it('prints a text a person types once it stays unchanged for the pause, and again only where its words change', () => {
    const { elements, lines } = watching<Written>(listenTexts);
    // Excalidraw adds the text empty, then changes it as the person types.
    elements.set('note', text('note', '', 1));
    elements.set('note', text('note', 'Claude', 2));
    vi.advanceTimersByTime(BOARD_PAUSE_MS - 1);
    elements.set('note', text('note', 'Claude are you listening?', 3));
    vi.advanceTimersByTime(BOARD_PAUSE_MS - 1);
    expect(lines).toEqual([]);

    vi.advanceTimersByTime(1);
    expect(lines).toEqual([{ at: at(3), kind: 'text', text: 'Claude are you listening?' }]);

    // The person moves the text, which leaves its words as they were.
    elements.set('note', text('note', 'Claude are you listening?', 10, { x: 200 }));
    vi.advanceTimersByTime(BOARD_PAUSE_MS);
    expect(lines).toHaveLength(1);

    elements.set('note', text('note', 'Claude, draw a box', 20, { x: 200 }));
    vi.advanceTimersByTime(BOARD_PAUSE_MS);
    expect(lines).toEqual([
      { at: at(3), kind: 'text', text: 'Claude are you listening?' },
      { at: at(20), kind: 'text', text: 'Claude, draw a box' },
    ]);
  });

  it("prints the label a person writes on a shape, and the text's words as Excalidraw keeps them unwrapped", () => {
    const { elements, lines } = watching<Written>(listenTexts);
    elements.set('box', element({ id: 'box' }, 1));
    elements.set('label', text('label', 'start\nhere', 2, { containerId: 'box', originalText: 'start here' }));
    vi.advanceTimersByTime(BOARD_PAUSE_MS);
    expect(lines).toEqual([{ at: at(2), kind: 'text', text: 'start here' }]);
  });

  it("leaves out an agent's text and shape, a deleted text, and a text written before the listener started", () => {
    const { elements, lines } = watching<Written>(listenTexts, [text('old', 'an old note', -60)]);
    // A peer's copy of the board brings a text written before the start.
    elements.set('late', text('late', 'written before', -5));
    elements.set('mine', withCreator(text('mine', 'I wrote this', 1), claude));
    elements.set('box', withCreator(element({ id: 'box' }, 1), claude));
    elements.set('gone', text('gone', 'a typo', 2));
    elements.set('gone', text('gone', 'a typo', 3, { isDeleted: true }));
    // The person moves the old note, which leaves its words as they were.
    elements.set('old', text('old', 'an old note', 4, { x: 50 }));
    vi.advanceTimersByTime(10 * BOARD_PAUSE_MS);
    expect(lines).toEqual([]);
  });

  it('prints the text that waits for its pause at once on flush, and drops it on stop', () => {
    const { elements, lines, listener } = watching<Written>(listenTexts);
    elements.set('note', text('note', 'draw a box', 1));
    listener.flush();
    expect(lines).toEqual([{ at: at(1), kind: 'text', text: 'draw a box' }]);
    vi.advanceTimersByTime(BOARD_PAUSE_MS);
    expect(lines).toHaveLength(1);

    elements.set('note', text('note', 'draw a circle', 2));
    listener.stop();
    elements.set('other', text('other', 'and an arrow', 3));
    vi.advanceTimersByTime(BOARD_PAUSE_MS);
    listener.flush();
    expect(lines).toHaveLength(1);
  });
});

describe('listenSketches', () => {
  it('prints the strokes a person draws as one line once they stay unchanged for the pause, with the part of the board they cover', () => {
    const { elements, lines } = watching<Sketched>(listenSketches);
    // Excalidraw changes a stroke as the person draws it, one point at a time.
    elements.set('one', stroke('one', 10, 20, [[0, 0]], 1));
    elements.set('one', stroke('one', 10, 20, [[0, 0], [30, 40]], 1.5));
    vi.advanceTimersByTime(BOARD_PAUSE_MS - 1);
    elements.set('two', stroke('two', 100, 0, [[0, 0], [-20, 10], [10, 50]], 2));
    vi.advanceTimersByTime(BOARD_PAUSE_MS - 1);
    expect(lines).toEqual([]);

    vi.advanceTimersByTime(1);
    // The first stroke covers 10 to 40 across and 20 to 60 down, the second 80 to 110 and 0 to 50.
    expect(lines).toEqual([
      { at: at(2), kind: 'sketch', ids: ['one', 'two'], box: { x: 10, y: 0, width: 100, height: 60 } },
    ]);

    elements.set('three', stroke('three', 0, 0, [[0, 0], [5, 5]], 10));
    elements.set('one', stroke('one', 10, 25, [[0, 0], [30, 40]], 11));
    vi.advanceTimersByTime(BOARD_PAUSE_MS);
    expect(lines).toEqual([
      { at: at(2), kind: 'sketch', ids: ['one', 'two'], box: { x: 10, y: 0, width: 100, height: 60 } },
      { at: at(11), kind: 'sketch', ids: ['three', 'one'], box: { x: 0, y: 0, width: 40, height: 65 } },
    ]);
  });

  it("reads a stroke whose points don't read as points by its x, y, width and height", () => {
    const { elements, lines } = watching<Sketched>(listenSketches);
    elements.set('odd', element({ id: 'odd', type: 'freedraw', x: 5, y: 6, width: 7, height: 8, points: [[0, 'up']] }, 1));
    vi.advanceTimersByTime(BOARD_PAUSE_MS);
    expect(lines).toEqual([{ at: at(1), kind: 'sketch', ids: ['odd'], box: { x: 5, y: 6, width: 7, height: 8 } }]);
  });

  it("leaves out an agent's stroke, a deleted stroke, a stroke drawn before the listener started, and other shapes", () => {
    const { elements, lines } = watching<Sketched>(listenSketches, [stroke('old', 0, 0, [[0, 0], [9, 9]], -60)]);
    elements.set('mine', withCreator(stroke('mine', 0, 0, [[0, 0], [9, 9]], 1), claude));
    elements.set('box', element({ id: 'box' }, 1));
    elements.set('gone', stroke('gone', 0, 0, [[0, 0], [9, 9]], 2));
    elements.set('gone', { ...stroke('gone', 0, 0, [[0, 0], [9, 9]], 3), isDeleted: true });
    vi.advanceTimersByTime(10 * BOARD_PAUSE_MS);
    expect(lines).toEqual([]);
  });

  it('prints the strokes that wait for their pause at once on flush, and drops them on stop', () => {
    const { elements, lines, listener } = watching<Sketched>(listenSketches);
    elements.set('one', stroke('one', 0, 0, [[0, 0], [9, 9]], 1));
    listener.flush();
    expect(lines).toEqual([{ at: at(1), kind: 'sketch', ids: ['one'], box: { x: 0, y: 0, width: 9, height: 9 } }]);

    elements.set('two', stroke('two', 0, 0, [[0, 0], [9, 9]], 2));
    listener.stop();
    vi.advanceTimersByTime(BOARD_PAUSE_MS);
    listener.flush();
    expect(lines).toHaveLength(1);
  });
});

describe('listenToBoard', () => {
  it("prints what people say, write and draw, each as its line, and nothing for an agent's shape", () => {
    const doc = new Y.Doc();
    const transcript = transcriptOf(doc);
    const elements = doc.getMap<unknown>(ELEMENTS);
    const lines: Line[] = [];
    const listener = listenToBoard(doc, {
      after: START,
      pauseMs: PAUSE_MS,
      boardPauseMs: BOARD_PAUSE_MS,
      print: (line) => lines.push(line),
    });
    appendEntry(transcript, said('one', 1, 'draw a box'));
    elements.set('note', text('note', 'a box here', 1));
    elements.set('one', stroke('one', 0, 0, [[0, 0], [9, 9]], 1));
    elements.set('mine', withCreator(text('mine', 'I drew this', 1), claude));
    vi.advanceTimersByTime(PAUSE_MS);
    expect(lines).toEqual([{ at: at(1), speakers: ['Ada'], text: 'draw a box' }]);

    vi.advanceTimersByTime(BOARD_PAUSE_MS - PAUSE_MS);
    expect(lines).toEqual([
      { at: at(1), speakers: ['Ada'], text: 'draw a box' },
      { at: at(1), kind: 'text', text: 'a box here' },
      { at: at(1), kind: 'sketch', ids: ['one'], box: { x: 0, y: 0, width: 9, height: 9 } },
    ]);

    appendEntry(transcript, said('two', 5, 'and a circle'));
    elements.set('note', text('note', 'a circle here', 5));
    listener.flush();
    expect(lines.slice(3)).toEqual([
      { at: at(5), speakers: ['Ada'], text: 'and a circle' },
      { at: at(5), kind: 'text', text: 'a circle here' },
    ]);
    listener.stop();
  });
});

describe('watchRoom', () => {
  it('logs where the listener loses the room as its last peer leaves, and where it joins the room again', () => {
    const network = new MemoryNetwork();
    const lines: string[] = [];
    watchRoom(network.join('listener'), (line) => lines.push(line));
    network.join('page');
    network.flush();
    expect(lines).toEqual(['connected to page']);

    network.disconnect('listener', 'page');
    // The two peers see each other leave; the link comes back at the next step.
    network.run(2);
    expect(lines).toEqual(['connected to page', 'page left', LOST]);

    network.flush();
    expect(lines).toEqual(['connected to page', 'page left', LOST, 'joined the room again: connected to page']);
  });

  it("doesn't lose the room while another peer stays connected", () => {
    const network = new MemoryNetwork();
    const lines: string[] = [];
    watchRoom(network.join('listener'), (line) => lines.push(line));
    network.join('page');
    network.join('helper');
    network.flush();
    network.leave('helper');
    network.flush();
    expect(lines).toEqual(['connected to page', 'connected to helper', 'helper left']);
  });
});

describe('parseListenArgs', () => {
  const link = 'https://camshaft.github.io/chalkline/#room=board&key=secret';

  it('reads the link, and takes the default pause and the start time where the options are left out', () => {
    expect(parseListenArgs([link], START)).toEqual({
      help: false,
      room: { room: 'board', key: 'secret' },
      relays: [],
      pauseMs: 1000,
      boardPauseMs: 3000,
      after: START,
    });
  });

  it("reads --pause and --board-pause in seconds, --after as an ISO 8601 time, and the relay a local network's link holds", () => {
    const args = [
      'http://192.168.1.2:8080/?relay=/relay#room=board&key=secret',
      '--pause',
      '0.5',
      '--board-pause',
      '5',
      '--after',
      '2026-11-07T02:59:00.000Z',
    ];
    expect(parseListenArgs(args, START)).toEqual({
      help: false,
      room: { room: 'board', key: 'secret' },
      relays: ['ws://192.168.1.2:8080/relay'],
      pauseMs: 500,
      boardPauseMs: 5000,
      after: Date.parse('2026-11-07T02:59:00.000Z'),
    });
  });

  it('answers --help with the usage text', () => {
    expect(parseListenArgs(['--help'], START)).toEqual({ help: true });
    expect(LISTEN_USAGE).toMatch(/^Usage: chalkline-mcp listen <board link>/);
  });

  it("refuses a pause, a time or a link it can't read, and a call that doesn't give one link", () => {
    expect(() => parseListenArgs([link, '--pause', 'soon'], START)).toThrow('--pause is "soon"');
    expect(() => parseListenArgs([link, '--pause', '0'], START)).toThrow('--pause is "0"');
    expect(() => parseListenArgs([link, '--board-pause', 'later'], START)).toThrow('--board-pause is "later"');
    expect(() => parseListenArgs([link, '--after', 'yesterday'], START)).toThrow('--after is "yesterday"');
    expect(() => parseListenArgs(['https://camshaft.github.io/chalkline/'], START)).toThrow(
      'The link lacks the #room=<name>&key=<password> fragment.',
    );
    expect(() => parseListenArgs(['not a link'], START)).toThrow("not a link isn't a link.");
    expect(() => parseListenArgs([], START)).toThrow(LISTEN_USAGE);
    expect(() => parseListenArgs([link, link], START)).toThrow(LISTEN_USAGE);
  });
});
