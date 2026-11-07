import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { MemoryNetwork } from './memory-transport';
import {
  getSnapshotMark,
  isShape,
  listSnapshotMarks,
  readSnapshotMark,
  shapeCount,
  SNAPSHOTS,
  snapshotsOf,
  writeSnapshotMark,
  type SnapshotMark,
} from './snapshots';
import { connectDoc } from './sync';

/** A mark that claude-code's helper wrote over a board of 12 shapes, which `fields` change. */
const mark = (id: string, fields: Partial<SnapshotMark> = {}): SnapshotMark => ({
  id,
  by: 'claude-code',
  at: '2026-11-07T18:00:00.000Z',
  label: 'before the redesign',
  shapes: 12,
  ...fields,
});

describe('readSnapshotMark', () => {
  it('reads a mark as a copy, without the fields it lacks a use for', () => {
    const value = { ...mark('one'), extra: true };
    const read = readSnapshotMark(value);

    expect(read).toEqual(mark('one'));
    expect(read).not.toBe(value);
    expect(readSnapshotMark(mark('two', { label: null, shapes: 0 }))).toEqual(mark('two', { label: null, shapes: 0 }));
  });

  it("reads a value as absent where it lacks a field, holds one of the wrong type or holds a time that doesn't parse", () => {
    const unlabelled = { id: 'one', by: 'claude-code', at: '2026-11-07T18:00:00.000Z', shapes: 12 };
    const values: unknown[] = [
      null,
      'one',
      [mark('one')],
      unlabelled,
      { ...mark('one'), id: '' },
      { ...mark('one'), id: 7 },
      { ...mark('one'), by: '  ' },
      { ...mark('one'), at: 'yesterday' },
      { ...mark('one'), at: 1 },
      { ...mark('one'), label: 3 },
      { ...mark('one'), shapes: -1 },
      { ...mark('one'), shapes: 1.5 },
      { ...mark('one'), shapes: '12' },
    ];

    for (const value of values) expect(readSnapshotMark(value), JSON.stringify(value)).toBeNull();
  });
});

describe('the snapshot marks map', () => {
  it("reads a mark under its own id alone, and lists the marks oldest first, then by id", () => {
    const doc = new Y.Doc();
    const marks = snapshotsOf(doc);
    writeSnapshotMark(marks, mark('late', { at: '2026-11-07T18:05:00.000Z' }));
    writeSnapshotMark(marks, mark('b'));
    writeSnapshotMark(marks, mark('a'));
    marks.set('broken', { id: 'broken', by: 'claude-code' });
    marks.set('elsewhere', mark('other'));

    expect(doc.getMap(SNAPSHOTS)).toBe(marks);
    expect(getSnapshotMark(marks, 'a')).toEqual(mark('a'));
    expect(getSnapshotMark(marks, 'broken')).toBeNull();
    expect(getSnapshotMark(marks, 'elsewhere')).toBeNull();
    expect(getSnapshotMark(marks, 'missing')).toBeNull();
    expect(listSnapshotMarks(marks).map((each) => each.id)).toEqual(['a', 'b', 'late']);
  });

  it("refuses to write a value that doesn't read as a mark, and writes nothing", () => {
    const marks = snapshotsOf(new Y.Doc());

    expect(() => writeSnapshotMark(marks, mark('one', { at: 'soon' }))).toThrow(TypeError);
    expect(marks.size).toBe(0);
  });

  it("sends each mark to every peer, which reads it as the writer's copy", () => {
    const network = new MemoryNetwork();
    const helper = new Y.Doc();
    const page = new Y.Doc();
    connectDoc(helper, network.join('helper'));
    connectDoc(page, network.join('page'));
    network.flush();

    writeSnapshotMark(snapshotsOf(helper), { ...mark('one'), extra: 'left out' } as SnapshotMark);
    network.flush();

    expect(listSnapshotMarks(snapshotsOf(page))).toEqual([mark('one')]);
    expect(snapshotsOf(page).get('one')).toEqual(mark('one'));
  });
});

describe('isShape and shapeCount', () => {
  it("count each element that isn't deleted and isn't a container's bound text", () => {
    const elements: unknown[] = [
      { id: 'box', type: 'rectangle' },
      { id: 'box-label', type: 'text', containerId: 'box' },
      { id: 'note', type: 'text', containerId: null },
      { id: 'gone', type: 'ellipse', isDeleted: true },
      { id: 'arrow', type: 'arrow', isDeleted: false },
      null,
      'box',
    ];

    expect(elements.map(isShape)).toEqual([true, false, true, false, true, false, false]);
    expect(shapeCount(elements)).toBe(3);
    expect(shapeCount([])).toBe(0);
  });
});
