import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  answerFeedback,
  feedbackKind,
  feedbackOf,
  getFeedback,
  listFeedback,
  readFeedback,
  writeFeedback,
  type Feedback,
  type FeedbackAnswer,
} from './feedback';
import { MemoryNetwork } from './memory-transport';
import { connectDoc } from './sync';

const feedback = (id: string, at = '2026-11-07T01:02:03.000Z'): Feedback => ({
  id,
  by: 'Ada',
  at,
  text: `move the boxes of ${id}`,
  region: { x: -40, y: 12.5, width: 300, height: 180 },
  shapes: ['box-1', 'arrow-2'],
  status: 'open',
  answer: null,
});

const answer = (text = 'moved the two boxes left'): FeedbackAnswer => ({
  by: 'claude-code',
  at: '2026-11-07T01:05:00.000Z',
  text,
});

function join(network: MemoryNetwork, id: string): Y.Doc {
  const doc = new Y.Doc();
  connectDoc(doc, network.join(id));
  return doc;
}

describe('readFeedback', () => {
  it('reads an open feedback, an answered one and a reopened one that keeps its answer', () => {
    const open = feedback('one');
    const answered: Feedback = { ...open, status: 'answered', answer: answer() };
    const reopened: Feedback = { ...answered, status: 'open' };

    expect(readFeedback(open)).toEqual(open);
    expect(readFeedback(answered)).toEqual(answered);
    expect(readFeedback(reopened)).toEqual(reopened);
  });

  it('reads a feedback over an empty area, whose `shapes` is empty', () => {
    expect(readFeedback({ ...feedback('one'), shapes: [] })?.shapes).toEqual([]);
  });

  it('reads the eight fields, and leaves out the others, in the region and the answer too', () => {
    const value = {
      ...feedback('one'),
      status: 'answered',
      extra: 'dropped',
      region: { ...feedback('one').region, extra: 'dropped' },
      answer: { ...answer(), extra: 'dropped' },
    };

    expect(readFeedback(value)).toEqual({ ...feedback('one'), status: 'answered', answer: answer() });
  });

  it('answers a copy, which a change leaves as the value was', () => {
    const value = feedback('one');
    const record = readFeedback(value);
    record?.shapes.push('box-9');
    if (record) record.region.x = 99;

    expect(value).toEqual(feedback('one'));
  });

  it('reads a value that lacks one of the eight fields as null', () => {
    for (const field of ['id', 'by', 'at', 'text', 'region', 'shapes', 'status', 'answer']) {
      const value: Record<string, unknown> = { ...feedback('one') };
      delete value[field];
      expect(readFeedback(value), field).toBeNull();
      expect(readFeedback({ ...feedback('one'), [field]: undefined }), field).toBeNull();
    }
  });

  it('reads a value that holds a field of the wrong type, or a blank text, as null', () => {
    const open = feedback('one');
    for (const value of [
      { ...open, id: 7 },
      { ...open, id: '' },
      { ...open, by: ['Ada'] },
      { ...open, by: '  ' },
      { ...open, at: 1762477323000 },
      { ...open, text: '   ' },
      { ...open, text: { words: 'move' } },
      { ...open, region: [0, 0, 10, 10] },
      { ...open, region: 'here' },
      { ...open, region: { x: 0, y: 0, width: 10 } },
      { ...open, region: { x: '0', y: 0, width: 10, height: 10 } },
      { ...open, region: { x: 0, y: Number.NaN, width: 10, height: 10 } },
      { ...open, region: { x: 0, y: 0, width: Number.POSITIVE_INFINITY, height: 10 } },
      { ...open, shapes: 'box-1' },
      { ...open, shapes: ['box-1', 2] },
      { ...open, status: 'closed' },
      { ...open, status: 'Open' },
      { ...open, status: null },
      { ...open, answer: 'moved them' },
      { ...open, answer: [answer()] },
      { ...open, answer: { by: 'claude-code', at: answer().at } },
      { ...open, answer: { ...answer(), by: '' } },
      { ...open, answer: { ...answer(), text: 4 } },
      { ...open, status: 'answered', answer: { ...answer(), at: 1762477500000 } },
    ]) {
      expect(readFeedback(value), JSON.stringify(value)).toBeNull();
    }
  });

  it("reads a value whose time, or whose answer's time, doesn't parse as null", () => {
    expect(readFeedback({ ...feedback('one'), at: 'yesterday' })).toBeNull();
    expect(readFeedback({ ...feedback('one'), status: 'answered', answer: { ...answer(), at: 'just now' } })).toBeNull();
  });

  it("reads a value that isn't an object as null", () => {
    for (const value of [null, undefined, 'move the boxes', 3, [feedback('one')]]) {
      expect(readFeedback(value)).toBeNull();
    }
  });
});

describe('the feedback map', () => {
  it("is the document's `feedback` map, from each feedback's id to its record", () => {
    const doc = new Y.Doc();
    writeFeedback(feedbackOf(doc), feedback('one'));

    expect(doc.getMap('feedback').toJSON()).toEqual({ one: feedback('one') });
  });

  it('keeps only the fields of a written record, as a copy that a later change of the record leaves as it was', () => {
    const doc = new Y.Doc();
    const record = { ...feedback('one'), extra: 'dropped' } as Feedback;
    writeFeedback(feedbackOf(doc), record);
    record.shapes.push('box-9');
    record.region.width = 1;

    expect(feedbackOf(doc).toJSON()).toEqual({ one: feedback('one') });
  });

  it('writes a change of a feedback whole under its key, such as a reopen that keeps the answer', () => {
    const doc = new Y.Doc();
    const map = feedbackOf(doc);
    writeFeedback(map, feedback('one'));
    answerFeedback(map, 'one', answer());
    const reopened: Feedback = { ...feedback('one'), status: 'open', answer: answer() };
    writeFeedback(map, reopened);

    expect(map.size).toBe(1);
    expect(getFeedback(map, 'one')).toEqual(reopened);
  });

  it("throws on a record that doesn't read as a feedback, and doesn't write anything", () => {
    const doc = new Y.Doc();
    const map = feedbackOf(doc);
    writeFeedback(map, feedback('one'));

    expect(() => writeFeedback(map, { ...feedback('two'), text: ' ' })).toThrow(TypeError);
    expect(() => writeFeedback(map, { ...feedback('one'), status: 'closed' } as unknown as Feedback)).toThrow(TypeError);
    expect(map.toJSON()).toEqual({ one: feedback('one') });
  });

  it("reads a feedback by its id, and an id the map doesn't hold, a malformed value or a value under another id as null", () => {
    const doc = new Y.Doc();
    const map = feedbackOf(doc);
    writeFeedback(map, feedback('one'));
    map.set('broken', { id: 'broken', text: 'no region' });
    map.set('moved', feedback('elsewhere'));

    expect(getFeedback(map, 'one')).toEqual(feedback('one'));
    expect(getFeedback(map, 'missing')).toBeNull();
    expect(getFeedback(map, 'broken')).toBeNull();
    expect(getFeedback(map, 'moved')).toBeNull();
  });

  it("lists every feedback in the order of `at`, then of `id`, and leaves out a peer's value that doesn't read as one", () => {
    const doc = new Y.Doc();
    const map = feedbackOf(doc);
    writeFeedback(map, feedback('late', '2026-11-07T03:00:00.000Z'));
    writeFeedback(map, feedback('b', '2026-11-07T02:00:00.000Z'));
    map.set('broken', 'not a feedback');
    map.set('moved', feedback('elsewhere', '2026-11-07T00:00:00.000Z'));
    writeFeedback(map, feedback('a', '2026-11-07T02:00:00.000Z'));
    writeFeedback(map, feedback('early', '2026-11-07T01:00:00.000Z'));

    expect(listFeedback(map).map(({ id }) => id)).toEqual(['early', 'a', 'b', 'late']);
  });
});

describe('answerFeedback', () => {
  it('sets an open feedback answered with the answer, and returns the record as it then stands', () => {
    const doc = new Y.Doc();
    const map = feedbackOf(doc);
    writeFeedback(map, feedback('one'));

    const answered: Feedback = { ...feedback('one'), status: 'answered', answer: answer() };
    expect(answerFeedback(map, 'one', { ...answer(), extra: 'dropped' } as FeedbackAnswer)).toEqual(answered);
    expect(map.toJSON()).toEqual({ one: answered });
  });

  it('answers a reopened feedback again, in place of its earlier answer', () => {
    const doc = new Y.Doc();
    const map = feedbackOf(doc);
    writeFeedback(map, { ...feedback('one'), answer: answer('first') });

    expect(answerFeedback(map, 'one', answer('second'))?.answer).toEqual(answer('second'));
    expect(getFeedback(map, 'one')).toEqual({ ...feedback('one'), status: 'answered', answer: answer('second') });
  });

  it("returns the record of a feedback answered already as it stands, and doesn't change it", () => {
    const doc = new Y.Doc();
    const map = feedbackOf(doc);
    const answered: Feedback = { ...feedback('one'), status: 'answered', answer: answer('first') };
    writeFeedback(map, answered);
    const updates: Uint8Array[] = [];
    doc.on('update', (update: Uint8Array) => updates.push(update));

    expect(answerFeedback(map, 'one', answer('second'))).toEqual(answered);
    expect(updates).toEqual([]);
    expect(getFeedback(map, 'one')).toEqual(answered);
  });

  it("returns null for an id the map doesn't hold, a malformed value or a value under another id, and doesn't write anything", () => {
    const doc = new Y.Doc();
    const map = feedbackOf(doc);
    map.set('broken', { id: 'broken', status: 'open' });
    map.set('moved', feedback('elsewhere'));
    const before = map.toJSON();
    const updates: Uint8Array[] = [];
    doc.on('update', (update: Uint8Array) => updates.push(update));

    for (const id of ['missing', 'broken', 'moved']) expect(answerFeedback(map, id, answer()), id).toBeNull();
    expect(updates).toEqual([]);
    expect(map.toJSON()).toEqual(before);
  });

  it("throws on an answer that doesn't read as one, and leaves the feedback open", () => {
    const doc = new Y.Doc();
    const map = feedbackOf(doc);
    writeFeedback(map, feedback('one'));

    for (const bad of [{ ...answer(), text: '' }, { ...answer(), at: 'soon' }, { by: 'claude-code' }]) {
      expect(() => answerFeedback(map, 'one', bad as FeedbackAnswer), JSON.stringify(bad)).toThrow(TypeError);
    }
    expect(getFeedback(map, 'one')).toEqual(feedback('one'));
  });
});

describe('feedback between peers', () => {
  it("reaches every peer, and a peer's answer reaches the writer", () => {
    const network = new MemoryNetwork();
    const [page, helper] = ['page', 'helper'].map((id) => join(network, id));
    network.flush();

    writeFeedback(feedbackOf(page), feedback('one'));
    network.flush();
    expect(listFeedback(feedbackOf(helper))).toEqual([feedback('one')]);

    answerFeedback(feedbackOf(helper), 'one', answer());
    network.flush();
    const answered: Feedback = { ...feedback('one'), status: 'answered', answer: answer() };
    expect(getFeedback(feedbackOf(page), 'one')).toEqual(answered);
    expect(getFeedback(feedbackOf(helper), 'one')).toEqual(answered);
  });

  it('ends two writes of one feedback at the same time in the one Yjs orders last, in every copy', () => {
    const network = new MemoryNetwork();
    const docs = ['a', 'b', 'c'].map((id) => join(network, id));
    network.flush();
    writeFeedback(feedbackOf(docs[0]), { ...feedback('one'), status: 'answered', answer: answer('first') });
    network.flush();

    const reopened: Feedback = { ...feedback('one'), status: 'open', answer: answer('first') };
    const edited: Feedback = {
      ...feedback('one'),
      text: 'and make them blue',
      status: 'answered',
      answer: answer('first'),
    };
    writeFeedback(feedbackOf(docs[1]), reopened);
    writeFeedback(feedbackOf(docs[2]), edited);
    network.flush();

    const first = getFeedback(feedbackOf(docs[0]), 'one');
    expect([reopened, edited]).toContainEqual(first);
    for (const doc of docs) expect(getFeedback(feedbackOf(doc), 'one')).toEqual(first);
  });
});

describe('the kind of a feedback', () => {
  it('reads an ask, with its shapes and their bounds, and keeps its kind through a write and an answer', () => {
    const map = feedbackOf(new Y.Doc());
    const ask: Feedback = { ...feedback('one'), text: 'Tidy this up', kind: 'ask' };
    expect(readFeedback(ask)).toEqual(ask);
    expect(feedbackKind(ask)).toBe('ask');

    writeFeedback(map, ask);
    expect(getFeedback(map, 'one')).toEqual(ask);
    expect(answerFeedback(map, 'one', answer())).toEqual({ ...ask, status: 'answered', answer: answer() });
    expect(getFeedback(map, 'one')?.kind).toBe('ask');
  });

  it('reads a value without a kind, or with an undefined one, without one, as a feedback, and keeps the kind "feedback"', () => {
    expect(readFeedback(feedback('one'))).not.toHaveProperty('kind');
    expect(readFeedback({ ...feedback('one'), kind: undefined })).not.toHaveProperty('kind');
    expect(feedbackKind(feedback('one'))).toBe('feedback');
    expect(readFeedback({ ...feedback('one'), kind: 'feedback' })).toEqual({ ...feedback('one'), kind: 'feedback' });
  });

  it('reads a value whose kind is neither "feedback" nor "ask" as null', () => {
    for (const kind of ['question', 'Ask', '', null, 3, ['ask']]) {
      expect(readFeedback({ ...feedback('one'), kind }), JSON.stringify(kind)).toBeNull();
    }
  });
});
