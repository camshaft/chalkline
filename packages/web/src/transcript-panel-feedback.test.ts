// @vitest-environment jsdom
import {
  answerFeedback,
  appendEntry,
  feedbackOf,
  getFeedback,
  transcriptOf,
  writeFeedback,
  type Feedback,
  type TranscriptEntry,
} from '@chalkline/sync';
import { describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { bindTranscriptPanel, chatItems, shapesText, type ChatItem } from './transcript-panel';

/** A time on 2026-11-07, `second` seconds after 01:02:00 UTC. */
const at = (second: number): string => new Date(Date.UTC(2026, 10, 7, 1, 2, second)).toISOString();

/** The time a person presses Reopen in these tests. */
const REOPENED = at(30);

const entry = (id: string, second: number): TranscriptEntry => ({
  id,
  speaker: 'Ada',
  at: at(second),
  text: `Entry ${id}`,
  via: 'typed',
});

const note = (id: string, second: number, shapes: string[] = [], answered = false): Feedback => ({
  id,
  by: 'Grace',
  at: at(second),
  text: `Feedback ${id}`,
  region: { x: 10, y: 20, width: 30, height: 40 },
  shapes,
  status: answered ? 'answered' : 'open',
  answer: answered ? { by: 'agent', at: at(second), text: 'Moved it' } : null,
  reopened: null,
});

/** Each item of `items` as its kind and its id. */
const order = (items: readonly ChatItem[]): string[] =>
  items.map((item) => (item.kind === 'entry' ? `entry ${item.entry.id}` : `feedback ${item.feedback.id}`));

function page(doc = new Y.Doc()) {
  const mic = document.createElement('button');
  const opener = document.createElement('button');
  const panel = document.createElement('aside');
  document.body.replaceChildren(mic, opener, panel);
  const actions = { toggle: vi.fn<() => void>(), agree: vi.fn<() => void>(), decline: vi.fn<() => void>() };
  const onShow = vi.fn<(record: Feedback) => void>();
  const transcript = transcriptOf(doc);
  const map = feedbackOf(doc);
  const bound = bindTranscriptPanel({ mic, opener, panel }, transcript, actions, { speaker: () => 'Ada', now: () => new Date(REOPENED) }, { map, show: onShow });
  return { opener, panel, transcript, map, onShow, ...bound };
}

/** The chat's list as the panel shows it: each item's kind and its id. */
const listed = (panel: Element): string[] =>
  [...panel.querySelectorAll<HTMLElement>('.transcript-entries li')].map(
    (item) => `${item.classList.contains('transcript-feedback') ? 'feedback' : 'entry'} ${item.dataset.id ?? ''}`,
  );

function feedbackItem(panel: Element, id: string): HTMLElement {
  const found = panel.querySelector<HTMLElement>(`.transcript-feedback[data-id="${id}"]`);
  if (found === null) throw new Error(`the panel lacks the feedback ${id}`);
  return found;
}

function showButton(panel: Element, id: string): HTMLButtonElement {
  const found = feedbackItem(panel, id).querySelector<HTMLButtonElement>('button.transcript-feedback-show');
  if (found === null) throw new Error(`the feedback ${id} lacks its Show button`);
  return found;
}

/** The Reopen button of the feedback `id` in the panel's list, or null where the list shows it without one. */
const reopenButton = (panel: Element, id: string): HTMLButtonElement | null =>
  feedbackItem(panel, id).querySelector<HTMLButtonElement>('button.transcript-feedback-reopen');

/** The agent's answer under the feedback `id` in the panel's list, or null where the list shows it without one. */
const answerOf = (panel: Element, id: string): HTMLElement | null =>
  feedbackItem(panel, id).querySelector<HTMLElement>('.transcript-feedback-answer');

const emptyText = (panel: Element): HTMLElement => {
  const found = panel.querySelector<HTMLElement>('.transcript-empty');
  if (found === null) throw new Error('the panel lacks its empty text');
  return found;
};

describe('the chat list', () => {
  it('puts each feedback before the first entry whose time is later, and after an entry of the same time', () => {
    const entries = [entry('e1', 1), entry('e3', 3), entry('e5', 5)];
    const notes = [note('n0', 0), note('n3', 3), note('n4', 4), note('n6', 6)];
    expect(order(chatItems(entries, notes))).toEqual([
      'feedback n0',
      'entry e1',
      'entry e3',
      'feedback n3',
      'feedback n4',
      'entry e5',
      'feedback n6',
    ]);
    expect(order(chatItems([], notes))).toEqual(['feedback n0', 'feedback n3', 'feedback n4', 'feedback n6']);
    expect(order(chatItems(entries, []))).toEqual(['entry e1', 'entry e3', 'entry e5']);
  });

  it('says how many shapes an area covers', () => {
    expect([shapesText(0), shapesText(1), shapesText(2)]).toEqual(['Covers 0 shapes', 'Covers 1 shape', 'Covers 2 shapes']);
  });
});

describe('feedback in the transcript panel', () => {
  it('lists each feedback among the entries in the order of their times, with its writer, time, text, shapes and Show', () => {
    const doc = new Y.Doc();
    appendEntry(transcriptOf(doc), entry('e1', 1));
    appendEntry(transcriptOf(doc), entry('e4', 4));
    writeFeedback(feedbackOf(doc), note('n2', 2, ['shape-1']));
    writeFeedback(feedbackOf(doc), note('n3', 3, ['shape-1', 'shape-2'], true));
    writeFeedback(feedbackOf(doc), note('n5', 5));
    const { opener, panel } = page(doc);
    expect(listed(panel)).toEqual(['entry e1', 'feedback n2', 'feedback n3', 'entry e4', 'feedback n5']);
    // The opener counts the feedback with the entries.
    expect(opener.textContent).toBe('Chat (5)');
    const item = feedbackItem(panel, 'n2');
    expect({
      status: item.dataset.status,
      writer: item.querySelector('.transcript-speaker')?.textContent,
      at: item.querySelector('time')?.dateTime,
      tag: item.querySelector('.transcript-feedback-tag')?.textContent,
      text: item.querySelector('.transcript-text')?.textContent,
      shapes: item.querySelector('.transcript-feedback-shapes')?.textContent,
      show: showButton(panel, 'n2').textContent,
    }).toEqual({
      status: 'open',
      writer: 'Grace',
      at: at(2),
      tag: 'Feedback',
      text: 'Feedback n2',
      shapes: 'Covers 1 shape',
      show: 'Show',
    });
    // An answered feedback stays in the list, with its status.
    expect(feedbackItem(panel, 'n3').dataset.status).toBe('answered');
    expect(feedbackItem(panel, 'n3').querySelector('.transcript-feedback-shapes')?.textContent).toBe('Covers 2 shapes');
    expect(feedbackItem(panel, 'n5').querySelector('.transcript-feedback-shapes')?.textContent).toBe('Covers 0 shapes');
  });

  it('calls show with the feedback whose Show the person presses', () => {
    const doc = new Y.Doc();
    writeFeedback(feedbackOf(doc), note('n1', 1, ['shape-1']));
    writeFeedback(feedbackOf(doc), note('n2', 2));
    const { panel, onShow } = page(doc);
    showButton(panel, 'n2').click();
    expect(onShow).toHaveBeenCalledTimes(1);
    expect(onShow).toHaveBeenCalledWith(note('n2', 2));
    showButton(panel, 'n1').click();
    expect(onShow).toHaveBeenLastCalledWith(note('n1', 1, ['shape-1']));
  });

  it('opens the panel when a feedback arrives, and not for the feedback it holds at the start or a change of one', () => {
    const doc = new Y.Doc();
    writeFeedback(feedbackOf(doc), note('n1', 1));
    const { opener, panel, map, transcript } = page(doc);
    expect(panel.hidden).toBe(true);
    // A feedback alone fills the list, so the text of an empty chat doesn't show.
    expect(emptyText(panel).hidden).toBe(true);
    // A new entry of the transcript doesn't open the panel.
    appendEntry(transcript, entry('e2', 2));
    expect(panel.hidden).toBe(true);
    // A change of a feedback the list shows, such as its answer, doesn't open it either.
    writeFeedback(map, note('n1', 1, [], true));
    expect(panel.hidden).toBe(true);
    expect(feedbackItem(panel, 'n1').dataset.status).toBe('answered');
    // A peer's new feedback opens it.
    const peer = new Y.Doc();
    writeFeedback(feedbackOf(peer), note('n3', 3, ['shape-1']));
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(peer));
    expect(panel.hidden).toBe(false);
    expect(opener.getAttribute('aria-expanded')).toBe('true');
    expect(listed(panel)).toEqual(['feedback n1', 'entry e2', 'feedback n3']);
    // The person's own new feedback opens it again once they closed it.
    opener.click();
    expect(panel.hidden).toBe(true);
    writeFeedback(map, note('n4', 4));
    expect(panel.hidden).toBe(false);
    expect(opener.textContent).toBe('Chat (4)');
  });

  it('stops following the feedback when the panel stops', () => {
    const { opener, panel, map, stop } = page();
    writeFeedback(map, note('n1', 1));
    expect(listed(panel)).toEqual(['feedback n1']);
    opener.click();
    expect(panel.hidden).toBe(true);
    stop();
    writeFeedback(map, note('n2', 2));
    expect(listed(panel)).toEqual(['feedback n1']);
    expect(opener.textContent).toBe('Chat (1)');
    expect(panel.hidden).toBe(true);
  });
});

describe('answers in the transcript panel', () => {
  it("shows the agent's answer under an answered feedback, with its writer, its time and its text, and Reopen", () => {
    const doc = new Y.Doc();
    writeFeedback(feedbackOf(doc), note('n1', 1));
    writeFeedback(feedbackOf(doc), { ...note('n2', 2, ['shape-1'], true), answer: { by: 'agent', at: at(9), text: 'Moved the box left' } });
    const { panel } = page(doc);
    // A feedback that wasn't answered shows neither an answer nor Reopen.
    expect(answerOf(panel, 'n1')).toBeNull();
    expect(reopenButton(panel, 'n1')).toBeNull();
    const answer = answerOf(panel, 'n2');
    expect({
      writer: answer?.querySelector('.transcript-speaker')?.textContent,
      at: answer?.querySelector('time')?.dateTime,
      tag: answer?.querySelector('.transcript-feedback-answer-tag')?.textContent,
      text: answer?.querySelector('.transcript-text')?.textContent,
    }).toEqual({ writer: 'agent', at: at(9), tag: 'Answer', text: 'Moved the box left' });
    // The answer comes under the feedback's own parts and its buttons, with Reopen after Show.
    const item = feedbackItem(panel, 'n2');
    expect(item.lastElementChild).toBe(answer);
    expect(item.querySelector('.transcript-speaker')?.textContent).toBe('Grace');
    expect(item.querySelector('.transcript-text')?.textContent).toBe('Feedback n2');
    expect(reopenButton(panel, 'n2')?.textContent).toBe('Reopen');
    expect(reopenButton(panel, 'n2')?.previousElementSibling).toBe(showButton(panel, 'n2'));
  });

  it("shows a peer's answer and Reopen as the answer arrives", () => {
    const doc = new Y.Doc();
    writeFeedback(feedbackOf(doc), note('n1', 1));
    const { panel } = page(doc);
    expect(answerOf(panel, 'n1')).toBeNull();
    const peer = new Y.Doc();
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(doc));
    answerFeedback(feedbackOf(peer), 'n1', { by: 'agent', at: at(5), text: 'Added a label' });
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(peer));
    expect(feedbackItem(panel, 'n1').dataset.status).toBe('answered');
    expect(answerOf(panel, 'n1')?.querySelector('.transcript-text')?.textContent).toBe('Added a label');
    expect(answerOf(panel, 'n1')?.querySelector('.transcript-feedback-answer-tag')?.textContent).toBe('Answer');
    expect(reopenButton(panel, 'n1')).not.toBeNull();
  });

  it('sets an answered feedback open again on Reopen with the time of the press, keeps its answer, and then shows it as its earlier answer', () => {
    const doc = new Y.Doc();
    const answered = note('n1', 1, ['shape-1'], true);
    writeFeedback(feedbackOf(doc), answered);
    const { opener, panel, map } = page(doc);
    const reopen = reopenButton(panel, 'n1');
    expect(reopen).not.toBeNull();
    reopen?.click();
    expect(getFeedback(map, 'n1')).toEqual({ ...answered, status: 'open', reopened: REOPENED });
    expect(feedbackItem(panel, 'n1').dataset.status).toBe('open');
    expect(reopenButton(panel, 'n1')).toBeNull();
    expect(answerOf(panel, 'n1')?.querySelector('.transcript-feedback-answer-tag')?.textContent).toBe('Earlier answer');
    expect(answerOf(panel, 'n1')?.querySelector('.transcript-text')?.textContent).toBe('Moved it');
    // A reopen changes a feedback the list shows, so it doesn't open the panel or change the count.
    expect(panel.hidden).toBe(true);
    expect(opener.textContent).toBe('Chat (1)');
  });

  it('reopens the feedback as the board holds it at the press, not as the list showed it before', () => {
    const doc = new Y.Doc();
    const answered = note('n1', 1, [], true);
    writeFeedback(feedbackOf(doc), answered);
    const { panel, map } = page(doc);
    // The Reopen button as the list showed it before a peer reopened the feedback and the agent answered it again.
    const earlier = reopenButton(panel, 'n1');
    expect(earlier).not.toBeNull();
    const peer = new Y.Doc();
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(doc));
    writeFeedback(feedbackOf(peer), { ...answered, status: 'open' });
    const again = { by: 'agent', at: at(8), text: 'Moved it again' };
    answerFeedback(feedbackOf(peer), 'n1', again);
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(peer));
    earlier?.click();
    expect(getFeedback(map, 'n1')).toEqual({ ...answered, status: 'open', answer: again, reopened: REOPENED });
  });

  it("doesn't write anything on a Reopen of a feedback that the board holds open already", () => {
    const doc = new Y.Doc();
    const answered = note('n1', 1, [], true);
    writeFeedback(feedbackOf(doc), answered);
    const { panel } = page(doc);
    // The Reopen button as the list showed it before a peer's reopen reached this page.
    const earlier = reopenButton(panel, 'n1');
    expect(earlier).not.toBeNull();
    const peer = new Y.Doc();
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(doc));
    writeFeedback(feedbackOf(peer), { ...answered, status: 'open' });
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(peer));
    const writes = vi.fn();
    doc.on('update', writes);
    earlier?.click();
    expect(writes).not.toHaveBeenCalled();
    expect(feedbackItem(panel, 'n1').dataset.status).toBe('open');
  });
});
