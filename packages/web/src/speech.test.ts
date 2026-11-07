import { readTranscript, transcriptOf } from '@chalkline/sync';
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  placeNotice,
  recognitionClass,
  recognitionLanguage,
  recognitionPlace,
  speechControl,
  type Recognition,
  type RecognitionClass,
  type RecognitionErrorEvent,
  type RecognitionOptions,
  type RecognitionResultEvent,
  type Speech,
  type SpeechState,
} from './speech';

/** A stand-in for the browser's SpeechRecognition, which a test drives through its events. */
class FakeRecognition implements Recognition {
  lang = '';
  continuous = false;
  interimResults = false;
  declare processLocally?: boolean;
  onstart: (() => void) | null = null;
  onresult: ((event: RecognitionResultEvent) => void) | null = null;
  onerror: ((event: RecognitionErrorEvent) => void) | null = null;
  onend: (() => void) | null = null;
  starts = 0;
  stops = 0;
  /** Where set, `start` throws it. */
  refusal: Error | null = null;

  start(): void {
    if (this.refusal !== null) throw this.refusal;
    this.starts += 1;
  }

  stop(): void {
    this.stops += 1;
  }

  /** The browser starts listening. */
  begin(): void {
    this.onstart?.();
  }

  /** The browser reports results from `resultIndex` on, each `[words, final]`. */
  hear(resultIndex: number, ...results: Array<[string, boolean]>): void {
    this.onresult?.({
      resultIndex,
      results: results.map(([words, isFinal]) => Object.assign([{ transcript: words }], { isFinal })),
    });
  }

  fail(error: string): void {
    this.onerror?.({ error });
  }

  end(): void {
    this.onend?.();
  }
}

interface FakeOptions {
  /** Puts `processLocally` on the class, as a browser that offers on-device recognition does. */
  onDevice?: boolean;
  available?: (options: RecognitionOptions) => Promise<string>;
  install?: (options: RecognitionOptions) => Promise<boolean>;
  /** Where set, each recognition's `start` throws it. */
  refuse?: Error;
}

/** A SpeechRecognition class, and each recognition the page made of it. */
function fakeClass(options: FakeOptions = {}) {
  const made: FakeRecognition[] = [];
  class Fake extends FakeRecognition {
    constructor() {
      super();
      this.refusal = options.refuse ?? null;
      made.push(this);
    }
  }
  if (options.onDevice === true) Object.defineProperty(Fake.prototype, 'processLocally', { value: false, writable: true });
  Object.assign(Fake, { available: options.available, install: options.install });
  return { Class: Fake as unknown as RecognitionClass, made };
}

/** A promise a test settles itself. */
function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  let reject: (error: unknown) => void = () => {};
  const promise = new Promise<T>((settle, fail) => {
    resolve = settle;
    reject = fail;
  });
  return { promise, resolve, reject };
}

const AT = new Date('2026-11-07T01:02:03.000Z');

function control(Class: RecognitionClass | null, speaker = () => 'Ada') {
  const doc = new Y.Doc();
  const transcript = transcriptOf(doc);
  let ids = 0;
  const speech = speechControl({
    Class,
    lang: 'en-US',
    transcript,
    speaker,
    newId: () => `entry-${(ids += 1)}`,
    now: () => AT,
  });
  const states: SpeechState[] = [];
  speech.onState((state) => states.push(state));
  return { speech, transcript, states };
}

/** Turns speech on with the microphone button, and answers the page's question with Start listening. */
async function listening(speech: Speech): Promise<void> {
  await speech.toggle();
  await speech.agree();
}

describe('recognitionClass', () => {
  it('answers SpeechRecognition, else webkitSpeechRecognition, else null', () => {
    const { Class } = fakeClass();
    const { Class: prefixed } = fakeClass();

    expect(recognitionClass({ SpeechRecognition: Class, webkitSpeechRecognition: prefixed })).toBe(Class);
    expect(recognitionClass({ webkitSpeechRecognition: prefixed })).toBe(prefixed);
    expect(recognitionClass({})).toBeNull();
    expect(recognitionClass({ SpeechRecognition: 'not a class' })).toBeNull();
  });
});

describe('recognitionLanguage', () => {
  it("answers the browser's language as a tag, and English where it isn't one", () => {
    expect(recognitionLanguage('en-US@posix')).toBe('en-US');
    expect(recognitionLanguage('fr-fr')).toBe('fr-FR');
    expect(recognitionLanguage(undefined)).toBe('en-US');
    expect(recognitionLanguage('')).toBe('en-US');
    expect(recognitionLanguage('not a tag!')).toBe('en-US');
  });
});

describe('recognitionPlace', () => {
  it('answers the device where the browser has on-device recognition of the language', async () => {
    const asked: RecognitionOptions[] = [];
    const { Class } = fakeClass({
      onDevice: true,
      available: async (options) => {
        asked.push(options);
        return 'available';
      },
    });

    expect(await recognitionPlace(Class, 'fr-FR')).toBe('device');
    expect(asked).toEqual([{ langs: ['fr-FR'], processLocally: true }]);
  });

  it('answers a download where the browser can download the language, and the service where it can not', async () => {
    const install = async () => true;
    for (const answer of ['downloadable', 'downloading']) {
      const { Class } = fakeClass({ onDevice: true, available: async () => answer, install });
      expect(await recognitionPlace(Class, 'en-US'), answer).toBe('download');
    }
    const { Class: noInstall } = fakeClass({ onDevice: true, available: async () => 'downloadable' });
    expect(await recognitionPlace(noInstall, 'en-US')).toBe('service');
  });

  it("answers the service where on-device recognition is unavailable, its check fails, or the browser doesn't have it", async () => {
    const cases = [
      fakeClass({ onDevice: true, available: async () => 'unavailable' }),
      fakeClass({ onDevice: true, available: async () => Promise.reject(new Error('refused')) }),
      fakeClass({ onDevice: true }),
      fakeClass({ available: async () => 'available' }),
    ];
    for (const { Class } of cases) expect(await recognitionPlace(Class, 'en-US')).toBe('service');
  });
});

describe('speechControl', () => {
  it("does nothing in a browser that doesn't offer speech recognition", async () => {
    const { speech, states } = control(null);

    await speech.toggle();
    await speech.agree();

    expect(speech.state()).toEqual({ kind: 'unsupported' });
    expect(states).toEqual([]);
  });

  it('says where recognition runs before it starts, and starts nothing until the person agrees', async () => {
    const { Class, made } = fakeClass({ onDevice: true, available: async () => 'available' });
    const { speech, states } = control(Class);
    expect(speech.state()).toEqual({ kind: 'off' });

    await speech.toggle();

    expect(states.map(({ kind }) => kind)).toEqual(['checking', 'asking']);
    expect(speech.state()).toEqual({ kind: 'asking', place: 'device', notice: placeNotice('device', 'en-US') });
    expect(placeNotice('device', 'en-US')).toContain('your audio stays in this browser');
    expect(made).toEqual([]);

    speech.decline();

    expect(speech.state()).toEqual({ kind: 'off' });
    expect(made).toEqual([]);
  });

  it("names the vendor's service where recognition runs there, and doesn't keep recognition on the device", async () => {
    const { Class, made } = fakeClass();
    const { speech } = control(Class);

    await speech.toggle();
    const asked = speech.state();
    expect(asked.kind === 'asking' && asked.notice).toContain("sends your audio to its vendor's speech service");

    await speech.agree();

    expect(made).toHaveLength(1);
    expect(made[0].processLocally).toBeUndefined();
    expect(speech.state()).toEqual({ kind: 'listening', place: 'service', heard: '' });
  });

  it('starts recognition on the device, continuous and with the words not yet final, in the language', async () => {
    const { Class, made } = fakeClass({ onDevice: true, available: async () => 'available' });
    const { speech } = control(Class);

    await listening(speech);

    expect(made).toHaveLength(1);
    const [listener] = made;
    expect({ lang: listener.lang, continuous: listener.continuous, interim: listener.interimResults }).toEqual({
      lang: 'en-US',
      continuous: true,
      interim: true,
    });
    expect(listener.processLocally).toBe(true);
    expect(listener.starts).toBe(1);
    expect(speech.state()).toEqual({ kind: 'listening', place: 'device', heard: '' });
  });

  it('downloads the language first where the browser needs it, and then recognizes on the device', async () => {
    const download = deferred<boolean>();
    const installs: RecognitionOptions[] = [];
    const { Class, made } = fakeClass({
      onDevice: true,
      available: async () => 'downloadable',
      install: (options) => {
        installs.push(options);
        return download.promise;
      },
    });
    const { speech } = control(Class);
    await speech.toggle();
    expect(speech.state()).toMatchObject({ kind: 'asking', place: 'download' });

    const agreed = speech.agree();
    expect(speech.state()).toEqual({ kind: 'installing' });
    expect(made).toEqual([]);
    download.resolve(true);
    await agreed;

    expect(installs).toEqual([{ langs: ['en-US'], processLocally: true }]);
    expect(made[0].processLocally).toBe(true);
    expect(speech.state()).toEqual({ kind: 'listening', place: 'device', heard: '' });
  });

  it("asks again, naming the vendor's service, where the download doesn't finish", async () => {
    for (const install of [async () => false, async () => Promise.reject(new Error('no space'))]) {
      const { Class, made } = fakeClass({ onDevice: true, available: async () => 'downloadable', install });
      const { speech } = control(Class);
      await speech.toggle();

      await speech.agree();

      const asked = speech.state();
      expect(asked).toMatchObject({ kind: 'asking', place: 'service' });
      expect(asked.kind === 'asking' && asked.notice).toContain("didn't download what it needs to recognize en-US");
      expect(made).toEqual([]);

      await speech.agree();

      expect(made[0].processLocally).toBe(false);
      expect(speech.state()).toMatchObject({ kind: 'listening', place: 'service' });
    }
  });

  it("appends each final result with the speaker's name and the time, and keeps the words not yet final on the page", async () => {
    const { Class, made } = fakeClass();
    let name = 'Ada';
    const { speech, transcript } = control(Class, () => name);
    await listening(speech);
    const [listener] = made;
    listener.begin();

    listener.hear(0, ['draw a box', false]);
    expect(speech.state()).toEqual({ kind: 'listening', place: 'service', heard: 'draw a box' });
    expect(transcript.length).toBe(0);

    listener.hear(0, [' draw a box ', true], ['and an', false]);
    expect(speech.state()).toMatchObject({ heard: 'and an' });
    name = 'Ada Lovelace';
    listener.hear(1, ['draw a box', true], ['and an arrow', true], ['   ', true]);

    expect(readTranscript(transcript)).toEqual([
      { id: 'entry-1', speaker: 'Ada', at: AT.toISOString(), text: 'draw a box' },
      { id: 'entry-2', speaker: 'Ada Lovelace', at: AT.toISOString(), text: 'and an arrow' },
    ]);
    expect(speech.state()).toMatchObject({ heard: '' });
  });

  it('starts again where the browser ends recognition after it started, as after a silence', async () => {
    const { Class, made } = fakeClass();
    const { speech } = control(Class);
    await listening(speech);
    const [listener] = made;
    listener.begin();

    listener.fail('no-speech');
    listener.end();

    expect(listener.starts).toBe(2);
    expect(speech.state()).toMatchObject({ kind: 'listening' });

    listener.begin();
    listener.end();

    expect(listener.starts).toBe(3);
    expect(made).toHaveLength(1);
  });

  it('turns off and says why after any other error', async () => {
    const { Class, made } = fakeClass();
    const { speech } = control(Class);
    await listening(speech);
    const [listener] = made;
    listener.begin();

    listener.fail('not-allowed');
    listener.end();

    expect(listener.starts).toBe(1);
    expect(speech.state()).toEqual({
      kind: 'off',
      error: "Speech stopped: the browser didn't let the page use the microphone.",
    });
  });

  it("turns off, and doesn't start again, where the browser ends recognition before it started", async () => {
    const { Class, made } = fakeClass();
    const { speech } = control(Class);
    await listening(speech);

    made[0].end();

    expect(made[0].starts).toBe(1);
    expect(speech.state()).toEqual({
      kind: 'off',
      error: 'Speech stopped: the browser ended recognition before it started.',
    });
  });

  it('turns off and says why where the browser refuses to start', async () => {
    const { Class, made } = fakeClass({ refuse: new Error('already started') });
    const { speech } = control(Class);
    await speech.toggle();

    await speech.agree();

    expect(made).toHaveLength(1);
    expect(speech.state()).toEqual({ kind: 'off', error: 'Speech stopped: the browser reported "already started".' });
  });

  it('stops where the person turns it off, keeps a final result that arrives after, and starts nothing again', async () => {
    const { Class, made } = fakeClass();
    const { speech, transcript } = control(Class);
    await listening(speech);
    const [listener] = made;
    listener.begin();

    await speech.toggle();
    listener.hear(0, ['last words', true]);
    listener.end();

    expect(listener.stops).toBe(1);
    expect(listener.starts).toBe(1);
    expect(speech.state()).toEqual({ kind: 'off' });
    expect(readTranscript(transcript).map(({ text }) => text)).toEqual(['last words']);
  });

  it("doesn't ask where the person turns speech off while the browser checks where it runs", async () => {
    const check = deferred<string>();
    const { Class } = fakeClass({ onDevice: true, available: () => check.promise });
    const { speech, states } = control(Class);

    const asking = speech.toggle();
    await speech.toggle();
    check.resolve('available');
    await asking;

    expect(states.map(({ kind }) => kind)).toEqual(['checking', 'off']);
  });

  it("doesn't start where the person cancels while the browser downloads the language", async () => {
    const download = deferred<boolean>();
    const { Class, made } = fakeClass({ onDevice: true, available: async () => 'downloadable', install: () => download.promise });
    const { speech } = control(Class);
    await speech.toggle();

    const agreed = speech.agree();
    await speech.toggle();
    download.resolve(true);
    await agreed;

    expect(made).toEqual([]);
    expect(speech.state()).toEqual({ kind: 'off' });
  });

  it('stops telling a handler once it stops', async () => {
    const { Class } = fakeClass();
    const { speech } = control(Class);
    const seen: SpeechState[] = [];
    const stop = speech.onState((state) => seen.push(state));

    await speech.toggle();
    stop();
    speech.decline();

    expect(seen.map(({ kind }) => kind)).toEqual(['checking', 'asking']);
  });
});
