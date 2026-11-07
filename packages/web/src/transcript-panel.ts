import { appendEntry, listFeedback, newEntryId, readTranscript, type Feedback, type TranscriptEntry } from '@chalkline/sync';
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

/** The board's feedback, which the panel lists among the chat's entries, and what its Show button does. */
export interface PanelFeedback {
  /** The board's `feedback` map. */
  map: Y.Map<unknown>;
  /** Scrolls and zooms the canvas to a feedback's area, and outlines that area. */
  show(record: Feedback): void;
}

/** An item of the chat's list: an entry of the transcript, or a feedback. */
export type ChatItem = { kind: 'entry'; entry: TranscriptEntry } | { kind: 'feedback'; feedback: Feedback };

/**
 * The chat's list: `entries` in their order, with each feedback of `notes`, which `listFeedback` sorts by
 * `at`, before the first entry whose time is later than its own, so that the list follows the times. A
 * feedback goes after an entry of the same time.
 */
export function chatItems(entries: readonly TranscriptEntry[], notes: readonly Feedback[]): ChatItem[] {
  const items: ChatItem[] = [];
  let next = 0;
  for (const entry of entries) {
    const at = Date.parse(entry.at);
    for (let note = notes[next]; note !== undefined && Date.parse(note.at) < at; note = notes[next]) {
      items.push({ kind: 'feedback', feedback: note });
      next += 1;
    }
    items.push({ kind: 'entry', entry });
  }
  for (const note of notes.slice(next)) items.push({ kind: 'feedback', feedback: note });
  return items;
}

/** How many shapes a feedback's area covers, as the chat says it. */
export function shapesText(count: number): string {
  return `Covers ${count} ${count === 1 ? 'shape' : 'shapes'}`;
}

/** The most lines the message field grows to; past them, its text scrolls inside the field. */
export const MESSAGE_LINES = 6;

/** How many pixels above the end of the chat's list the person may have scrolled and still read its newest entry. */
export const BOTTOM_SLACK = 4;

/** Whether `list` shows the end of its entries, to within `BOTTOM_SLACK` pixels. */
function atBottom(list: HTMLElement): boolean {
  return list.scrollTop + list.clientHeight >= list.scrollHeight - BOTTOM_SLACK;
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

/**
 * Fits the height of the panel's message field to its text: an empty field has the one line of its one
 * row, and a field with text a line for each line its text needs, up to `maxLines`, past which the text
 * scrolls inside the field. It reads the height of a line, the padding and the border from the field's
 * style.
 */
export function fitMessageField(field: HTMLTextAreaElement, maxLines = MESSAGE_LINES): void {
  field.style.height = 'auto';
  const needed = field.scrollHeight;
  // An empty field, and one the page doesn't show, go back to their one row.
  if (field.value === '' || needed === 0) {
    field.style.height = '';
    field.style.overflowY = '';
    return;
  }
  const style = field.ownerDocument.defaultView?.getComputedStyle(field);
  const px = (value: string | undefined): number => Number.parseFloat(value ?? '') || 0;
  const padding = px(style?.paddingTop) + px(style?.paddingBottom);
  const line = px(style?.lineHeight);
  const most = line > 0 ? maxLines * line + padding : Number.POSITIVE_INFINITY;
  // scrollHeight holds the text and the padding; a border-box height holds the border as well, and a
  // content-box height holds neither the padding nor the border.
  const outside = style?.boxSizing === 'border-box' ? px(style.borderTopWidth) + px(style.borderBottomWidth) : -padding;
  field.style.height = `${Math.min(needed, most) + outside}px`;
  field.style.overflowY = needed > most ? 'auto' : 'hidden';
}

/** The part of the window's visual viewport that `followKeyboard` reads: where the visible part of the page ends. */
export interface KeyboardViewport extends EventTarget {
  /** The visible part's height. */
  readonly height: number;
  /** How far the visible part's top lies below the page's top. */
  readonly offsetTop: number;
}

/**
 * Keeps `panel` above a phone's on-screen keyboard: on each resize and scroll of `viewport`, the visible
 * part of the page, it sets `--keyboard-inset` on the panel to the height of the page below that part, which
 * the keyboard covers, and which the page's stylesheet adds to the panel's distance from the page's bottom.
 * `layoutHeight` is the page's height, which the keyboard doesn't change. Returns `stop`, which stops
 * following the viewport.
 */
export function followKeyboard(panel: HTMLElement, viewport: KeyboardViewport, layoutHeight: () => number): () => void {
  const update = (): void => {
    const covered = Math.max(0, Math.round(layoutHeight() - (viewport.offsetTop + viewport.height)));
    panel.style.setProperty('--keyboard-inset', `${covered}px`);
  };
  viewport.addEventListener('resize', update);
  viewport.addEventListener('scroll', update);
  update();
  return () => {
    viewport.removeEventListener('resize', update);
    viewport.removeEventListener('scroll', update);
  };
}

/** A list item's speaker, its time and its words, as the chat shows each entry and each feedback. */
function itemParts(doc: Document, speaker: string, at: string, text: string): [HTMLSpanElement, HTMLTimeElement, HTMLSpanElement] {
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
  return [who, when, words];
}

function entryItem(doc: Document, { id, speaker, at, text, via }: TranscriptEntry): HTMLLIElement {
  const item = doc.createElement('li');
  item.dataset.id = id;
  item.dataset.via = via;
  item.append(...itemParts(doc, speaker, at, text));
  return item;
}

/** A feedback in the chat's list: its writer, its time, its text, how many shapes it covers, and Show. */
function feedbackItem(doc: Document, record: Feedback, show: (record: Feedback) => void): HTMLLIElement {
  const item = doc.createElement('li');
  item.className = 'transcript-feedback';
  item.dataset.id = record.id;
  item.dataset.status = record.status;
  const [who, when, words] = itemParts(doc, record.by, record.at, record.text);
  const tag = doc.createElement('span');
  tag.className = 'transcript-feedback-tag';
  tag.textContent = 'Feedback';
  const covers = doc.createElement('span');
  covers.className = 'transcript-feedback-shapes';
  covers.textContent = shapesText(record.shapes.length);
  const showButton = doc.createElement('button');
  showButton.type = 'button';
  showButton.className = 'transcript-feedback-show';
  showButton.textContent = 'Show';
  showButton.title = 'Scroll and zoom the board to the area of this feedback';
  showButton.addEventListener('click', () => show(record));
  item.append(who, when, tag, words, covers, showButton);
  return item;
}

/**
 * Fills `panel` with the board's chat and this browser's speech: the question
 * that says where recognition runs, with Start listening and Cancel; a status
 * line; the words not yet final; every entry of `transcript`, which it shows
 * again on each change of the transcript, a peer's among them; and a message
 * field with Send, which, as Enter does, appends the words typed there to
 * `transcript` as a typed entry under `chat.speaker()`. Shift+Enter adds a line
 * break to the message, and the field grows with its text up to
 * `MESSAGE_LINES` lines, and goes back to one line once the message is sent.
 * The list of entries opens on its newest entry, and follows each new one
 * while the person reads its end; where they scrolled up to read earlier
 * ones, a new entry leaves the list where it is and shows a New messages
 * button, which scrolls to the end, as sending a message does.
 * Where `feedback` is given, the list shows each feedback of its map among
 * the entries, in the order of their times, with its writer, its time, its
 * text, how many shapes its area covers and a Show button, which calls
 * `feedback.show`; and the panel opens when a feedback arrives.
 * `opener` opens and closes the panel, and counts the entries and the
 * feedback; the panel's Close button, as Escape in the panel does, closes it
 * with one press and puts the focus back on `opener`. The panel opens as
 * speech starts to turn on, so that the person reads the question.
 *
 * Returns `show`, which shows a state of the speech, and `stop`, which stops
 * following the transcript and the feedback.
 */
export function bindTranscriptPanel(
  { mic, opener, panel }: PanelElements,
  transcript: Y.Array<unknown>,
  actions: SpeechActions,
  chat: ChatOptions,
  feedback?: PanelFeedback,
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
    const opening = shown && panel.hidden;
    panel.hidden = !shown;
    opener.setAttribute('aria-expanded', String(shown));
    // The panel opens on its newest entry; a state of the speech that keeps it open doesn't move the list.
    if (opening) scrollToEnd();
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
  const newer = button('New messages', () => scrollToEnd());
  newer.className = 'chat-new-messages';
  newer.hidden = true;
  // Whether the list follows the newest entry: true while the person reads its end, and false once they
  // scroll up to read earlier entries.
  let following = true;
  const scrollToEnd = (): void => {
    following = true;
    newer.hidden = true;
    entries.scrollTop = entries.scrollHeight;
  };
  entries.addEventListener('scroll', () => {
    following = atBottom(entries);
    if (following) newer.hidden = true;
  });
  const empty = make('p', 'transcript-empty', 'No one has said or typed anything yet.');
  const field = make('textarea', 'chat-field');
  field.rows = 1;
  field.placeholder = 'Type a message';
  field.autocomplete = 'off';
  // A phone's keyboard labels its Enter key Send, which Enter does here.
  field.setAttribute('enterkeyhint', 'send');
  field.setAttribute('aria-label', 'Message');
  const send = (): void => {
    const words = field.value.trim();
    if (words === '') return;
    // Show the person's own message, though they scrolled up to read earlier ones.
    following = true;
    appendEntry(transcript, { id: newId(), speaker: chat.speaker(), at: now().toISOString(), text: words, via: 'typed' });
    field.value = '';
    fitMessageField(field);
    scrollToEnd();
  };
  field.addEventListener('input', () => fitMessageField(field));
  field.addEventListener('keydown', (event) => {
    // Shift+Enter, and Enter while an input method composes a character, go to the field as other keys do.
    if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
    event.preventDefault();
    send();
  });
  const compose = make('div', 'chat-compose');
  compose.append(field, button('Send', send));
  panel.replaceChildren(header, status, ask, heard, entries, newer, empty, compose);
  panel.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || event.isComposing) return;
    event.preventDefault();
    close();
  });

  opener.addEventListener('click', () => open(panel.hidden));
  mic.addEventListener('click', () => actions.toggle());
  open(false);

  const showFeedback = (record: Feedback): void => feedback?.show(record);
  let entryCount = 0;
  // The ids of the feedback the list showed, so that the panel opens for each one that arrives after.
  let known: ReadonlySet<string> | null = null;
  const render = () => {
    const notes: Feedback[] = feedback === undefined ? [] : listFeedback(feedback.map);
    const items = chatItems(readTranscript(transcript), notes);
    const arrived = items.length > entryCount;
    entryCount = items.length;
    entries.replaceChildren(
      ...items.map((item) => (item.kind === 'entry' ? entryItem(doc, item.entry) : feedbackItem(doc, item.feedback, showFeedback))),
    );
    empty.hidden = items.length > 0;
    opener.textContent = items.length === 0 ? 'Chat' : `Chat (${items.length})`;
    // Follow new entries, unless the person scrolled up to read earlier ones: then say that new ones came.
    if (following) entries.scrollTop = entries.scrollHeight;
    else if (arrived) newer.hidden = false;
    // The panel opens when a feedback arrives, the person's own among them; the feedback that the board
    // holds as the panel starts doesn't open it.
    const before = known;
    known = new Set(notes.map((note) => note.id));
    if (before !== null && notes.some((note) => !before.has(note.id))) open(true);
  };
  transcript.observe(render);
  feedback?.map.observe(render);
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
      feedback?.map.unobserve(render);
    },
  };
}
