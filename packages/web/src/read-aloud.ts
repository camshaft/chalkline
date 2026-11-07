import { readTranscript } from '@chalkline/sync';
import type * as Y from 'yjs';

/** The parts of the Web Speech API's `SpeechSynthesisUtterance` that the page uses: its words, and the events of its playing. */
export interface Utterance {
  readonly text: string;
  onstart: (() => void) | null;
  onend: (() => void) | null;
  onerror: (() => void) | null;
}

/** The parts of the browser's `speechSynthesis` that the page uses. */
export interface Synthesis {
  speak(utterance: Utterance): void;
  cancel(): void;
}

/** The browser's voice: its `speechSynthesis`, and the `SpeechSynthesisUtterance` class of the utterances it speaks. */
export interface Voice {
  synthesis: Synthesis;
  Utterance: new (text: string) => Utterance;
}

/** The browser's voice, or null where it doesn't offer both `speechSynthesis` and `SpeechSynthesisUtterance`. */
export function voiceOf(scope: object): Voice | null {
  const { speechSynthesis, SpeechSynthesisUtterance } = scope as Record<string, unknown>;
  if (typeof SpeechSynthesisUtterance !== 'function' || typeof speechSynthesis !== 'object' || speechSynthesis === null) {
    return null;
  }
  const synthesis = speechSynthesis as Partial<Record<keyof Synthesis, unknown>>;
  if (typeof synthesis.speak !== 'function' || typeof synthesis.cancel !== 'function') return null;
  return { synthesis: speechSynthesis as Synthesis, Utterance: SpeechSynthesisUtterance as Voice['Utterance'] };
}

/** The speech recognition that reading aloud stops while the page speaks, as `speechControl` answers it. */
export interface Listening {
  /** The page starts to speak. */
  pause(): void;
  /** The page stops speaking. */
  resume(): void;
}

/** What `readAloud` works with. */
export interface ReadAloudOptions {
  /** The board's transcript, whose new messages of an agent's it reads. */
  transcript: Y.Array<unknown>;
  /** The browser's voice. */
  voice: Voice;
  /** This browser's speech recognition, which pauses while an utterance plays. */
  listening: Listening;
  /** When the page loaded: a message written before then isn't read. The time now where left out. */
  since?: Date;
}

/** The page's reading aloud of the messages agents post in the chat, which is off until the person turns it on. */
export interface ReadAloud {
  /** Whether reading is on. */
  on(): boolean;
  /**
   * Turns reading on or off. Call it from the person's click: a browser speaks only on a page the person has
   * used, and Safari on iOS only once a click has spoken.
   */
  set(on: boolean): void;
  /** Turns reading off, and stops following the transcript. */
  stop(): void;
}

/**
 * Reads aloud with the browser's voice each message an agent posts in the chat, an entry of `transcript`
 * whose `via` is "agent", once, while reading is on. It doesn't read a message that came while reading was
 * off, one that was on the transcript as it started, or one written before `since` that a peer sends later,
 * as the board's history comes once the page joins the board. While an utterance plays, `listening` pauses,
 * so that speech recognition doesn't put the page's voice on the transcript as the person's words, and it
 * resumes once no utterance plays. Turning reading off stops what the browser is saying.
 */
export function readAloud({ transcript, voice, listening, since = new Date() }: ReadAloudOptions): ReadAloud {
  const { synthesis, Utterance } = voice;
  const from = since.getTime();
  // Each entry the page has seen, read or not, so that it reads each message once at most.
  const seen = new Set(readTranscript(transcript).map(({ id }) => id));
  let reading = false;
  // Each turn off counts, so that an utterance it canceled doesn't pause or resume recognition after it.
  let turn = 0;
  // How many utterances play now: recognition pauses while one does.
  let playing = 0;

  const say = (text: string): void => {
    const utterance = new Utterance(text);
    const current = turn;
    let plays = false;
    utterance.onstart = () => {
      if (current !== turn) return;
      plays = true;
      playing += 1;
      if (playing === 1) listening.pause();
    };
    // An utterance's end or error resumes recognition once, where it played, unless reading turned off since.
    const end = () => {
      if (!plays || current !== turn) return;
      plays = false;
      playing -= 1;
      if (playing === 0) listening.resume();
    };
    utterance.onend = end;
    utterance.onerror = end;
    synthesis.speak(utterance);
  };

  const follow = (): void => {
    for (const { id, at, text, via } of readTranscript(transcript)) {
      if (seen.has(id)) continue;
      seen.add(id);
      if (reading && via === 'agent' && Date.parse(at) >= from) say(text);
    }
  };
  transcript.observe(follow);

  const set = (on: boolean): void => {
    if (on === reading) return;
    reading = on;
    if (on) {
      // Safari on iOS speaks only once a click has spoken: this empty utterance, spoken in the click that turns
      // reading on, lets the messages after it play.
      synthesis.speak(new Utterance(''));
      return;
    }
    turn += 1;
    synthesis.cancel();
    if (playing > 0) {
      playing = 0;
      listening.resume();
    }
  };

  return {
    on: () => reading,
    set,
    stop() {
      transcript.unobserve(follow);
      set(false);
    },
  };
}

/**
 * Offers reading aloud where the browser has a voice: makes a `readAloud` of `options` with `voice`, binds
 * `button` to it, each click turning reading on or off and its `aria-pressed` saying which, and shows the
 * button. Where `voice` is null, the button stays hidden, and this answers null.
 */
export function offerReadAloud(
  button: HTMLButtonElement,
  voice: Voice | null,
  options: Omit<ReadAloudOptions, 'voice'>,
): ReadAloud | null {
  if (voice === null) {
    button.hidden = true;
    return null;
  }
  const reader = readAloud({ ...options, voice });
  const show = () => button.setAttribute('aria-pressed', String(reader.on()));
  button.addEventListener('click', () => {
    reader.set(!reader.on());
    show();
  });
  show();
  button.hidden = false;
  return reader;
}
