import { appendEntry, connectDoc, MemoryNetwork, transcriptOf, type TranscriptEntry } from '@chalkline/sync';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { listen, LOST, PAUSE_MS, watchRoom, type Heard, type Listener } from './listen';
import { LISTEN_USAGE, parseListenArgs } from './listen-cli';
import { TranscriptLog } from './transcript';

/** When the listener starts in these tests. */
const START = Date.parse('2026-11-07T03:00:00.000Z');

/** The time `seconds` after the listener starts, or before it where `seconds` is below 0. */
const at = (seconds: number): string => new Date(START + seconds * 1000).toISOString();

/** An entry said `seconds` after the listener starts. */
const said = (id: string, seconds: number, text: string, speaker = 'Ada'): TranscriptEntry => ({
  id,
  speaker,
  at: at(seconds),
  text,
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
      after: START,
    });
  });

  it("reads --pause in seconds, --after as an ISO 8601 time, and the relay a local network's link holds", () => {
    const args = [
      'http://192.168.1.2:8080/?relay=/relay#room=board&key=secret',
      '--pause',
      '0.5',
      '--after',
      '2026-11-07T02:59:00.000Z',
    ];
    expect(parseListenArgs(args, START)).toEqual({
      help: false,
      room: { room: 'board', key: 'secret' },
      relays: ['ws://192.168.1.2:8080/relay'],
      pauseMs: 500,
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
    expect(() => parseListenArgs([link, '--after', 'yesterday'], START)).toThrow('--after is "yesterday"');
    expect(() => parseListenArgs(['https://camshaft.github.io/chalkline/'], START)).toThrow(
      'The link lacks the #room=<name>&key=<password> fragment.',
    );
    expect(() => parseListenArgs(['not a link'], START)).toThrow("not a link isn't a link.");
    expect(() => parseListenArgs([], START)).toThrow(LISTEN_USAGE);
    expect(() => parseListenArgs([link, link], START)).toThrow(LISTEN_USAGE);
  });
});
