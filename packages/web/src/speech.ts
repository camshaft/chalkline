import { appendEntry, newEntryId, replaceLastEntry } from '@chalkline/sync';
import type * as Y from 'yjs';

/** One of a recognition result's alternatives: the words the browser heard. */
export interface RecognitionAlternative {
  readonly transcript: string;
}

/** A recognition result: its alternatives, the most likely first, and whether the browser settled it. */
export interface RecognitionResult {
  readonly isFinal: boolean;
  readonly length: number;
  readonly [index: number]: RecognitionAlternative;
}

/** The Web Speech API's `result` event, in the fields the page reads. */
export interface RecognitionResultEvent {
  /** The first result this event changed; the results before it came in earlier events. */
  readonly resultIndex: number;
  readonly results: { readonly length: number; readonly [index: number]: RecognitionResult };
}

/** The Web Speech API's `error` event, in the field the page reads. */
export interface RecognitionErrorEvent {
  readonly error: string;
}

/** The parts of the Web Speech API's `SpeechRecognition` that the page uses. */
export interface Recognition {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  /** Keeps recognition on the device: only a browser that offers on-device recognition has it. */
  processLocally?: boolean;
  onstart: (() => void) | null;
  onresult: ((event: RecognitionResultEvent) => void) | null;
  onerror: ((event: RecognitionErrorEvent) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
}

/** What `available` and `install` ask about: the languages, and whether recognition stays on the device. */
export interface RecognitionOptions {
  langs: string[];
  processLocally: boolean;
}

/** The browser's `SpeechRecognition` class. */
export interface RecognitionClass {
  new (): Recognition;
  readonly prototype: object;
  /** Answers "available", "downloadable", "downloading" or "unavailable" for the languages. */
  available?(options: RecognitionOptions): Promise<string>;
  /** Downloads what on-device recognition of the languages needs, and answers whether it did. */
  install?(options: RecognitionOptions): Promise<boolean>;
}

/** The browser's `SpeechRecognition`, or else its `webkitSpeechRecognition`, or null where it offers neither. */
export function recognitionClass(scope: object): RecognitionClass | null {
  const { SpeechRecognition, webkitSpeechRecognition } = scope as Record<string, unknown>;
  const found = SpeechRecognition ?? webkitSpeechRecognition;
  return typeof found === 'function' ? (found as RecognitionClass) : null;
}

/**
 * The language to recognize, as a BCP 47 tag: the browser's language, or else
 * English. A browser may report a language such as "en-US@posix", which isn't
 * a tag, so the part from "@" on is left out.
 */
export function recognitionLanguage(language: string | undefined): string {
  const tag = (language ?? '').split('@')[0].trim();
  try {
    const [canonical] = Intl.getCanonicalLocales(tag);
    if (canonical !== undefined) return canonical;
  } catch {
    // Not a language tag.
  }
  return 'en-US';
}

/** Where recognition runs: on this device, on it after a one-time download, or on the browser vendor's service. */
export type Place = 'device' | 'download' | 'service';

/**
 * Where this browser recognizes `lang`: on the device where it offers
 * on-device recognition of the language, on the device after a download where
 * it can download the language, and otherwise on its vendor's speech service,
 * as for a browser without the on-device API or one whose check fails.
 */
export async function recognitionPlace(Class: RecognitionClass, lang: string): Promise<Place> {
  if (typeof Class.available !== 'function' || !('processLocally' in Class.prototype)) return 'service';
  try {
    const answer = await Class.available({ langs: [lang], processLocally: true });
    if (answer === 'available') return 'device';
    if ((answer === 'downloadable' || answer === 'downloading') && typeof Class.install === 'function') {
      return 'download';
    }
  } catch {
    // A check that fails leaves the vendor's service, which the page names before it starts.
  }
  return 'service';
}

const HEARD_BY_ALL = "The words it recognizes go on the board's transcript, which everyone on the board and the agent can read.";

/** What the page says before recognition starts: where it runs, and where the words go. */
export function placeNotice(place: Place, lang: string): string {
  switch (place) {
    case 'device':
      return `Speech recognition runs on this device, so your audio stays in this browser. ${HEARD_BY_ALL}`;
    case 'download':
      return `Speech recognition runs on this device, so your audio stays in this browser. The browser first downloads what it needs to recognize ${lang}, once. ${HEARD_BY_ALL}`;
    case 'service':
      return `This browser sends your audio to its vendor's speech service, which turns it into text: it doesn't recognize ${lang} on this device. ${HEARD_BY_ALL}`;
  }
}

/** What the page says where recognition stops for one of the browser's errors. */
export function errorText(error: string, lang: string): string {
  switch (error) {
    case 'not-allowed':
      return "Speech stopped: the browser didn't let the page use the microphone.";
    case 'service-not-allowed':
      return "Speech stopped: the browser didn't let the page use its speech recognition.";
    case 'audio-capture':
      return "Speech stopped: the browser didn't find a microphone.";
    case 'network':
      return "Speech stopped: the browser couldn't reach its speech service.";
    case 'language-not-supported':
      return `Speech stopped: the browser can't recognize ${lang}.`;
    default:
      return `Speech stopped: the browser reported "${error}".`;
  }
}

/** Where this browser's speech is: from the microphone button through the question to listening. */
export type SpeechState =
  /** The browser doesn't offer speech recognition. */
  | { kind: 'unsupported' }
  /** Speech is off, after an error where `error` says one stopped it. */
  | { kind: 'off'; error?: string }
  /** The page is asking the browser where recognition would run. */
  | { kind: 'checking' }
  /** The page has said where recognition runs, and waits for the person to agree. */
  | { kind: 'asking'; place: Place; notice: string }
  /** The browser is downloading what on-device recognition needs. */
  | { kind: 'installing' }
  /** Recognition runs; `heard` holds the words the browser hasn't settled yet. */
  | { kind: 'listening'; place: Exclude<Place, 'download'>; heard: string };

/** What `speechControl` works with. */
export interface SpeechOptions {
  /** The browser's `SpeechRecognition` class, or null where it offers none. */
  Class: RecognitionClass | null;
  /** The language to recognize, as a BCP 47 tag. */
  lang: string;
  /** The board's transcript, which each final result goes to. */
  transcript: Y.Array<unknown>;
  /** The speaker's name, as the board shows it now. */
  speaker(): string;
  /** A new entry's id; random where left out. */
  newId?: () => string;
  /** The time now; the clock where left out. */
  now?: () => Date;
}

/** This browser's speech, which the microphone button and the panel's question drive. */
export interface Speech {
  state(): SpeechState;
  /** Calls `handler` with each new state, and returns a function that stops it. */
  onState(handler: (state: SpeechState) => void): () => void;
  /**
   * The microphone button: where speech is off, asks where recognition runs and
   * then asks the person, settling once that check answers; otherwise turns speech off.
   */
  toggle(): Promise<void>;
  /** The person agrees to the question: starts recognition, after the download where one is needed, settling once it starts. */
  agree(): Promise<void>;
  /** The person declines the question: speech stays off. */
  decline(): void;
}

/** The one error after which the browser goes on listening once it starts again: a silence. */
const SILENCE = 'no-speech';

/** A result's words, in lower case, to compare the words of two results. */
function wordsOf(text: string): string[] {
  return text.toLowerCase().split(/\s+/).filter((word) => word !== '');
}

/** Whether `words` begin with each word of `before`, in its order, as a longer hypothesis of the same sentence does. */
function begins(words: readonly string[], before: readonly string[]): boolean {
  return before.length <= words.length && before.every((word, index) => words[index] === word);
}

/**
 * This browser's speech. It is off until the person presses the microphone
 * button; the page then says where recognition runs, and starts it only once
 * the person agrees, on the device where the browser offers that. Each final
 * result goes on `transcript` with the speaker's name and the time; the words
 * not yet final stay on this page. A browser such as Chrome on Android marks
 * each growing hypothesis of a sentence final, each one repeating the words
 * before it: where a final result's words begin with the words of the entry
 * this recognition session put on `transcript` last, and that entry is still
 * the transcript's last, the result replaces that entry, so that the sentence
 * shows once. Where the browser ends recognition after it started, as after a
 * silence, it starts again, and after any other error speech turns off and
 * says why.
 */
export function speechControl(options: SpeechOptions): Speech {
  const { Class, lang, transcript } = options;
  const newId = options.newId ?? newEntryId;
  const now = options.now ?? (() => new Date());
  const handlers = new Set<(state: SpeechState) => void>();
  let state: SpeechState = Class === null ? { kind: 'unsupported' } : { kind: 'off' };
  // Each turn of the button counts, so that a check or a download that answers
  // after the person turned speech off again doesn't go on.
  let turn = 0;
  let recognition: Recognition | null = null;

  const set = (next: SpeechState) => {
    state = next;
    for (const handler of [...handlers]) handler(next);
  };

  const listen = (Class: RecognitionClass, place: Exclude<Place, 'download'>) => {
    const listener = new Class();
    listener.lang = lang;
    listener.continuous = true;
    listener.interimResults = true;
    if (place === 'device') listener.processLocally = true;
    let started = false;
    let failure: string | null = null;
    // The entry this recognition session put on the transcript last, and its words.
    let last: { id: string; words: string[] } | null = null;
    listener.onstart = () => {
      started = true;
    };
    // A final result that arrives after the person turned speech off still goes on the transcript.
    listener.onresult = ({ resultIndex, results }) => {
      let heard = '';
      for (let index = resultIndex; index < results.length; index += 1) {
        const result = results[index];
        const words = result.length > 0 ? result[0].transcript.trim() : '';
        if (words === '') continue;
        if (result.isFinal) {
          const said = wordsOf(words);
          const entry = { speaker: options.speaker(), at: now().toISOString(), text: words, via: 'speech' as const };
          // A longer hypothesis of the sentence takes the place of the entry whose words it repeats.
          let id: string;
          if (last !== null && begins(said, last.words) && replaceLastEntry(transcript, { id: last.id, ...entry })) {
            id = last.id;
          } else {
            id = newId();
            appendEntry(transcript, { id, ...entry });
          }
          last = { id, words: said };
        } else {
          heard = heard === '' ? words : `${heard} ${words}`;
        }
      }
      if (recognition === listener && state.kind === 'listening') set({ ...state, heard });
    };
    listener.onerror = ({ error }) => {
      if (error !== SILENCE) failure = error;
    };
    listener.onend = () => {
      if (recognition !== listener) return;
      // A new session doesn't extend the words of the one before it.
      last = null;
      if (failure === null && started) {
        started = false;
        try {
          listener.start();
          return;
        } catch (error) {
          failure = error instanceof Error ? error.message : String(error);
        }
      }
      recognition = null;
      set({
        kind: 'off',
        error: failure !== null ? errorText(failure, lang) : 'Speech stopped: the browser ended recognition before it started.',
      });
    };
    recognition = listener;
    try {
      listener.start();
    } catch (error) {
      recognition = null;
      set({ kind: 'off', error: errorText(error instanceof Error ? error.message : String(error), lang) });
      return;
    }
    set({ kind: 'listening', place, heard: '' });
  };

  return {
    state: () => state,
    onState(handler) {
      handlers.add(handler);
      return () => {
        handlers.delete(handler);
      };
    },
    async toggle() {
      if (Class === null) return;
      turn += 1;
      if (state.kind !== 'off') {
        const listener = recognition;
        recognition = null;
        listener?.stop();
        set({ kind: 'off' });
        return;
      }
      const current = turn;
      set({ kind: 'checking' });
      const place = await recognitionPlace(Class, lang);
      if (current === turn) set({ kind: 'asking', place, notice: placeNotice(place, lang) });
    },
    async agree() {
      if (Class === null || state.kind !== 'asking') return;
      const { place } = state;
      if (place !== 'download') {
        listen(Class, place);
        return;
      }
      const current = turn;
      set({ kind: 'installing' });
      let installed = false;
      try {
        installed = (await Class.install?.({ langs: [lang], processLocally: true })) === true;
      } catch {
        // A download that fails leaves the vendor's service, which the page asks about first.
      }
      if (current !== turn) return;
      if (installed) listen(Class, 'device');
      else
        set({
          kind: 'asking',
          place: 'service',
          notice: `The browser didn't download what it needs to recognize ${lang} on this device. ${placeNotice('service', lang)}`,
        });
    },
    decline() {
      if (state.kind !== 'asking') return;
      turn += 1;
      set({ kind: 'off' });
    },
  };
}
