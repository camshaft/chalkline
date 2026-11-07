import {
  appendEntry,
  connectDoc,
  feedbackOf,
  MemoryNetwork,
  transcriptOf,
  writeFeedback,
  type Feedback,
  type TranscriptEntry,
  type TranscriptVia,
} from '@chalkline/sync';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { ELEMENTS } from './board';
import { withChange, withCreator, withDrawingChanged, withWordsChanged, type Creator } from './creator';
import {
  BOARD_PAUSE_MS,
  listen,
  listenFeedback,
  listenSketches,
  listenTexts,
  listenToBoard,
  LOST,
  PAUSE_MS,
  watchRoom,
  type BoardListenOptions,
  type FeedbackOpened,
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

/**
 * `value` as a person's page leaves it after a change `seconds` after the listener starts: with
 * `fields`, a new version and a new nonce, and the custom data `value` holds, as Excalidraw keeps it.
 */
const edited = (value: Record<string, unknown>, fields: Record<string, unknown>, seconds: number): Record<string, unknown> => ({
  ...value,
  ...fields,
  version: Number(value.version) + 1,
  versionNonce: Number(value.versionNonce) + 100,
  updated: START + seconds * 1000,
});

/** `value` as the agent's helper leaves it after a change `seconds` after the listener starts, with its change mark. */
const changedByClaude = (value: Record<string, unknown>, fields: Record<string, unknown>, seconds: number): Record<string, unknown> =>
  withChange(edited(value, fields, seconds), claude);

/** The fields of a text that holds `written`. */
const words = (written: string): Record<string, unknown> => ({ text: written, originalText: written });

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

  it("prints a person's change of the words of an agent's text, and leaves out the agent's own changes of it", () => {
    const { elements, lines } = watching<Written>(listenTexts);
    let answer = withCreator(text('answer', 'The box is blue', 1), claude);
    elements.set('answer', answer);
    answer = changedByClaude(answer, words('The box is red'), 2);
    elements.set('answer', answer);
    vi.advanceTimersByTime(BOARD_PAUSE_MS);
    expect(lines).toEqual([]);

    // A person moves the agent's text, which leaves its words as the agent wrote them.
    answer = edited(answer, { x: 200 }, 5);
    elements.set('answer', answer);
    vi.advanceTimersByTime(BOARD_PAUSE_MS);
    expect(lines).toEqual([]);

    // The person corrects the agent's words, one key at a time.
    answer = edited(answer, words('The box is'), 10);
    elements.set('answer', answer);
    answer = edited(answer, words('The box is green'), 11);
    elements.set('answer', answer);
    vi.advanceTimersByTime(BOARD_PAUSE_MS - 1);
    expect(lines).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(lines).toEqual([{ at: at(11), kind: 'text', text: 'The box is green' }]);

    // The agent changes its words again, which doesn't make a line.
    elements.set('answer', changedByClaude(answer, words('The box is green, as you said'), 20));
    vi.advanceTimersByTime(BOARD_PAUSE_MS);
    expect(lines).toHaveLength(1);
  });

  it("prints a person's change of the label of a shape an agent added", () => {
    const { elements, lines } = watching<Written>(listenTexts);
    elements.set('box', withCreator(element({ id: 'box' }, 1), claude));
    const label = withCreator(text('label', 'Start', 1, { containerId: 'box' }), claude);
    elements.set('label', label);
    vi.advanceTimersByTime(BOARD_PAUSE_MS);
    expect(lines).toEqual([]);

    elements.set('label', edited(label, words('Begin'), 4));
    vi.advanceTimersByTime(BOARD_PAUSE_MS);
    expect(lines).toEqual([{ at: at(4), kind: 'text', text: 'Begin' }]);
  });

  it("leaves out the agent's change of a person's text, and prints the person's next change of it", () => {
    const { elements, lines } = watching<Written>(listenTexts);
    let note = text('note', 'draw a box', 1);
    elements.set('note', note);
    vi.advanceTimersByTime(BOARD_PAUSE_MS);
    expect(lines).toEqual([{ at: at(1), kind: 'text', text: 'draw a box' }]);

    note = changedByClaude(note, words('draw a box: done'), 5);
    elements.set('note', note);
    vi.advanceTimersByTime(BOARD_PAUSE_MS);
    expect(lines).toHaveLength(1);

    elements.set('note', edited(note, words('draw a circle'), 10));
    vi.advanceTimersByTime(BOARD_PAUSE_MS);
    expect(lines).toEqual([
      { at: at(1), kind: 'text', text: 'draw a box' },
      { at: at(10), kind: 'text', text: 'draw a circle' },
    ]);
  });

  it('leaves out a text first received after the start whose next change keeps its words, and prints a later change of its words', () => {
    const { elements, lines } = watching<Written>(listenTexts);
    // A peer's copy of the board brings a text written before the start, and the agent writes its own.
    let note = text('note', 'draw a box', -5);
    elements.set('note', note);
    let answer = withCreator(text('answer', 'The box is blue', 2), claude);
    elements.set('answer', answer);
    // A person widens each text, which leaves its words as they were.
    note = edited(note, { width: 200 }, 5);
    elements.set('note', note);
    answer = edited(answer, { width: 200 }, 5);
    elements.set('answer', answer);
    vi.advanceTimersByTime(BOARD_PAUSE_MS);
    expect(lines).toEqual([]);

    elements.set('note', edited(note, words('draw a circle'), 10));
    elements.set('answer', edited(answer, words('The box is green'), 11));
    vi.advanceTimersByTime(BOARD_PAUSE_MS);
    expect(lines).toEqual([
      { at: at(10), kind: 'text', text: 'draw a circle' },
      { at: at(11), kind: 'text', text: 'The box is green' },
    ]);
  });

  it("leaves out a person's move of an agent's text that the listener first receives after the move, and prints the person's changes of its words", () => {
    const { elements, lines } = watching<Written>(listenTexts);
    // A person widens the agent's text and the agent's label before a peer's copy of the board brings them.
    elements.set('box', withCreator(element({ id: 'box' }, -2), claude));
    let answer = edited(withCreator(text('answer', 'The box is blue', -2), claude), { width: 200 }, 3);
    elements.set('answer', answer);
    const label = edited(withCreator(text('label', 'Start', -2, { containerId: 'box' }), claude), { width: 80 }, 3);
    elements.set('label', label);
    vi.advanceTimersByTime(BOARD_PAUSE_MS);
    expect(lines).toEqual([]);

    elements.set('label', edited(label, words('Begin'), 6));
    vi.advanceTimersByTime(BOARD_PAUSE_MS);
    expect(lines).toEqual([{ at: at(6), kind: 'text', text: 'Begin' }]);

    answer = edited(answer, words('The box is green'), 10);
    elements.set('answer', answer);
    vi.advanceTimersByTime(BOARD_PAUSE_MS);
    // The person changes the words back to the ones the agent wrote, which makes a line too.
    elements.set('answer', edited(answer, words('The box is blue'), 20));
    vi.advanceTimersByTime(BOARD_PAUSE_MS);
    expect(lines).toEqual([
      { at: at(6), kind: 'text', text: 'Begin' },
      { at: at(10), kind: 'text', text: 'The box is green' },
      { at: at(20), kind: 'text', text: 'The box is blue' },
    ]);
  });

  it("leaves out a person's text that a page moved before the listener first receives it, by its words mark, and prints a later change of its words", () => {
    const { elements, lines } = watching<Written>(listenTexts);
    // A person writes a note before the start and another after it, and moves each after the start;
    // the page's binding keeps on the board's copy of each the time its words last changed.
    const note = withWordsChanged(text('note', 'draw a box', -5), undefined);
    const moved = withWordsChanged(edited(note, { x: 40 }, 5), note);
    const label = withWordsChanged(text('label', 'label the box', 3), undefined);
    // A peer's copy of the board brings only the moved copy of each.
    elements.set('note', moved);
    elements.set('label', withWordsChanged(edited(label, { x: 40 }, 4), label));
    vi.advanceTimersByTime(BOARD_PAUSE_MS);
    expect(lines).toEqual([{ at: at(3), kind: 'text', text: 'label the box' }]);

    elements.set('note', withWordsChanged(edited(moved, words('draw a circle'), 10), moved));
    vi.advanceTimersByTime(BOARD_PAUSE_MS);
    expect(lines).toEqual([
      { at: at(3), kind: 'text', text: 'label the box' },
      { at: at(10), kind: 'text', text: 'draw a circle' },
    ]);
  });

  it('leaves out a text without a words mark that a page changed before the start, keeping its words, and prints a later change of its words', () => {
    const doc = new Y.Doc();
    const elements = doc.getMap<unknown>(ELEMENTS);
    const lines: Written[] = [];
    // A listener that starts a minute after the time `--after` sets.
    listenTexts(doc, { after: START, start: START + 60_000, pauseMs: BOARD_PAUSE_MS, onLine: (line) => lines.push(line) });
    // A person's note from an hour before, which a page wrote before the pages recorded the words
    // mark, and which a page measured again 30 seconds after `--after`, with a new width, height
    // and version and the same words.
    const note = text('note', 'draw a box', -3600);
    const measured = edited(note, { width: 140, height: 30 }, 30);
    // A person's note that a page wrote with its words mark 20 seconds after `--after`.
    const typed = withWordsChanged(text('typed', 'and a label', 20), undefined);
    // A peer's copy of the board brings only the newest copy of each.
    elements.set('note', measured);
    elements.set('typed', typed);
    vi.advanceTimersByTime(BOARD_PAUSE_MS);
    expect(lines).toEqual([{ at: at(20), kind: 'text', text: 'and a label' }]);

    // A page that doesn't record the words mark brings a person's change of the note's words from
    // 50 seconds after `--after`.
    const reworded = edited(measured, words('draw two boxes'), 50);
    elements.set('note', reworded);
    vi.advanceTimersByTime(BOARD_PAUSE_MS);
    expect(lines).toEqual([
      { at: at(20), kind: 'text', text: 'and a label' },
      { at: at(50), kind: 'text', text: 'draw two boxes' },
    ]);

    // A page measures the note again after the start, and keeps its words.
    const again = withWordsChanged(edited(reworded, { width: 150, height: 32 }, 70), reworded);
    elements.set('note', again);
    vi.advanceTimersByTime(BOARD_PAUSE_MS);
    expect(lines).toHaveLength(2);

    // A person changes the note's words, and another person types a note on a page that doesn't
    // record the words mark.
    elements.set('note', withWordsChanged(edited(again, words('draw a circle'), 80), again));
    elements.set('fresh', text('fresh', 'and an arrow', 90));
    vi.advanceTimersByTime(BOARD_PAUSE_MS);
    expect(lines).toEqual([
      { at: at(20), kind: 'text', text: 'and a label' },
      { at: at(50), kind: 'text', text: 'draw two boxes' },
      { at: at(80), kind: 'text', text: 'draw a circle' },
      { at: at(90), kind: 'text', text: 'and an arrow' },
    ]);
  });

  it("leaves out the texts a board held before the listener started, through the board's network, and their copies a page saves again unchanged", () => {
    const network = new MemoryNetwork();
    const page = new Y.Doc();
    const board = page.getMap<unknown>(ELEMENTS);
    // The board holds an agent's text from before the creator mark and an arrow's label from a
    // Mermaid diagram, each of which a page saved again after `--after` without changing its words
    // or recording the words mark, a person's note with its words mark, and an agent's text with
    // its creator mark.
    const answer = edited(text('answer', 'an answer from before the creator mark', -7200), { width: 300 }, 30);
    const arrow = element({ id: 'arrow', type: 'arrow' }, -7200);
    const label = edited(text('label', 'read_transcript', -7200, { containerId: 'arrow' }), { height: 25 }, 40);
    const note = withWordsChanged(text('note', 'draw a box', -60), undefined);
    const mine = withCreator(text('mine', 'how the crates fit together', -7200), claude);
    for (const value of [answer, arrow, label, note, mine]) board.set(String(value.id), value);
    connectDoc(page, network.join('page'));

    const helper = new Y.Doc();
    const lines: Written[] = [];
    listenTexts(helper, { after: START, start: START + 60_000, pauseMs: BOARD_PAUSE_MS, onLine: (line) => lines.push(line) });
    connectDoc(helper, network.join('listener'));
    network.flush();
    vi.advanceTimersByTime(BOARD_PAUSE_MS);
    expect(lines).toEqual([]);

    // The page saves each text again with its words as they were, as where it measures them again.
    const savedAnswer = withWordsChanged(edited(answer, { width: 320 }, 90), answer);
    board.set('answer', savedAnswer);
    for (const value of [label, note, mine]) board.set(String(value.id), withWordsChanged(edited(value, { width: 320 }, 90), value));
    network.flush();
    vi.advanceTimersByTime(BOARD_PAUSE_MS);
    expect(lines).toEqual([]);

    // A person changes the agent's old answer, which a line tells of.
    board.set('answer', withWordsChanged(edited(savedAnswer, words('a corrected answer'), 100), savedAnswer));
    network.flush();
    vi.advanceTimersByTime(BOARD_PAUSE_MS);
    expect(lines).toEqual([{ at: at(100), kind: 'text', text: 'a corrected answer' }]);
  });

  it('leaves out a text without a words mark that a page loads and saves again after the start, by the copy it saves over, and prints a later change of its words', () => {
    const network = new MemoryNetwork();
    const helper = new Y.Doc();
    const lines: Written[] = [];
    // A listener that starts a minute after the time `--after` sets, before any page joins the room.
    listenTexts(helper, { after: START, start: START + 60_000, pauseMs: BOARD_PAUSE_MS, onLine: (line) => lines.push(line) });
    connectDoc(helper, network.join('listener'));

    // A page loads a board that holds a person's note from an hour before `--after`, which a page
    // wrote before the pages recorded the words mark, and measures the note again 90 seconds after
    // `--after` with the same words, before it joins the room. Its binding writes the measured
    // copy over the board's copy, as `bindElements` writes it.
    const page = new Y.Doc();
    const board = page.getMap<unknown>(ELEMENTS);
    const note = text('note', 'draw a box', -3600);
    board.set('note', note);
    const measured = withWordsChanged(edited(note, { width: 140, height: 30 }, 90), board.get('note'));
    board.set('note', measured);
    connectDoc(page, network.join('page'));
    network.flush();
    vi.advanceTimersByTime(BOARD_PAUSE_MS);
    expect(lines).toEqual([]);

    // A person changes the note's words.
    board.set('note', withWordsChanged(edited(measured, words('draw a circle'), 120), measured));
    network.flush();
    vi.advanceTimersByTime(BOARD_PAUSE_MS);
    expect(lines).toEqual([{ at: at(120), kind: 'text', text: 'draw a circle' }]);
  });

  it("prints a text without a words mark that a person wrote after `--after` and that a page saves again after the start, at the time of the copy it saves over", () => {
    const network = new MemoryNetwork();
    const helper = new Y.Doc();
    const lines: Written[] = [];
    listenTexts(helper, { after: START, start: START + 60_000, pauseMs: BOARD_PAUSE_MS, onLine: (line) => lines.push(line) });
    connectDoc(helper, network.join('listener'));

    // A person typed the note 30 seconds after `--after` on a page that doesn't record the words
    // mark, and a page that does measures it again 90 seconds after `--after`, before it joins.
    const page = new Y.Doc();
    const board = page.getMap<unknown>(ELEMENTS);
    const typed = text('typed', 'and a label', 30);
    board.set('typed', typed);
    board.set('typed', withWordsChanged(edited(typed, { width: 140 }, 90), board.get('typed')));
    connectDoc(page, network.join('page'));
    network.flush();
    vi.advanceTimersByTime(BOARD_PAUSE_MS);
    expect(lines).toEqual([{ at: at(30), kind: 'text', text: 'and a label' }]);
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

  it("leaves out a person's stroke that the agent moves, and an agent's stroke that a person moves", () => {
    const theirs = stroke('theirs', 0, 0, [[0, 0], [9, 9]], -60);
    const mine = withCreator(stroke('mine', 50, 0, [[0, 0], [9, 9]], -60), claude);
    const { elements, lines } = watching<Sketched>(listenSketches, [theirs, mine]);
    elements.set('theirs', changedByClaude(theirs, { x: 100 }, 1));
    elements.set('mine', edited(mine, { x: 200 }, 2));
    vi.advanceTimersByTime(10 * BOARD_PAUSE_MS);
    expect(lines).toEqual([]);
  });

  it("leaves out a person's stroke that a page saved again with its place and points, by its drawing mark, and prints a change of either", () => {
    const { elements, lines } = watching<Sketched>(listenSketches);
    // A person draws a stroke before the start and another after it; the page's binding keeps on
    // the board's copy of each the time its place and points last changed.
    const before = withDrawingChanged(stroke('before', 0, 0, [[0, 0], [9, 9]], -5), undefined);
    const after = withDrawingChanged(stroke('after', 100, 0, [[0, 0], [9, 9]], 3), undefined);
    // A peer's copy of the board brings each as a page saved it again after the start, with a new
    // version and index and the same place and points.
    const savedBefore = withDrawingChanged(edited(before, { index: 'a5' }, 5), before);
    const savedAfter = withDrawingChanged(edited(after, { index: 'a6' }, 6), after);
    elements.set('before', savedBefore);
    elements.set('after', savedAfter);
    vi.advanceTimersByTime(BOARD_PAUSE_MS);
    expect(lines).toEqual([{ at: at(3), kind: 'sketch', ids: ['after'], box: { x: 100, y: 0, width: 9, height: 9 } }]);

    // A person moves the stroke drawn before the start, and a page saves the other again just
    // before the pause ends, which doesn't hold back the line of the move.
    elements.set('before', withDrawingChanged(edited(savedBefore, { x: 20 }, 10), savedBefore));
    vi.advanceTimersByTime(BOARD_PAUSE_MS - 1);
    const again = withDrawingChanged(edited(savedAfter, { index: 'a7' }, 12), savedAfter);
    elements.set('after', again);
    vi.advanceTimersByTime(1);
    expect(lines).toEqual([
      { at: at(3), kind: 'sketch', ids: ['after'], box: { x: 100, y: 0, width: 9, height: 9 } },
      { at: at(10), kind: 'sketch', ids: ['before'], box: { x: 20, y: 0, width: 9, height: 9 } },
    ]);

    // A person moves the stroke drawn after the start and moves it back before the pause ends.
    const away = withDrawingChanged(edited(again, { x: 140 }, 20), again);
    const back = withDrawingChanged(edited(away, { x: 100 }, 21), away);
    elements.set('after', away);
    elements.set('after', back);
    vi.advanceTimersByTime(BOARD_PAUSE_MS);
    expect(lines).toHaveLength(2);

    // A person draws on with the stroke's points.
    elements.set('after', withDrawingChanged(edited(back, { points: [[0, 0], [9, 9], [30, 3]] }, 30), back));
    vi.advanceTimersByTime(BOARD_PAUSE_MS);
    expect(lines.slice(2)).toEqual([{ at: at(30), kind: 'sketch', ids: ['after'], box: { x: 100, y: 0, width: 30, height: 9 } }]);
  });

  it('leaves out a stroke without a drawing mark that a page saved again before the start, keeping its place and points, and prints a later change of its points', () => {
    const doc = new Y.Doc();
    const elements = doc.getMap<unknown>(ELEMENTS);
    const lines: Sketched[] = [];
    // A listener that starts a minute after the time `--after` sets.
    listenSketches(doc, { after: START, start: START + 60_000, pauseMs: BOARD_PAUSE_MS, onLine: (line) => lines.push(line) });
    // A person's stroke from an hour before, which a page drew before the pages recorded the
    // drawing mark, and which a page saved again 30 seconds after `--after`, with a new version and
    // index and the same place and points. A peer's copy of the board brings only that copy.
    const saved = edited(stroke('old', 10, 20, [[0, 0], [30, 40]], -3600), { index: 'a5' }, 30);
    elements.set('old', saved);
    vi.advanceTimersByTime(BOARD_PAUSE_MS);
    expect(lines).toEqual([]);

    // A person's stroke that a page drew with its drawing mark 20 seconds after `--after`.
    elements.set('drawn', withDrawingChanged(stroke('drawn', 100, 0, [[0, 0], [9, 9]], 20), undefined));
    vi.advanceTimersByTime(BOARD_PAUSE_MS);
    expect(lines).toEqual([{ at: at(20), kind: 'sketch', ids: ['drawn'], box: { x: 100, y: 0, width: 9, height: 9 } }]);

    // A page that doesn't record the drawing mark brings a person's change of the old stroke's
    // points from 50 seconds after `--after`.
    const redrawn = edited(saved, { points: [[0, 0], [30, 40], [50, 10]] }, 50);
    elements.set('old', redrawn);
    vi.advanceTimersByTime(BOARD_PAUSE_MS);
    expect(lines.slice(1)).toEqual([{ at: at(50), kind: 'sketch', ids: ['old'], box: { x: 10, y: 20, width: 50, height: 40 } }]);

    // A page saves the stroke again after the start, with its place and points as they were.
    const again = withDrawingChanged(edited(redrawn, { index: 'a6' }, 70), redrawn);
    elements.set('old', again);
    vi.advanceTimersByTime(BOARD_PAUSE_MS);
    expect(lines).toHaveLength(2);

    // A person changes the stroke's points, and another person draws a stroke on a page that
    // doesn't record the drawing mark.
    elements.set('old', withDrawingChanged(edited(again, { points: [[0, 0], [30, 40]] }, 80), again));
    vi.advanceTimersByTime(BOARD_PAUSE_MS);
    elements.set('fresh', stroke('fresh', 0, 0, [[0, 0], [5, 5]], 90));
    vi.advanceTimersByTime(BOARD_PAUSE_MS);
    expect(lines.slice(2)).toEqual([
      { at: at(80), kind: 'sketch', ids: ['old'], box: { x: 10, y: 20, width: 30, height: 40 } },
      { at: at(90), kind: 'sketch', ids: ['fresh'], box: { x: 0, y: 0, width: 5, height: 5 } },
    ]);
  });

  it('leaves out a stroke without a drawing mark that a page loads and saves again after the start, by the copy it saves over, and prints a later change of its points', () => {
    const network = new MemoryNetwork();
    const helper = new Y.Doc();
    const lines: Sketched[] = [];
    // A listener that starts a minute after the time `--after` sets, before any page joins the room.
    listenSketches(helper, { after: START, start: START + 60_000, pauseMs: BOARD_PAUSE_MS, onLine: (line) => lines.push(line) });
    connectDoc(helper, network.join('listener'));

    // A page loads a board that holds a person's stroke from an hour before `--after`, which a page
    // drew before the pages recorded the drawing mark, and saves the stroke again 90 seconds after
    // `--after` with a new index and the same place and points, before it joins the room. Its
    // binding writes the saved copy over the board's copy, as `bindElements` writes it.
    const page = new Y.Doc();
    const board = page.getMap<unknown>(ELEMENTS);
    const old = stroke('old', 10, 20, [[0, 0], [30, 40]], -3600);
    board.set('old', old);
    const saved = withDrawingChanged(edited(old, { index: 'a5' }, 90), board.get('old'));
    board.set('old', saved);
    connectDoc(page, network.join('page'));
    network.flush();
    vi.advanceTimersByTime(BOARD_PAUSE_MS);
    expect(lines).toEqual([]);

    // A person changes the stroke's points.
    board.set('old', withDrawingChanged(edited(saved, { points: [[0, 0], [30, 40], [50, 10]] }, 120), saved));
    network.flush();
    vi.advanceTimersByTime(BOARD_PAUSE_MS);
    expect(lines).toEqual([{ at: at(120), kind: 'sketch', ids: ['old'], box: { x: 10, y: 20, width: 50, height: 40 } }]);
  });

  it('prints a stroke without a drawing mark that a person drew after `--after` and that a page saves again after the start, at the time of the copy it saves over', () => {
    const network = new MemoryNetwork();
    const helper = new Y.Doc();
    const lines: Sketched[] = [];
    listenSketches(helper, { after: START, start: START + 60_000, pauseMs: BOARD_PAUSE_MS, onLine: (line) => lines.push(line) });
    connectDoc(helper, network.join('listener'));

    // A person drew the stroke 30 seconds after `--after` on a page that doesn't record the drawing
    // mark, and a page that does saves it again 90 seconds after `--after`, before it joins.
    const page = new Y.Doc();
    const board = page.getMap<unknown>(ELEMENTS);
    const drawn = stroke('drawn', 100, 0, [[0, 0], [9, 9]], 30);
    board.set('drawn', drawn);
    board.set('drawn', withDrawingChanged(edited(drawn, { index: 'a5' }, 90), board.get('drawn')));
    connectDoc(page, network.join('page'));
    network.flush();
    vi.advanceTimersByTime(BOARD_PAUSE_MS);
    expect(lines).toEqual([{ at: at(30), kind: 'sketch', ids: ['drawn'], box: { x: 100, y: 0, width: 9, height: 9 } }]);
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

/** A feedback Ada wrote on the box `seconds` after the listener starts, which no agent answered. */
const feedback = (id: string, seconds: number, text = 'can we move this up a bit?'): Feedback => ({
  id,
  by: 'Ada',
  at: at(seconds),
  text,
  region: { x: 0, y: 0, width: 100, height: 50 },
  shapes: ['box'],
  status: 'open',
  answer: null,
  reopened: null,
});

/** `record` as an agent answered it `seconds` after the listener starts. */
const answered = (record: Feedback, seconds: number): Feedback => ({
  ...record,
  status: 'answered',
  answer: { by: 'Claude', at: at(seconds), text: 'moved the box up' },
});

/** `record` as a person reopened it on a page that doesn't record when, which keeps its answer. */
const reopened = (record: Feedback): Feedback => ({ ...record, status: 'open' });

/** `record` as a person reopened it `seconds` after the listener starts, on a page that records when. */
const reopenedAt = (record: Feedback, seconds: number): Feedback => ({ ...record, status: 'open', reopened: at(seconds) });

/** The line the listener prints for `record`, which became open at `when`. */
const opened = (record: Feedback, when: string): FeedbackOpened => ({
  at: when,
  kind: 'feedback',
  id: record.id,
  by: record.by,
  text: record.text,
  shapes: record.shapes,
});

interface Reading {
  doc: Y.Doc;
  board: Y.Map<unknown>;
  /** Each line the listener would print, in order. */
  lines: FeedbackOpened[];
  listener: Listener;
}

/** A board's copy whose feedback holds `records`, and a listener of its feedback that starts at `START`. */
function reading(records: Feedback[] = []): Reading {
  const doc = new Y.Doc();
  const board = feedbackOf(doc);
  for (const record of records) writeFeedback(board, record);
  const lines: FeedbackOpened[] = [];
  const listener = listenFeedback(doc, { after: START, onLine: (line) => lines.push(line) });
  return { doc, board, lines, listener };
}

describe('listenFeedback', () => {
  it('prints a line at once for a feedback a person writes after the start, and leaves out one written before it', () => {
    const { board, lines } = reading();
    // A peer's copy of the board brings a feedback written before the start, and one written at the start.
    writeFeedback(board, feedback('old', -60, 'an old request'));
    writeFeedback(board, feedback('start', 0, 'written as the listener started'));
    expect(lines).toEqual([]);

    const record = feedback('move', 25);
    writeFeedback(board, record);
    expect(lines).toEqual([opened(record, at(25))]);
  });

  it('prints the feedback that one change opens in the order of its time', () => {
    const { doc, board, lines } = reading();
    const later = feedback('later', 30, 'and add a label');
    const earlier = feedback('earlier', 20);
    doc.transact(() => {
      writeFeedback(board, later);
      writeFeedback(board, earlier);
    });
    expect(lines).toEqual([opened(earlier, at(20)), opened(later, at(30))]);
  });

  it('prints kind "ask" for an ask, new or reopened, and kind "feedback" for a feedback and for a record without a kind', () => {
    const { board, lines } = reading();
    const ask: Feedback = { ...feedback('ask', 20, 'Tidy this up'), shapes: ['box', 'arrow'], kind: 'ask' };
    const marked: Feedback = { ...feedback('marked', 25), kind: 'feedback' };
    // A record that a page wrote before kinds, which doesn't hold one.
    const old = feedback('old', 30, 'and add a label');
    writeFeedback(board, ask);
    writeFeedback(board, marked);
    writeFeedback(board, old);
    expect(board.get('old')).not.toHaveProperty('kind');
    expect(lines).toEqual([{ ...opened(ask, at(20)), kind: 'ask' }, opened(marked, at(25)), opened(old, at(30))]);

    // An agent answers the ask, and a person reopens it.
    const answer = answered(ask, 40);
    writeFeedback(board, answer);
    writeFeedback(board, reopenedAt(answer, 60));
    expect(lines.map(({ id, kind }) => [id, kind])).toEqual([
      ['ask', 'ask'],
      ['marked', 'feedback'],
      ['old', 'feedback'],
      ['ask', 'ask'],
    ]);
  });

  it("prints a line for a feedback a person reopens on a page that doesn't record when, at the time the listener receives the reopening, and none for an agent's answer or a peer's copy of the same record", () => {
    const { board, lines } = reading();
    const record = feedback('move', 25);
    writeFeedback(board, record);
    const answer = answered(record, 40);
    writeFeedback(board, answer);
    // A peer writes the same answered record again.
    writeFeedback(board, answer);
    expect(lines).toEqual([opened(record, at(25))]);

    vi.setSystemTime(START + 90_000);
    writeFeedback(board, reopened(answer));
    // A peer writes the same open record again.
    writeFeedback(board, reopened(answer));
    expect(lines).toEqual([opened(record, at(25)), opened(record, at(90))]);
  });

  it('leaves out the feedback the board held open before the listener started, and prints a later reopening of it', () => {
    const old = feedback('old', -60);
    const moved = feedback('moved', -50, 'and this one');
    const { board, lines } = reading([old, reopened(answered(moved, -40))]);
    expect(lines).toEqual([]);

    vi.setSystemTime(START + 30_000);
    const answer = answered(old, 20);
    writeFeedback(board, answer);
    writeFeedback(board, reopened(answer));
    expect(lines).toEqual([opened(old, at(30))]);
  });

  it("receives a page's feedback through the board's network, and leaves out a reopened one whose answer came at or before `--after`", () => {
    vi.setSystemTime(START + 5_000);
    const network = new MemoryNetwork();
    const page = new Y.Doc();
    const board = feedbackOf(page);
    // `--after` sets a time a minute before the listener starts. The page holds a feedback that an
    // agent answered before that time and a person reopened, one answered at that time and
    // reopened, one answered after it and reopened, and one written after it that no agent answered.
    const before = feedback('before', -300, 'make it blue');
    const atAfter = feedback('at-after', -300, 'make it green');
    const since = feedback('since', -300, 'make it red');
    const unanswered = feedback('unanswered', -20, 'and add a label');
    for (const record of [answered(before, -90), answered(atAfter, -60), answered(since, -30)]) {
      writeFeedback(board, reopened(record));
    }
    writeFeedback(board, unanswered);
    connectDoc(page, network.join('page'));

    const helper = new Y.Doc();
    const lines: FeedbackOpened[] = [];
    listenFeedback(helper, { after: START - 60_000, onLine: (line) => lines.push(line) });
    connectDoc(helper, network.join('listener'));
    network.flush();
    expect(lines).toHaveLength(2);
    expect(lines).toEqual(expect.arrayContaining([opened(unanswered, at(-20)), opened(since, at(5))]));
  });

  it('prints a line for a feedback a person reopens at the time their page recorded, though the listener receives the reopening later', () => {
    const { board, lines } = reading();
    const record = feedback('move', 25);
    writeFeedback(board, record);
    const answer = answered(record, 40);
    writeFeedback(board, answer);

    vi.setSystemTime(START + 90_000);
    writeFeedback(board, reopenedAt(answer, 60));
    // A peer writes the same reopened record again.
    writeFeedback(board, reopenedAt(answer, 60));
    expect(lines).toEqual([opened(record, at(25)), opened(record, at(60))]);
  });

  it('leaves out a feedback reopened at or before the start, though the listener receives the reopening after it read the feedback as answered', () => {
    const before = answered(feedback('before', -120), -90);
    const start = answered(feedback('start', -120, 'and add a label'), -90);
    const { board, lines } = reading([before, start]);

    vi.setSystemTime(START + 30_000);
    writeFeedback(board, reopenedAt(before, -10));
    writeFeedback(board, reopenedAt(start, 0));
    expect(lines).toEqual([]);
  });

  it('prints a feedback that the listener first receives reopened after `--after` at its reopen time, and leaves out one reopened at or before `--after`', () => {
    vi.setSystemTime(START + 5_000);
    const doc = new Y.Doc();
    const board = feedbackOf(doc);
    // `--after` sets a time a minute before the listener starts. The board holds a feedback reopened
    // before that time and one reopened after it, each answered long before, and a change brings
    // one reopened at that time and one reopened after it.
    const before = reopenedAt(answered(feedback('before', -300, 'make it blue'), -200), -90);
    const since = reopenedAt(answered(feedback('since', -300, 'make it red'), -200), -30);
    writeFeedback(board, before);
    writeFeedback(board, since);
    const lines: FeedbackOpened[] = [];
    listenFeedback(doc, { after: START - 60_000, onLine: (line) => lines.push(line) });
    expect(lines).toEqual([opened(since, at(-30))]);

    const later = reopenedAt(answered(feedback('later', -300, 'and add a label'), -200), -10);
    const atAfter = reopenedAt(answered(feedback('at-after', -300, 'make it green'), -200), -60);
    doc.transact(() => {
      writeFeedback(board, later);
      writeFeedback(board, atAfter);
    });
    expect(lines).toEqual([opened(since, at(-30)), opened(later, at(-10))]);
  });

  it("reads a deleted feedback, or a value under its id that doesn't read as a feedback, as not open, so that its next open copy prints a line", () => {
    const { board, lines } = reading();
    const record = feedback('move', 25);
    writeFeedback(board, record);
    board.set('move', { id: 'move', text: 'a value without the other fields' });
    vi.setSystemTime(START + 60_000);
    writeFeedback(board, record);
    board.delete('move');
    vi.setSystemTime(START + 90_000);
    writeFeedback(board, record);
    expect(lines).toEqual([opened(record, at(25)), opened(record, at(60)), opened(record, at(90))]);
  });

  it('prints nothing once stopped', () => {
    const { board, lines, listener } = reading();
    listener.stop();
    writeFeedback(board, feedback('move', 25));
    listener.flush();
    expect(lines).toEqual([]);
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
      start: START,
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

  it("passes the listener's start to the texts and the strokes, where --after sets an earlier time", () => {
    const doc = new Y.Doc();
    const elements = doc.getMap<unknown>(ELEMENTS);
    const lines: Line[] = [];
    listenToBoard(doc, {
      after: START,
      start: START + 60_000,
      pauseMs: PAUSE_MS,
      boardPauseMs: BOARD_PAUSE_MS,
      print: (line) => lines.push(line),
    });
    // A text without a words mark and a stroke without a drawing mark, each of which a page saved
    // again before the start, and a person's text and stroke after the start.
    elements.set('old', edited(text('old', 'an old note', -3600), { width: 140 }, 30));
    elements.set('scrawl', edited(stroke('scrawl', 0, 0, [[0, 0], [9, 9]], -3600), { index: 'a5' }, 30));
    elements.set('note', text('note', 'a box here', 70));
    elements.set('one', stroke('one', 0, 0, [[0, 0], [5, 5]], 70));
    vi.advanceTimersByTime(BOARD_PAUSE_MS);
    expect(lines).toEqual([
      { at: at(70), kind: 'text', text: 'a box here' },
      { at: at(70), kind: 'sketch', ids: ['one'], box: { x: 0, y: 0, width: 5, height: 5 } },
    ]);
  });

  it('prints a line at once for each feedback that becomes open', () => {
    const doc = new Y.Doc();
    const lines: Line[] = [];
    listenToBoard(doc, {
      after: START,
      start: START,
      pauseMs: PAUSE_MS,
      boardPauseMs: BOARD_PAUSE_MS,
      print: (line) => lines.push(line),
    });
    const record = feedback('move', 25);
    writeFeedback(feedbackOf(doc), record);
    expect(lines).toEqual([opened(record, at(25))]);
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
      turnServers: [],
      pauseMs: 1000,
      boardPauseMs: 3000,
      after: START,
      start: START,
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
      turnServers: [],
      pauseMs: 500,
      boardPauseMs: 5000,
      after: Date.parse('2026-11-07T02:59:00.000Z'),
      start: START,
    });
  });

  it("reads the servers of the link's turn parameter, which the listener joins the room through", () => {
    const servers = [{ urls: ['turn:turn.cloudflare.com:3478?transport=udp'], username: 'link-user', credential: 'link-pass' }];
    const turn = Buffer.from(JSON.stringify(servers)).toString('base64url');
    const parsed = parseListenArgs([`${link}&turn=${turn}`], START);
    expect(parsed).toMatchObject({ help: false, room: { room: 'board', key: 'secret' }, turnServers: servers });
  });

  it('answers --help with the usage text', () => {
    expect(parseListenArgs(['--help'], START)).toEqual({ help: true });
    expect(LISTEN_USAGE).toMatch(/^Usage: chalkline-mcp listen <board link>/);
    expect(LISTEN_USAGE).toContain('{"at", "kind": "feedback", "id", "by", "text", "shapes"}');
    expect(LISTEN_USAGE).toContain('"kind" is "ask"');
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
    expect(() => parseListenArgs([`${link}&turn=%25%25`], START)).toThrow("The link's turn parameter isn't base64url text.");
    expect(() => parseListenArgs([], START)).toThrow(LISTEN_USAGE);
    expect(() => parseListenArgs([link, link], START)).toThrow(LISTEN_USAGE);
  });
});
