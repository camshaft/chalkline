// @vitest-environment jsdom
import {
  appendEntry,
  connectDoc,
  MemoryNetwork,
  readTranscript,
  transcriptOf,
  type TranscriptEntry,
  type TranscriptVia,
} from '@chalkline/sync';
import { describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { placeNotice } from './speech';
import { bindTranscriptPanel, followKeyboard, MESSAGE_LINES } from './transcript-panel';

const AT = '2026-11-07T01:02:03.000Z';

const entry = (id: string, speaker: string, text: string, via: TranscriptVia = 'speech'): TranscriptEntry => ({
  id,
  speaker,
  at: AT,
  text,
  via,
});

function page(transcript = transcriptOf(new Y.Doc()), speaker = () => 'Ada') {
  const mic = document.createElement('button');
  const opener = document.createElement('button');
  const panel = document.createElement('aside');
  document.body.replaceChildren(mic, opener, panel);
  const actions = { toggle: vi.fn<() => void>(), agree: vi.fn<() => void>(), decline: vi.fn<() => void>() };
  let made = 0;
  const bound = bindTranscriptPanel({ mic, opener, panel }, transcript, actions, {
    speaker,
    newId: () => `typed-${(made += 1)}`,
    now: () => new Date(AT),
  });
  const field = panel.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message"]');
  if (field === null) throw new Error('the panel lacks its message field');
  return { mic, opener, panel, actions, transcript, field, ...bound };
}

function part(panel: Element, selector: string): HTMLElement {
  const found = panel.querySelector<HTMLElement>(selector);
  if (found === null) throw new Error(`the panel lacks ${selector}`);
  return found;
}

function button(panel: Element, text: string): HTMLButtonElement {
  const found = [...panel.querySelectorAll('button')].find((candidate) => candidate.textContent === text);
  if (found === undefined) throw new Error(`the panel lacks the ${text} button`);
  return found;
}

const shown = (panel: Element) =>
  [...panel.querySelectorAll('.transcript-entries li')].map((item) => ({
    id: (item as HTMLElement).dataset.id,
    speaker: item.querySelector('.transcript-speaker')?.textContent,
    at: item.querySelector('time')?.dateTime,
    text: item.querySelector('.transcript-text')?.textContent,
    via: (item as HTMLElement).dataset.via,
  }));

const enter = (field: HTMLTextAreaElement, init: KeyboardEventInit = {}) =>
  field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, ...init }));

/**
 * jsdom doesn't lay text out, so the field here takes a style of 20px lines, 4px of padding and a 1px border
 * in a border-box, and its scrollHeight is the padding and a line for each 30 characters, or fewer, of
 * each line of its text.
 */
function laidOut(field: HTMLTextAreaElement) {
  field.style.setProperty('box-sizing', 'border-box');
  field.style.setProperty('line-height', '20px');
  field.style.setProperty('padding-top', '4px');
  field.style.setProperty('padding-bottom', '4px');
  field.style.setProperty('border-top-style', 'solid');
  field.style.setProperty('border-bottom-style', 'solid');
  field.style.setProperty('border-top-width', '1px');
  field.style.setProperty('border-bottom-width', '1px');
  const style = getComputedStyle(field);
  expect([style.boxSizing, style.lineHeight, style.paddingTop, style.paddingBottom, style.borderTopWidth, style.borderBottomWidth]).toEqual([
    'border-box',
    '20px',
    '4px',
    '4px',
    '1px',
    '1px',
  ]);
  Object.defineProperty(field, 'scrollHeight', {
    configurable: true,
    get: () => 8 + 20 * field.value.split('\n').reduce((lines, line) => lines + Math.max(1, Math.ceil(line.length / 30)), 0),
  });
  return (text: string) => {
    field.value = text;
    field.dispatchEvent(new Event('input', { bubbles: true }));
  };
}

describe('the chat panel', () => {
  it('shows each entry with its speaker, time and words, and leaves out a value that is not an entry', () => {
    const transcript = transcriptOf(new Y.Doc());
    appendEntry(transcript, entry('one', 'Ada', 'draw a box'));
    transcript.push(['not an entry']);
    const { panel, opener } = page(transcript);

    expect(shown(panel)).toEqual([{ id: 'one', speaker: 'Ada', at: AT, text: 'draw a box', via: 'speech' }]);
    expect(part(panel, '.transcript-empty').hidden).toBe(true);
    expect(opener.textContent).toBe('Chat (1)');
  });

  it('says that no one has spoken where the transcript is empty', () => {
    const { panel, opener } = page();

    expect(shown(panel)).toEqual([]);
    expect(part(panel, '.transcript-empty').hidden).toBe(false);
    expect(part(panel, 'h2').textContent).toBe('Chat');
    expect(opener.textContent).toBe('Chat');
  });

  it("appends the words typed in its field as a typed entry, under the person's name at the time, on Send and on Enter", () => {
    let name = 'Ada';
    const { panel, opener, transcript, field } = page(undefined, () => name);

    field.value = '  draw a box  ';
    button(panel, 'Send').click();
    expect(field.value).toBe('');
    name = 'Ada Lovelace';
    field.value = 'and an arrow';
    expect(enter(field)).toBe(false);

    expect(readTranscript(transcript)).toEqual([
      entry('typed-1', 'Ada', 'draw a box', 'typed'),
      entry('typed-2', 'Ada Lovelace', 'and an arrow', 'typed'),
    ]);
    expect(field.value).toBe('');
    expect(shown(panel).map(({ speaker, text, via }) => `${via} ${speaker}: ${text}`)).toEqual([
      'typed Ada: draw a box',
      'typed Ada Lovelace: and an arrow',
    ]);
    expect(opener.textContent).toBe('Chat (2)');
  });

  it("doesn't send a blank message, Enter while the person composes a character, or another key", () => {
    const { panel, transcript, field } = page();

    field.value = '   ';
    button(panel, 'Send').click();
    enter(field);
    field.value = 'draw';
    enter(field, { isComposing: true });
    field.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }));

    expect(transcript.length).toBe(0);
    expect(field.value).toBe('draw');
  });

  it("leaves Shift+Enter to the field, which adds a line break, and keeps a sent message's line breaks in the chat", () => {
    const { panel, transcript, field } = page();

    field.value = 'draw a box';
    // The keydown isn't cancelled, so the browser adds the line break to the field.
    expect(enter(field, { shiftKey: true })).toBe(true);
    expect(transcript.length).toBe(0);
    expect(field.value).toBe('draw a box');

    field.value = '\ndraw a box\nand an arrow\n\nlabelled "next"  \n';
    expect(enter(field)).toBe(false);

    expect(readTranscript(transcript)).toEqual([entry('typed-1', 'Ada', 'draw a box\nand an arrow\n\nlabelled "next"', 'typed')]);
    expect(shown(panel).map(({ text }) => text)).toEqual(['draw a box\nand an arrow\n\nlabelled "next"']);
  });

  it('is a field of one row that grows with its text up to six lines, past which its text scrolls inside it', () => {
    const { field } = page();
    const type = laidOut(field);

    expect(MESSAGE_LINES).toBe(6);
    expect(field.rows).toBe(1);
    expect(field.style.height).toBe('');

    // One line: 20px, the padding and the border.
    type('draw a box');
    expect(field.style.height).toBe('30px');
    expect(field.style.overflowY).toBe('hidden');

    // A line of 80 characters wraps onto 3 lines.
    type('x'.repeat(80));
    expect(field.style.height).toBe('70px');

    // Two lines with a line break, and back to one as the person deletes the second.
    type('draw a box\nand an arrow');
    expect(field.style.height).toBe('50px');
    type('draw a box');
    expect(field.style.height).toBe('30px');

    // Six lines, the most, fit without a scroll bar.
    type(['one', 'two', 'three', 'four', 'five', 'six'].join('\n'));
    expect(field.style.height).toBe('130px');
    expect(field.style.overflowY).toBe('hidden');

    // Past six lines the field stays at six, and its text scrolls inside it.
    type(Array.from({ length: 10 }, (_, line) => `line ${line + 1}`).join('\n'));
    expect(field.style.height).toBe('130px');
    expect(field.style.overflowY).toBe('auto');
    type('x'.repeat(30 * 9));
    expect(field.style.height).toBe('130px');
    expect(field.style.overflowY).toBe('auto');

    // Deleting every character takes it back to its one row.
    type('');
    expect(field.style.height).toBe('');
    expect(field.style.overflowY).toBe('');
  });

  it("measures a content-box field without its padding, doesn't cap a field whose line height it can't read, and keeps a field the page doesn't show at its one row", () => {
    const { field } = page();
    expect(field.getAttribute('enterkeyhint')).toBe('send');
    let height = 0;
    Object.defineProperty(field, 'scrollHeight', { configurable: true, get: () => height });
    const type = (text: string) => {
      field.value = text;
      field.dispatchEvent(new Event('input', { bubbles: true }));
    };

    // The page doesn't show the field, so its scrollHeight is 0: it keeps its one row.
    type('draw a box');
    expect(field.style.height).toBe('');

    // Without a line height to read, the field takes the height its text needs.
    height = 500;
    type('draw a box');
    expect(field.style.height).toBe('500px');
    expect(field.style.overflowY).toBe('hidden');

    // A content-box height leaves out the padding that scrollHeight holds.
    field.style.setProperty('box-sizing', 'content-box');
    field.style.setProperty('line-height', '20px');
    field.style.setProperty('padding-top', '4px');
    field.style.setProperty('padding-bottom', '4px');
    height = 28;
    type('draw a box');
    expect(field.style.height).toBe('20px');
    height = 208;
    type('ten lines of text');
    expect(field.style.height).toBe('120px');
    expect(field.style.overflowY).toBe('auto');
  });

  it('goes back to one line once a message is sent, on Send and on Enter', () => {
    const { panel, transcript, field } = page();
    const type = laidOut(field);

    type(Array.from({ length: 8 }, (_, line) => `line ${line + 1}`).join('\n'));
    expect(field.style.height).toBe('130px');
    expect(enter(field)).toBe(false);
    expect(field.value).toBe('');
    expect(field.style.height).toBe('');
    expect(field.style.overflowY).toBe('');

    type('draw a box\nand an arrow\nand a circle');
    expect(field.style.height).toBe('70px');
    button(panel, 'Send').click();
    expect(field.style.height).toBe('');
    expect(field.rows).toBe(1);

    expect(readTranscript(transcript).map(({ text }) => text)).toEqual([
      Array.from({ length: 8 }, (_, line) => `line ${line + 1}`).join('\n'),
      'draw a box\nand an arrow\nand a circle',
    ]);
  });

  it('marks how each entry came, and shows an entry written before the chat, without `via`, as speech', () => {
    const transcript = transcriptOf(new Y.Doc());
    transcript.push([{ id: 'old', speaker: 'Grace', at: AT, text: 'from before the chat' }]);
    appendEntry(transcript, entry('typed', 'Ada', 'draw a box', 'typed'));
    appendEntry(transcript, entry('posted', 'claude-code', 'I drew a box', 'agent'));
    const { panel } = page(transcript);

    expect(shown(panel).map(({ id, via }) => `${id}: ${via}`)).toEqual(['old: speech', 'typed: typed', 'posted: agent']);
  });

  it("shows a peer's entry as it arrives", () => {
    const network = new MemoryNetwork();
    const mine = new Y.Doc();
    const theirs = new Y.Doc();
    connectDoc(mine, network.join('a'));
    connectDoc(theirs, network.join('b'));
    network.flush();
    const { panel, opener } = page(transcriptOf(mine));

    appendEntry(transcriptOf(theirs), entry('two', 'Grace', 'and an arrow'));
    network.flush();

    expect(shown(panel).map(({ speaker, text }) => `${speaker}: ${text}`)).toEqual(['Grace: and an arrow']);
    expect(opener.textContent).toBe('Chat (1)');
  });

  it('opens and closes with its button, which says whether it is open', () => {
    const { panel, opener } = page();
    expect(panel.hidden).toBe(true);
    expect(opener.getAttribute('aria-expanded')).toBe('false');

    opener.click();
    expect(panel.hidden).toBe(false);
    expect(opener.getAttribute('aria-expanded')).toBe('true');

    opener.click();
    expect(panel.hidden).toBe(true);
  });

  it('closes with one press of its Close button, or Escape in the panel, and puts the focus back on its opener', () => {
    const { panel, opener, field } = page();
    opener.click();
    const closer = button(panel, 'Close');
    expect(closer.getAttribute('aria-label')).toBe('Close the chat');

    closer.click();
    expect(panel.hidden).toBe(true);
    expect(opener.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(opener);

    opener.click();
    field.focus();
    const escape = (init: KeyboardEventInit = {}) =>
      field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true, ...init }));
    escape({ isComposing: true });
    expect(panel.hidden).toBe(false);
    escape();
    expect(panel.hidden).toBe(true);
    expect(opener.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(opener);
  });

  it('turns speech on and off with the microphone button', () => {
    const { mic, actions, show } = page();
    show({ kind: 'off' });

    expect(mic.textContent).toBe('Turn on speech');
    expect(mic.getAttribute('aria-pressed')).toBe('false');
    mic.click();
    expect(actions.toggle).toHaveBeenCalledTimes(1);

    show({ kind: 'listening', place: 'device', heard: '' });
    expect(mic.textContent).toBe('Turn off speech');
    expect(mic.getAttribute('aria-pressed')).toBe('true');
  });

  it('opens on the question, says where recognition runs, and answers it with its two buttons', () => {
    const { panel, actions, show } = page();
    const notice = placeNotice('service', 'en-US');

    show({ kind: 'asking', place: 'service', notice });

    expect(panel.hidden).toBe(false);
    expect(part(panel, '.speech-ask').hidden).toBe(false);
    expect(part(panel, '.speech-notice').textContent).toBe(notice);
    button(panel, 'Start listening').click();
    button(panel, 'Cancel').click();
    expect(actions.agree).toHaveBeenCalledTimes(1);
    expect(actions.decline).toHaveBeenCalledTimes(1);

    show({ kind: 'off' });
    expect(part(panel, '.speech-ask').hidden).toBe(true);
  });

  it('says where recognition runs while it listens, and shows the words not yet final', () => {
    const { panel, show } = page();

    show({ kind: 'listening', place: 'service', heard: 'draw a' });

    expect(part(panel, '.speech-status').textContent).toBe("Listening. Your audio goes to the browser vendor's speech service.");
    expect(part(panel, '.speech-heard').textContent).toBe('draw a');
    expect(part(panel, '.speech-heard').hidden).toBe(false);

    show({ kind: 'listening', place: 'device', heard: '' });

    expect(part(panel, '.speech-status').textContent).toBe('Listening. Recognition runs on this device.');
    expect(part(panel, '.speech-heard').hidden).toBe(true);
  });

  it('says why speech stopped', () => {
    const { panel, show } = page();

    show({ kind: 'off', error: "Speech stopped: the browser didn't find a microphone." });

    expect(part(panel, '.speech-status').textContent).toBe("Speech stopped: the browser didn't find a microphone.");
    expect(part(panel, '.speech-status').hidden).toBe(false);
  });

  it("turns the microphone button off in a browser that doesn't offer speech recognition", () => {
    const { mic, panel, show } = page();

    show({ kind: 'unsupported' });

    expect(mic.disabled).toBe(true);
    expect(mic.title).toBe("This browser doesn't offer speech recognition.");
    expect(part(panel, '.speech-status').textContent).toContain("doesn't offer speech recognition");
    expect(panel.hidden).toBe(true);
  });

  it('stops following the transcript once stopped', () => {
    const { panel, transcript, stop } = page();

    stop();
    appendEntry(transcript, entry('one', 'Ada', 'draw a box'));

    expect(shown(panel)).toEqual([]);
  });
});

describe('followKeyboard', () => {
  it('raises the panel above the part of the page that a phone keyboard covers, and stops once stopped', () => {
    const panel = document.createElement('aside');
    const viewport = Object.assign(new EventTarget(), { height: 800, offsetTop: 0 });
    const inset = () => panel.style.getPropertyValue('--keyboard-inset');
    const stop = followKeyboard(panel, viewport, () => 800);
    expect(inset()).toBe('0px');

    // The keyboard opens over the bottom 320px of an 800px page.
    viewport.height = 480;
    viewport.dispatchEvent(new Event('resize'));
    expect(inset()).toBe('320px');

    // The browser scrolls the visible part 120px down the page, so the keyboard covers 200px of it.
    viewport.offsetTop = 120;
    viewport.dispatchEvent(new Event('scroll'));
    expect(inset()).toBe('200px');

    // A visible part taller than the page, as where a phone hides its toolbar, doesn't lower the panel.
    viewport.height = 860;
    viewport.offsetTop = 0;
    viewport.dispatchEvent(new Event('resize'));
    expect(inset()).toBe('0px');

    stop();
    viewport.height = 400;
    viewport.dispatchEvent(new Event('resize'));
    expect(inset()).toBe('0px');
  });
});
