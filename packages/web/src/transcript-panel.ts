import { appendEntry, newEntryId, readTranscript, type TranscriptEntry } from '@chalkline/sync';
import type * as Y from 'yjs';
import type { SpeechState } from './speech';

/** The page's elements that `bindTranscriptPanel` binds. */
export interface PanelElements {
  /** The microphone button in the page's controls. */
  mic: HTMLButtonElement;
  /** The controls' Chat button, which opens and closes the panel. */
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

/** Who sends the messages typed in the panel's field, and the id and the time of each. */
export interface ChatOptions {
  /** The person's name, as the board shows it now. */
  speaker(): string;
  /** A new entry's id; random where left out. */
  newId?: () => string;
  /** The time now; the clock where left out. */
  now?: () => Date;
}

/** What the panel says under its title for each state. */
export function statusText(state: SpeechState): string {
  switch (state.kind) {
    case 'unsupported':
      return "This browser doesn't offer speech recognition, so type your messages below. The chat still shows what the others say and type.";
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

function entryItem(doc: Document, { id, speaker, at, text, via }: TranscriptEntry): HTMLLIElement {
  const item = doc.createElement('li');
  item.dataset.id = id;
  item.dataset.via = via;
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
 * Fills `panel` with the board's chat and this browser's speech: the question
 * that says where recognition runs, with Start listening and Cancel; a status
 * line; the words not yet final; every entry of `transcript`, which it shows
 * again on each change of the transcript, a peer's among them; and a message
 * field with Send, which, as Enter does, appends the words typed there to
 * `transcript` as a typed entry under `chat.speaker()`. `opener` opens and
 * closes the panel, and counts the entries; the panel's Close button, as
 * Escape in the panel does, closes it with one press and puts the focus back
 * on `opener`. The panel opens as speech starts to turn on, so that the
 * person reads the question.
 *
 * Returns `show`, which shows a state of the speech, and `stop`, which stops
 * following the transcript.
 */
export function bindTranscriptPanel(
  { mic, opener, panel }: PanelElements,
  transcript: Y.Array<unknown>,
  actions: SpeechActions,
  chat: ChatOptions,
): { show(state: SpeechState): void; stop(): void } {
  const doc = panel.ownerDocument;
  const newId = chat.newId ?? newEntryId;
  const now = chat.now ?? (() => new Date());
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

  const open = (shown: boolean) => {
    panel.hidden = !shown;
    opener.setAttribute('aria-expanded', String(shown));
  };
  const close = () => {
    open(false);
    opener.focus();
  };
  const closer = button('Close', close);
  closer.setAttribute('aria-label', 'Close the chat');
  const header = make('div', 'chat-header');
  header.append(make('h2', '', 'Chat'), closer);
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
  const empty = make('p', 'transcript-empty', 'No one has said or typed anything yet.');
  const field = make('input', 'chat-field');
  field.type = 'text';
  field.placeholder = 'Type a message';
  field.autocomplete = 'off';
  field.setAttribute('aria-label', 'Message');
  const send = (): void => {
    const words = field.value.trim();
    if (words === '') return;
    appendEntry(transcript, { id: newId(), speaker: chat.speaker(), at: now().toISOString(), text: words, via: 'typed' });
    field.value = '';
    // Show the person's own message, though they scrolled up to read earlier ones.
    entries.scrollTop = entries.scrollHeight;
  };
  field.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || event.isComposing) return;
    event.preventDefault();
    send();
  });
  const compose = make('div', 'chat-compose');
  compose.append(field, button('Send', send));
  panel.replaceChildren(header, status, ask, heard, entries, empty, compose);
  panel.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || event.isComposing) return;
    event.preventDefault();
    close();
  });

  opener.addEventListener('click', () => open(panel.hidden));
  mic.addEventListener('click', () => actions.toggle());
  open(false);

  const render = () => {
    const atEnd = entries.scrollTop + entries.clientHeight >= entries.scrollHeight - 4;
    const read = readTranscript(transcript);
    entries.replaceChildren(...read.map((entry) => entryItem(doc, entry)));
    empty.hidden = read.length > 0;
    opener.textContent = read.length === 0 ? 'Chat' : `Chat (${read.length})`;
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
