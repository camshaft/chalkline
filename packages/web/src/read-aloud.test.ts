// @vitest-environment jsdom
import { appendEntry, transcriptOf, type TranscriptEntry, type TranscriptVia } from '@chalkline/sync';
import { describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { offerReadAloud, readAloud, voiceOf, type Listening, type Utterance } from './read-aloud';
import {
  speechControl,
  type Recognition,
  type RecognitionClass,
  type RecognitionErrorEvent,
  type RecognitionResultEvent,
} from './speech';

const LOADED = '2026-11-07T14:00:00.000Z';
const BEFORE = '2026-11-07T13:59:00.000Z';
const AFTER = '2026-11-07T14:00:05.000Z';

const entry = (id: string, speaker: string, text: string, via: TranscriptVia, at = AFTER): TranscriptEntry => ({
  id,
  speaker,
  at,
  text,
  via,
});

/** A stand-in for the browser's SpeechSynthesisUtterance, which a test plays and ends through its events. */
class FakeUtterance implements Utterance {
  readonly text: string;
  onstart: (() => void) | null = null;
  onend: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(text: string) {
    this.text = text;
  }
}

/** A stand-in for the browser's voice: it keeps each utterance the page speaks, and counts each cancel. */
function fakeVoice() {
  const spoken: Utterance[] = [];
  const synthesis = {
    speak: vi.fn<(utterance: Utterance) => void>((utterance) => {
      spoken.push(utterance);
    }),
    cancel: vi.fn<() => void>(),
  };
  return { voice: { synthesis, Utterance: FakeUtterance }, synthesis, spoken, said: () => spoken.map(({ text }) => text) };
}

/** A stand-in for the speech recognition that reading aloud pauses and resumes. */
function fakeListening() {
  return { pause: vi.fn<() => void>(), resume: vi.fn<() => void>() } satisfies Listening;
}

/** Reading aloud of `transcript` on a page that loaded at `LOADED`, with a fake voice and recognition. */
function reading(transcript = transcriptOf(new Y.Doc())) {
  const { voice, synthesis, spoken, said } = fakeVoice();
  const listening = fakeListening();
  const reader = readAloud({ transcript, voice, listening, since: new Date(LOADED) });
  return { transcript, reader, synthesis, spoken, said, listening };
}

/** The page's `index`th utterance, counting the empty one it speaks as reading turns on. */
function utterance(spoken: Utterance[], index: number): Utterance {
  const found = spoken[index];
  if (found === undefined) throw new Error(`the page spoke ${spoken.length} utterances`);
  return found;
}

/** A stand-in for the browser's SpeechRecognition, which counts its starts and stops. */
class FakeRecognition implements Recognition {
  lang = '';
  continuous = false;
  interimResults = false;
  onstart: (() => void) | null = null;
  onresult: ((event: RecognitionResultEvent) => void) | null = null;
  onerror: ((event: RecognitionErrorEvent) => void) | null = null;
  onend: (() => void) | null = null;
  starts = 0;
  stops = 0;

  start(): void {
    this.starts += 1;
  }

  stop(): void {
    this.stops += 1;
  }
}

describe('voiceOf', () => {
  it("answers the browser's speechSynthesis and SpeechSynthesisUtterance, and null where it lacks either", () => {
    const synthesis = { speak: () => {}, cancel: () => {} };
    const found = voiceOf({ speechSynthesis: synthesis, SpeechSynthesisUtterance: FakeUtterance });
    expect(found?.synthesis).toBe(synthesis);
    expect(found?.Utterance).toBe(FakeUtterance);

    expect(voiceOf({ speechSynthesis: synthesis })).toBeNull();
    expect(voiceOf({ SpeechSynthesisUtterance: FakeUtterance })).toBeNull();
    expect(voiceOf({ speechSynthesis: null, SpeechSynthesisUtterance: FakeUtterance })).toBeNull();
    expect(voiceOf({ speechSynthesis: { speak: () => {} }, SpeechSynthesisUtterance: FakeUtterance })).toBeNull();
    expect(voiceOf({ speechSynthesis: { cancel: () => {} }, SpeechSynthesisUtterance: FakeUtterance })).toBeNull();
    expect(voiceOf({})).toBeNull();
  });
});

describe('readAloud', () => {
  it("reads each new message of an agent's once with reading on, and not a person's spoken or typed message", () => {
    const { transcript, reader, said } = reading();
    expect(reader.on()).toBe(false);
    reader.set(true);
    reader.set(true);
    expect(reader.on()).toBe(true);
    // As reading turns on, the page speaks an empty utterance, which lets Safari on iOS speak the messages after it.
    expect(said()).toEqual(['']);

    appendEntry(transcript, entry('spoken', 'Ada', 'draw a box', 'speech'));
    appendEntry(transcript, entry('typed', 'Ada', 'and an arrow', 'typed'));
    appendEntry(transcript, entry('posted', 'claude-code', 'I drew a box and an arrow', 'agent'));
    expect(said()).toEqual(['', 'I drew a box and an arrow']);

    // A later entry, and the same message again from a peer, don't read the message again.
    appendEntry(transcript, entry('thanks', 'Ada', 'thanks', 'typed'));
    appendEntry(transcript, entry('posted', 'claude-code', 'I drew a box and an arrow', 'agent'));
    expect(said()).toEqual(['', 'I drew a box and an arrow']);

    appendEntry(transcript, entry('next', 'claude-code', 'Anything else?', 'agent'));
    expect(said()).toEqual(['', 'I drew a box and an arrow', 'Anything else?']);
  });

  it("doesn't read a message on the transcript as it starts, or one from before the page loaded that a peer sends later", () => {
    const doc = new Y.Doc();
    const transcript = transcriptOf(doc);
    // An entry on the transcript as reading starts isn't read, though its time comes after the page loaded, as a
    // clock ahead of this one writes it.
    appendEntry(transcript, entry('kept', 'claude-code', 'an answer this browser kept', 'agent', AFTER));
    const { reader, said } = reading(transcript);
    reader.set(true);

    // The board's history comes from a peer once the page joins the board.
    const peer = new Y.Doc();
    appendEntry(transcriptOf(peer), entry('history', 'claude-code', 'an earlier answer', 'agent', BEFORE));
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(peer));
    expect(transcript.length).toBe(2);
    appendEntry(transcript, entry('posted', 'claude-code', 'a new answer', 'agent'));

    expect(said()).toEqual(['', 'a new answer']);
  });

  it("reads nothing with reading off, and doesn't read later the messages that came while it was off", () => {
    const { transcript, reader, synthesis, said, listening } = reading();
    reader.set(false);
    expect(synthesis.cancel).not.toHaveBeenCalled();
    appendEntry(transcript, entry('first', 'claude-code', 'I drew a box', 'agent'));
    expect(said()).toEqual([]);

    reader.set(true);
    reader.set(false);
    appendEntry(transcript, entry('second', 'claude-code', 'I drew an arrow', 'agent'));
    reader.set(true);

    expect(said()).toEqual(['', '']);
    expect(synthesis.cancel).toHaveBeenCalledTimes(1);
    expect(listening.pause).not.toHaveBeenCalled();
    expect(listening.resume).not.toHaveBeenCalled();
  });

  it('pauses recognition while an utterance plays, and resumes it once the last one ends or fails', () => {
    const { transcript, reader, spoken, listening } = reading();
    reader.set(true);
    // The empty utterance doesn't pause recognition.
    expect(utterance(spoken, 0).onstart).toBeNull();
    appendEntry(transcript, entry('one', 'claude-code', 'I drew a box', 'agent'));
    appendEntry(transcript, entry('two', 'claude-code', 'and an arrow', 'agent'));
    const one = utterance(spoken, 1);
    const two = utterance(spoken, 2);
    // Recognition pauses as an utterance starts to play, not as the page asks the browser to say it.
    expect(listening.pause).not.toHaveBeenCalled();

    one.onstart?.();
    expect(listening.pause).toHaveBeenCalledTimes(1);
    two.onstart?.();
    expect(listening.pause).toHaveBeenCalledTimes(1);
    one.onend?.();
    expect(listening.resume).not.toHaveBeenCalled();
    two.onerror?.();
    expect(listening.resume).toHaveBeenCalledTimes(1);
    // An end after the error doesn't resume recognition again.
    two.onend?.();
    expect(listening.resume).toHaveBeenCalledTimes(1);

    // An utterance that fails before it plays didn't pause recognition, and doesn't resume it.
    appendEntry(transcript, entry('three', 'claude-code', 'and a circle', 'agent'));
    utterance(spoken, 3).onerror?.();
    expect(listening.pause).toHaveBeenCalledTimes(1);
    expect(listening.resume).toHaveBeenCalledTimes(1);

    // The next utterance pauses recognition again.
    appendEntry(transcript, entry('four', 'claude-code', 'and a line', 'agent'));
    utterance(spoken, 4).onstart?.();
    expect(listening.pause).toHaveBeenCalledTimes(2);
  });

  it('stops what the browser says and resumes recognition as reading turns off', () => {
    const { transcript, reader, synthesis, spoken, said, listening } = reading();
    reader.set(true);
    appendEntry(transcript, entry('one', 'claude-code', 'I drew a box', 'agent'));
    appendEntry(transcript, entry('two', 'claude-code', 'and an arrow', 'agent'));
    const one = utterance(spoken, 1);
    const two = utterance(spoken, 2);
    one.onstart?.();
    expect(listening.pause).toHaveBeenCalledTimes(1);

    reader.set(false);
    expect(synthesis.cancel).toHaveBeenCalledTimes(1);
    expect(listening.resume).toHaveBeenCalledTimes(1);
    // The browser reports the canceled utterance's error, which doesn't resume recognition again, and an
    // utterance that starts after the cancel doesn't pause it.
    one.onerror?.();
    two.onstart?.();
    expect(listening.resume).toHaveBeenCalledTimes(1);
    expect(listening.pause).toHaveBeenCalledTimes(1);
    appendEntry(transcript, entry('later', 'claude-code', 'and a circle', 'agent'));
    expect(said()).toEqual(['', 'I drew a box', 'and an arrow']);

    // Once reading turns on again, an utterance pauses recognition as before.
    reader.set(true);
    appendEntry(transcript, entry('again', 'claude-code', 'and a line', 'agent'));
    const again = utterance(spoken, 4);
    expect(again.text).toBe('and a line');
    again.onstart?.();
    expect(listening.pause).toHaveBeenCalledTimes(2);
    again.onend?.();
    expect(listening.resume).toHaveBeenCalledTimes(2);
  });

  it('stops following the transcript once it stops', () => {
    const { transcript, reader, synthesis, said } = reading();
    reader.set(true);
    reader.stop();
    expect(reader.on()).toBe(false);
    expect(synthesis.cancel).toHaveBeenCalledTimes(1);

    reader.set(true);
    appendEntry(transcript, entry('posted', 'claude-code', 'I drew a box', 'agent'));
    expect(said()).toEqual(['', '']);
  });

  it('pauses speech recognition while an utterance plays, and starts it again once the utterance ends', async () => {
    const made: FakeRecognition[] = [];
    class Fake extends FakeRecognition {
      constructor() {
        super();
        made.push(this);
      }
    }
    const transcript = transcriptOf(new Y.Doc());
    const speech = speechControl({ Class: Fake as unknown as RecognitionClass, lang: 'en-US', transcript, speaker: () => 'Ada' });
    await speech.toggle();
    await speech.agree();
    const [listener] = made;
    listener.onstart?.();
    const { voice, spoken } = fakeVoice();
    const reader = readAloud({ transcript, voice, listening: speech, since: new Date(LOADED) });
    reader.set(true);

    appendEntry(transcript, entry('posted', 'claude-code', 'I drew a box', 'agent'));
    const posted = utterance(spoken, 1);
    expect(listener.stops).toBe(0);
    posted.onstart?.();
    expect(listener.stops).toBe(1);
    // The browser ends the recognition the page stopped, which doesn't start again while the utterance plays.
    listener.onend?.();
    expect(listener.starts).toBe(1);
    expect(speech.state()).toMatchObject({ kind: 'listening' });

    posted.onend?.();
    expect(listener.starts).toBe(2);
    expect(made).toHaveLength(1);
    expect(speech.state()).toMatchObject({ kind: 'listening' });
  });
});

describe('offerReadAloud', () => {
  it('shows its button where the browser has a voice, and each click turns reading on or off', () => {
    const button = document.createElement('button');
    button.hidden = true;
    const { voice, synthesis, said } = fakeVoice();
    const reader = offerReadAloud(button, voice, { transcript: transcriptOf(new Y.Doc()), listening: fakeListening() });
    expect(button.hidden).toBe(false);
    expect(button.getAttribute('aria-pressed')).toBe('false');
    expect(reader?.on()).toBe(false);

    button.click();
    expect(button.getAttribute('aria-pressed')).toBe('true');
    expect(reader?.on()).toBe(true);
    expect(said()).toEqual(['']);

    button.click();
    expect(button.getAttribute('aria-pressed')).toBe('false');
    expect(reader?.on()).toBe(false);
    expect(synthesis.cancel).toHaveBeenCalledTimes(1);
  });

  it("doesn't offer reading aloud where the browser has no voice", () => {
    const button = document.createElement('button');
    button.hidden = true;

    expect(offerReadAloud(button, voiceOf({}), { transcript: transcriptOf(new Y.Doc()), listening: fakeListening() })).toBeNull();
    expect(button.hidden).toBe(true);
  });
});
