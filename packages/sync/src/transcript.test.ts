import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { MemoryNetwork } from './memory-transport';
import { connectDoc } from './sync';
import {
  appendEntry,
  newEntryId,
  readEntry,
  readTranscript,
  transcriptOf,
  type TranscriptEntry,
  type TranscriptVia,
} from './transcript';

const entry = (id: string, speaker = 'Ada', text = `said ${id}`, via: TranscriptVia = 'speech'): TranscriptEntry => ({
  id,
  speaker,
  at: '2026-11-07T01:02:03.000Z',
  text,
  via,
});

function join(network: MemoryNetwork, id: string): Y.Doc {
  const doc = new Y.Doc();
  connectDoc(doc, network.join(id));
  return doc;
}

describe('readEntry', () => {
  it('reads the five fields, and leaves out the others', () => {
    expect(readEntry({ ...entry('one'), extra: 'dropped' })).toEqual(entry('one'));
  });

  it('reads an entry without `via`, as each entry written before the chat, as speech', () => {
    const { id, speaker, at, text } = entry('one');
    expect(readEntry({ id, speaker, at, text })).toEqual(entry('one'));
    expect(readEntry({ id, speaker, at, text, via: undefined })).toEqual(entry('one'));
  });

  it("reads a typed entry and an agent's entry with their `via`", () => {
    expect(readEntry(entry('one', 'Ada', 'hello', 'typed'))?.via).toBe('typed');
    expect(readEntry(entry('two', 'claude-code', 'a box', 'agent'))?.via).toBe('agent');
  });

  it('reads a value that lacks a field, holds one of the wrong type or a blank one, as null', () => {
    const { id, speaker, at, text } = entry('one');
    for (const value of [
      { speaker, at, text },
      { id, at, text },
      { id, speaker, text },
      { id, speaker, at },
      { id: 7, speaker, at, text },
      { id, speaker: ['Ada'], at, text },
      { id, speaker, at: 1762477323000, text },
      { id, speaker, at, text: '   ' },
      { id: '', speaker, at, text },
    ]) {
      expect(readEntry(value), JSON.stringify(value)).toBeNull();
    }
  });

  it('reads an entry whose `via` is another word or of the wrong type as null', () => {
    const { id, speaker, at, text } = entry('one');
    for (const via of ['shouted', 'Typed', '', 7, null, ['typed']]) {
      expect(readEntry({ id, speaker, at, text, via }), JSON.stringify(via)).toBeNull();
    }
  });

  it("reads an entry whose time doesn't parse as null", () => {
    expect(readEntry({ ...entry('one'), at: 'yesterday' })).toBeNull();
  });

  it("reads a value that isn't an object as null", () => {
    for (const value of [null, undefined, 'Ada', 3, [entry('one')]]) expect(readEntry(value)).toBeNull();
  });
});

describe('newEntryId', () => {
  it('makes 16 hex digits, a new id each time', () => {
    const ids = new Set(Array.from({ length: 50 }, () => newEntryId()));
    expect(ids.size).toBe(50);
    for (const id of ids) expect(id).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe('the transcript', () => {
  it("is the document's `transcript` array", () => {
    const doc = new Y.Doc();
    appendEntry(transcriptOf(doc), entry('one'));

    expect(doc.getArray('transcript').toJSON()).toEqual([entry('one')]);
  });

  it('keeps only the five fields of an appended entry', () => {
    const doc = new Y.Doc();
    appendEntry(transcriptOf(doc), { ...entry('one'), extra: 'dropped' } as TranscriptEntry);

    expect(transcriptOf(doc).toJSON()).toEqual([entry('one')]);
  });

  it("reads every entry in order, and leaves out a peer's value that doesn't read as one", () => {
    const doc = new Y.Doc();
    const transcript = transcriptOf(doc);
    appendEntry(transcript, entry('one'));
    transcript.push([{ id: 'broken' }, 'not an entry']);
    appendEntry(transcript, entry('two'));

    expect(readTranscript(transcript)).toEqual([entry('one'), entry('two')]);
  });

  it("carries a typed entry and an agent's entry to every peer with their `via`, beside an entry written before the chat", () => {
    const network = new MemoryNetwork();
    const [page, helper] = ['page', 'helper'].map((id) => join(network, id));
    network.flush();

    const { id, speaker, at, text } = entry('spoken', 'Grace');
    transcriptOf(page).push([{ id, speaker, at, text }]);
    network.flush();
    appendEntry(transcriptOf(page), entry('typed', 'Ada', 'draw a box', 'typed'));
    network.flush();
    appendEntry(transcriptOf(helper), entry('posted', 'claude-code', 'I drew a box', 'agent'));
    network.flush();

    const wanted = [
      entry('spoken', 'Grace'),
      entry('typed', 'Ada', 'draw a box', 'typed'),
      entry('posted', 'claude-code', 'I drew a box', 'agent'),
    ];
    expect(readTranscript(transcriptOf(page))).toEqual(wanted);
    expect(readTranscript(transcriptOf(helper))).toEqual(wanted);
  });

  it("reaches every peer, and the peers' appends at the same time end in one order in every copy", () => {
    const network = new MemoryNetwork();
    const docs = ['a', 'b', 'c'].map((id) => join(network, id));
    network.flush();

    appendEntry(transcriptOf(docs[0]), entry('a1', 'Ada'));
    network.flush();
    appendEntry(transcriptOf(docs[1]), entry('b1', 'Grace'));
    appendEntry(transcriptOf(docs[2]), entry('c1', 'Alan'));
    network.flush();

    const first = readTranscript(transcriptOf(docs[0]));
    expect(first.map(({ id }) => id).sort()).toEqual(['a1', 'b1', 'c1']);
    expect(first[0].id).toBe('a1');
    for (const doc of docs) expect(readTranscript(transcriptOf(doc))).toEqual(first);
  });
});
