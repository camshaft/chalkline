import { readTranscript, type TranscriptEntry } from '@chalkline/sync';
import type * as Y from 'yjs';
import type { SpeechState } from './speech';

/** The page's elements that `bindTranscriptPanel` binds. */
export interface PanelElements {
  /** The microphone button in the page's bar. */
  mic: HTMLButtonElement;
  /** The bar's button that opens and closes the panel. */
  opener: HTMLButtonElement;
  /** The panel, which `bindTranscriptPanel` fills. */
  panel: HTMLElement;
}

/** What the panel's buttons do. */
export interface SpeechActions {
  /** The microphone button: turns speech on, which asks first, or off. */
  toggle(): void;
  /** Start listening, in answer to the question. */
  agree(): void;
  /** Cancel, in answer to the question. */
  decline(): void;
}

/** What the panel says under its title for each state. */
export function statusText(state: SpeechState): string {
  switch (state.kind) {
    case 'unsupported':
      return "This browser doesn't offer speech recognition, so it doesn't add to the transcript. The transcript still shows what the others say.";
    case 'off':
      return state.error ?? '';
    case 'checking':
      return 'Checking whether this browser recognizes speech on this device...';
    case 'asking':
      return '';
    case 'installing':
      return 'The browser is downloading what it needs to recognize speech on this device...';
    case 'listening':
      return state.place === 'device'
        ? 'Listening. Recognition runs on this device.'
        : "Listening. Your audio goes to the browser vendor's speech service.";
  }
}

/** The microphone button's label for each state. */
export function micText(state: SpeechState): string {
  switch (state.kind) {
    case 'listening':
      return 'Turn off speech';
    case 'checking':
    case 'asking':
    case 'installing':
      return 'Cancel speech';
    default:
      return 'Turn on speech';
  }
}

function entryItem(doc: Document, { id, speaker, at, text }: TranscriptEntry): HTMLLIElement {
  const item = doc.createElement('li');
  item.dataset.id = id;
  const who = doc.createElement('span');
  who.className = 'transcript-speaker';
  who.textContent = speaker;
  const when = doc.createElement('time');
  when.className = 'transcript-time';
  when.dateTime = at;
  when.textContent = new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const words = doc.createElement('span');
  words.className = 'transcript-text';
  words.textContent = text;
  item.append(who, when, words);
  return item;
}

/**
 * Fills `panel` with the board's transcript and this browser's speech: the
 * question that says where recognition runs, with Start listening and Cancel;
 * a status line; the words not yet final; and every entry of `transcript`,
 * which it shows again on each change of the transcript, a peer's among them.
 * `opener` opens and closes the panel, and counts the entries. The panel opens
 * as speech starts to turn on, so that the person reads the question.
 *
 * Returns `show`, which shows a state of the speech, and `stop`, which stops
 * following the transcript.
 */
export function bindTranscriptPanel(
  { mic, opener, panel }: PanelElements,
  transcript: Y.Array<unknown>,
  actions: SpeechActions,
): { show(state: SpeechState): void; stop(): void } {
  const doc = panel.ownerDocument;
  const make = <K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text = ''): HTMLElementTagNameMap[K] => {
    const made = doc.createElement(tag);
    made.className = className;
    made.textContent = text;
    return made;
  };
  const button = (text: string, onClick: () => void): HTMLButtonElement => {
    const made = make('button', '', text);
    made.type = 'button';
    made.addEventListener('click', onClick);
    return made;
  };

  const status = make('p', 'speech-status');
  status.setAttribute('role', 'status');
  const notice = make('p', 'speech-notice');
  const ask = make('div', 'speech-ask');
  const askActions = make('div', 'speech-actions');
  askActions.append(button('Cancel', () => actions.decline()), button('Start listening', () => actions.agree()));
  ask.append(notice, askActions);
  ask.hidden = true;
  const heard = make('p', 'speech-heard');
  heard.hidden = true;
  const entries = make('ol', 'transcript-entries');
  const empty = make('p', 'transcript-empty', 'No one has said anything yet.');
  panel.replaceChildren(make('h2', '', 'Transcript'), status, ask, heard, entries, empty);

  const open = (shown: boolean) => {
    panel.hidden = !shown;
    opener.setAttribute('aria-expanded', String(shown));
  };
  opener.addEventListener('click', () => open(panel.hidden));
  mic.addEventListener('click', () => actions.toggle());
  open(false);

  const render = () => {
    const atEnd = entries.scrollTop + entries.clientHeight >= entries.scrollHeight - 4;
    const read = readTranscript(transcript);
    entries.replaceChildren(...read.map((entry) => entryItem(doc, entry)));
    empty.hidden = read.length > 0;
    opener.textContent = read.length === 0 ? 'Transcript' : `Transcript (${read.length})`;
    // Follow new entries, unless the person scrolled up to read earlier ones.
    if (atEnd) entries.scrollTop = entries.scrollHeight;
  };
  transcript.observe(render);
  render();

  return {
    show(state) {
      mic.disabled = state.kind === 'unsupported';
      mic.textContent = micText(state);
      mic.setAttribute('aria-pressed', String(state.kind === 'listening'));
      mic.title = state.kind === 'unsupported' ? "This browser doesn't offer speech recognition." : '';
      status.textContent = statusText(state);
      status.hidden = status.textContent === '';
      ask.hidden = state.kind !== 'asking';
      notice.textContent = state.kind === 'asking' ? state.notice : '';
      const words = state.kind === 'listening' ? state.heard : '';
      heard.textContent = words;
      heard.hidden = words === '';
      if (state.kind !== 'off' && state.kind !== 'unsupported') open(true);
    },
    stop() {
      transcript.unobserve(render);
    },
  };
}
