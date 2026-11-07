import { describe, expect, it } from 'vitest';
import { readBoard } from './board';
import {
  agentWordsOf,
  changerOf,
  creatorOf,
  CUSTOM_DATA,
  drawingChangedOf,
  drawingOf,
  withChange,
  withCreator,
  withDrawingChanged,
  withWordsChanged,
  wordsChangedOf,
  type Creator,
} from './creator';

const AGENT: Creator = { kind: 'agent', name: 'agent' };
const OTHER: Creator = { kind: 'agent', name: 'other' };

describe('withCreator', () => {
  it("records the creator beside the element's other custom data, and leaves the element as it was", () => {
    const element = { id: 'e', type: 'rectangle', customData: { other: 1, [CUSTOM_DATA]: { note: 'kept' } } };
    const before = structuredClone(element);
    expect(withCreator(element, AGENT)).toEqual({
      id: 'e',
      type: 'rectangle',
      customData: { other: 1, chalkline: { note: 'kept', creator: { kind: 'agent', name: 'agent' } } },
    });
    expect(element).toEqual(before);
  });

  it('adds custom data to an element without any', () => {
    expect(withCreator({ id: 'e' }, AGENT)).toEqual({ id: 'e', customData: { chalkline: { creator: AGENT } } });
  });

  it("records the creator as the author of the element's version, where the element holds one", () => {
    expect(withCreator({ id: 'e', version: 3, versionNonce: 7 }, AGENT)).toEqual({
      id: 'e',
      version: 3,
      versionNonce: 7,
      customData: { chalkline: { creator: AGENT, change: { by: AGENT, version: 3, versionNonce: 7 } } },
    });
  });
});

describe('withChange', () => {
  it("records the agent's version beside the element's other custom data, and leaves the element as it was", () => {
    const element = { id: 'e', version: 2, versionNonce: 5, customData: { other: 1, [CUSTOM_DATA]: { creator: OTHER } } };
    const before = structuredClone(element);
    expect(withChange(element, AGENT)).toEqual({
      id: 'e',
      version: 2,
      versionNonce: 5,
      customData: { other: 1, chalkline: { creator: OTHER, change: { by: AGENT, version: 2, versionNonce: 5 } } },
    });
    expect(element).toEqual(before);
  });

  it('records the words of a text, as Excalidraw keeps them unwrapped, beside the version', () => {
    const label = { id: 'l', type: 'text', version: 2, versionNonce: 5, text: 'start\nhere', originalText: 'start here' };
    expect(withChange(label, AGENT)).toEqual({
      ...label,
      customData: { chalkline: { change: { by: AGENT, version: 2, versionNonce: 5, words: 'start here' } } },
    });
    const note = { id: 'n', type: 'text', version: 3, versionNonce: 6, text: 'draw a box' };
    expect(withChange(note, AGENT)).toEqual({
      ...note,
      customData: { chalkline: { change: { by: AGENT, version: 3, versionNonce: 6, words: 'draw a box' } } },
    });
  });

  it("answers the element itself where it doesn't hold a version and a nonce", () => {
    for (const element of [{ id: 'e' }, { id: 'e', version: 1 }, { id: 'e', version: 1, versionNonce: '2' }]) {
      expect(withChange(element, AGENT)).toBe(element);
    }
  });
});

describe('creatorOf', () => {
  it('reads the mark that withCreator writes', () => {
    expect(creatorOf(withCreator({ id: 'e' }, AGENT))).toEqual(AGENT);
  });

  it("is undefined for an element without a mark of the creator's form", () => {
    for (const element of [
      undefined,
      null,
      {},
      { customData: 'chalkline' },
      { customData: { chalkline: [] } },
      { customData: { chalkline: { creator: { kind: 'person', name: 'someone' } } } },
      { customData: { chalkline: { creator: { kind: 'agent', name: 3 } } } },
    ]) {
      expect(creatorOf(element)).toBeUndefined();
    }
  });

  it("is listed by get_board's read of the board", () => {
    const shape = { type: 'rectangle', x: 0, y: 0, width: 10, height: 10, isDeleted: false };
    const shapes = readBoard([
      withCreator({ ...shape, id: 'mine', index: 'a0' }, AGENT),
      { ...shape, id: 'odd', index: 'a1', customData: { chalkline: { creator: { kind: 'agent', name: 3 } } } },
    ]);
    expect(shapes.map((listed) => [listed.id, listed.creator])).toEqual([
      ['mine', AGENT],
      ['odd', undefined],
    ]);
  });
});

describe('changerOf', () => {
  const element = { id: 'e', type: 'text', version: 4, versionNonce: 40 };

  it("is the agent whose change mark records the element's version", () => {
    expect(changerOf(withChange(element, AGENT))).toEqual(AGENT);
    expect(changerOf(withCreator(element, AGENT))).toEqual(AGENT);
    expect(changerOf(withChange(withCreator(element, AGENT), OTHER))).toEqual(OTHER);
  });

  it("is undefined once a person's change sets another version on the element than its mark records", () => {
    const marked = withCreator(element, AGENT);
    expect(changerOf({ ...marked, version: 5, versionNonce: 41 })).toBeUndefined();
    expect(changerOf({ ...marked, versionNonce: 39 })).toBeUndefined();
    expect(creatorOf({ ...marked, version: 5, versionNonce: 41 })).toEqual(AGENT);
  });

  it('is the creator of an element that holds a creator mark and no change mark', () => {
    expect(changerOf(withCreator({ id: 'e' }, AGENT))).toEqual(AGENT);
    expect(changerOf({ ...element, customData: { chalkline: { creator: AGENT } } })).toEqual(AGENT);
  });

  it("is undefined for an element without either mark, and for a change mark of another form", () => {
    const person = { kind: 'person', name: 'someone' };
    for (const value of [
      undefined,
      null,
      element,
      { ...element, customData: { chalkline: { change: { by: person, version: 4, versionNonce: 40 } } } },
      { ...element, customData: { chalkline: { creator: AGENT, change: { by: AGENT, version: '4', versionNonce: 40 } } } },
    ]) {
      expect(changerOf(value)).toBeUndefined();
    }
  });
});

describe('agentWordsOf', () => {
  const answer = { id: 'a', type: 'text', version: 1, versionNonce: 10, text: 'The box is blue', originalText: 'The box is blue' };

  it("reads the words that the agent's change mark records, after a later version of the element too", () => {
    const marked = withCreator(answer, AGENT);
    expect(agentWordsOf(marked)).toBe('The box is blue');
    const corrected = { ...marked, version: 2, versionNonce: 20, text: 'The box is green', originalText: 'The box is green' };
    expect(agentWordsOf(corrected)).toBe('The box is blue');
    expect(changerOf(corrected)).toBeUndefined();
  });

  it("is undefined for an element whose change mark doesn't record an agent's words", () => {
    const person = { kind: 'person', name: 'someone' };
    const rectangle = { id: 'r', type: 'rectangle', version: 1, versionNonce: 10, text: 'The box is blue' };
    for (const value of [
      undefined,
      answer,
      withChange(rectangle, AGENT),
      { ...answer, customData: { chalkline: { creator: AGENT } } },
      { ...answer, customData: { chalkline: { change: { by: AGENT, version: 1, versionNonce: 10 } } } },
      { ...answer, customData: { chalkline: { change: { by: person, version: 1, versionNonce: 10, words: 'The box is blue' } } } },
      { ...answer, customData: { chalkline: { change: { by: AGENT, version: 1, versionNonce: 10, words: 3 } } } },
    ]) {
      expect(agentWordsOf(value)).toBeUndefined();
    }
  });
});

/** A person's text of `written`, as a page last changed it at `updated`. */
const note = (written: string, updated = 1000): Record<string, unknown> => ({
  id: 'note',
  type: 'text',
  version: 1,
  versionNonce: 1,
  text: written,
  originalText: written,
  updated,
});

describe('wordsChangedOf', () => {
  it('is the time the words mark records where it holds the words the text holds', () => {
    expect(wordsChangedOf(withWordsChanged(note('draw a box', 1000), undefined))).toBe(1000);
  });

  it('is undefined without a mark, and for a mark that holds other words or no time', () => {
    const marked = withWordsChanged(note('draw a box', 1000), undefined);
    for (const value of [
      undefined,
      note('draw a box'),
      // A page that doesn't write the mark changed the words, and kept the custom data as it was.
      { ...marked, text: 'draw a circle', originalText: 'draw a circle' },
      { ...note('draw a box'), customData: { [CUSTOM_DATA]: { wordsChanged: { words: 'draw a box', at: '1000' } } } },
      { ...marked, type: 'rectangle' },
    ]) {
      expect(wordsChangedOf(value)).toBeUndefined();
    }
  });
});

describe('withWordsChanged', () => {
  it("records the element's `updated` for a text the board doesn't hold yet, and for new words", () => {
    expect(wordsChangedOf(withWordsChanged(note('draw a box', 1000), undefined))).toBe(1000);

    const current = withWordsChanged(note('draw a box', 1000), undefined);
    expect(wordsChangedOf(withWordsChanged(note('draw a circle', 2000), current))).toBe(2000);
  });

  it("keeps the time the board's copy records where the words are the same, whatever else changed", () => {
    const current = withWordsChanged(note('draw a box', 1000), undefined);
    // A move, and the page wrapping the text: a new version and a new `updated`, with the same words.
    const moved = { ...note('draw a box', 2000), version: 2, x: 40, text: 'draw a\nbox' };

    const written = withWordsChanged(moved, current);

    expect(wordsChangedOf(written)).toBe(1000);
    expect(written).toMatchObject({ version: 2, x: 40, updated: 2000, text: 'draw a\nbox' });
  });

  it("records the `updated` of the board's copy where that copy holds the same words without recording when they changed", () => {
    const moved = { ...note('draw a box', 2000), version: 2 };
    // A page that doesn't write the mark wrote the board's copy at 1000.
    const written = withWordsChanged(moved, note('draw a box', 1000));
    expect(wordsChangedOf(written)).toBe(1000);
    expect(written).toMatchObject({ version: 2, updated: 2000 });

    // The board's copy holds a mark of other words, which a page that doesn't write the mark replaced at 1500.
    const stale = {
      ...withWordsChanged(note('draw it', 500), undefined),
      text: 'draw a box',
      originalText: 'draw a box',
      updated: 1500,
    };
    expect(wordsChangedOf(withWordsChanged(moved, stale))).toBe(1500);
  });

  it("answers the element itself where the board's copy holds the same words without a mark of them or an `updated` time", () => {
    const moved = { ...note('draw a box', 2000), version: 2 };
    const untimed = { id: 'note', type: 'text', text: 'draw a box', originalText: 'draw a box' };
    expect(withWordsChanged(moved, untimed)).toBe(moved);
    expect(withWordsChanged(moved, { ...untimed, updated: 'later' })).toBe(moved);
  });

  it("answers the element itself where it isn't a text or doesn't hold an `updated` time", () => {
    const shape = { id: 'box', type: 'rectangle', text: 'draw a box', updated: 1000 };
    expect(withWordsChanged(shape, undefined)).toBe(shape);
    const untimed = { id: 'note', type: 'text', text: 'draw a box' };
    expect(withWordsChanged(untimed, undefined)).toBe(untimed);
  });

  it("keeps the other members of the element's custom data, and leaves the element as it was", () => {
    const element = { ...note('draw a box', 1000), customData: { other: 1, [CUSTOM_DATA]: { note: 'kept' } } };
    const before = structuredClone(element);

    const written = withWordsChanged(element, undefined);

    expect(written.customData).toEqual({
      other: 1,
      [CUSTOM_DATA]: { note: 'kept', wordsChanged: { words: 'draw a box', at: 1000 } },
    });
    expect(element).toEqual(before);
  });
});

/** A person's freehand stroke at `x` and `y` through `points`, as a page last changed it at `updated`. */
const scrawl = (x: number, y: number, points: number[][], updated = 1000): Record<string, unknown> => ({
  id: 'scrawl',
  type: 'freedraw',
  version: 1,
  versionNonce: 1,
  x,
  y,
  points,
  updated,
});

describe('drawingOf', () => {
  it('is the same for two copies of a stroke with the same place and points, and differs where either differs', () => {
    const drawing = drawingOf(scrawl(10, 20, [[0, 0], [30, 40]]));
    expect(drawing).toMatch(/^[0-9a-f]{8}$/);
    // A save of the stroke: a new version, index and `updated`, with the same place and points.
    expect(drawingOf({ ...scrawl(10, 20, [[0, 0], [30, 40]], 2000), version: 2, index: 'a5' })).toBe(drawing);
    expect(drawingOf(scrawl(15, 20, [[0, 0], [30, 40]]))).not.toBe(drawing);
    expect(drawingOf(scrawl(10, 25, [[0, 0], [30, 40]]))).not.toBe(drawing);
    expect(drawingOf(scrawl(10, 20, [[0, 0], [30, 41]]))).not.toBe(drawing);
  });

  it("is undefined for an element that isn't a freehand stroke", () => {
    for (const value of [undefined, 'freedraw', note('draw a box'), { ...scrawl(0, 0, [[0, 0]]), type: 'line' }]) {
      expect(drawingOf(value)).toBeUndefined();
    }
  });
});

describe('drawingChangedOf', () => {
  it("is the time the drawing mark records where it holds the stroke's place and points", () => {
    expect(drawingChangedOf(withDrawingChanged(scrawl(10, 20, [[0, 0], [30, 40]], 1000), undefined))).toBe(1000);
  });

  it('is undefined without a mark, and for a mark of another place or other points, or without a time', () => {
    const marked = withDrawingChanged(scrawl(10, 20, [[0, 0], [30, 40]], 1000), undefined);
    const untimed = { drawingChanged: { drawing: drawingOf(marked), at: '1000' } };
    for (const value of [
      undefined,
      scrawl(10, 20, [[0, 0], [30, 40]]),
      // A page that doesn't write the mark moved the stroke, or changed its points, and kept the
      // custom data as it was.
      { ...marked, x: 50 },
      { ...marked, points: [[0, 0], [30, 41]] },
      { ...scrawl(10, 20, [[0, 0], [30, 40]]), customData: { [CUSTOM_DATA]: untimed } },
      { ...marked, type: 'line' },
    ]) {
      expect(drawingChangedOf(value)).toBeUndefined();
    }
  });
});

describe('withDrawingChanged', () => {
  it("records the element's `updated` for a stroke the board doesn't hold yet, and for a new place or new points", () => {
    expect(drawingChangedOf(withDrawingChanged(scrawl(10, 20, [[0, 0], [30, 40]], 1000), undefined))).toBe(1000);

    const current = withDrawingChanged(scrawl(10, 20, [[0, 0], [30, 40]], 1000), undefined);
    expect(drawingChangedOf(withDrawingChanged(scrawl(50, 20, [[0, 0], [30, 40]], 2000), current))).toBe(2000);
    expect(drawingChangedOf(withDrawingChanged(scrawl(10, 20, [[0, 0], [30, 40], [5, 5]], 3000), current))).toBe(3000);
  });

  it("keeps the time the board's copy records where the place and points are the same, whatever else changed", () => {
    const current = withDrawingChanged(scrawl(10, 20, [[0, 0], [30, 40]], 1000), undefined);
    // A save of the stroke and a change of its color: a new version, index and `updated`, with the
    // same place and points.
    const saved = { ...scrawl(10, 20, [[0, 0], [30, 40]], 2000), version: 2, index: 'a5', strokeColor: '#e03131' };

    const written = withDrawingChanged(saved, current);

    expect(drawingChangedOf(written)).toBe(1000);
    expect(written).toMatchObject({ version: 2, index: 'a5', updated: 2000, strokeColor: '#e03131' });
  });

  it("answers the element itself where the board's copy doesn't record when the same place and points changed", () => {
    const saved = { ...scrawl(10, 20, [[0, 0], [30, 40]], 2000), version: 2 };
    expect(withDrawingChanged(saved, scrawl(10, 20, [[0, 0], [30, 40]], 1000))).toBe(saved);

    // The board's copy holds a mark of another place, which a page that doesn't write the mark moved
    // the stroke from.
    const stale = { ...withDrawingChanged(scrawl(50, 20, [[0, 0], [30, 40]], 500), undefined), x: 10 };
    expect(withDrawingChanged(saved, stale)).toBe(saved);
  });

  it("answers the element itself where it isn't a freehand stroke or doesn't hold an `updated` time", () => {
    const shape = { id: 'box', type: 'rectangle', x: 0, y: 0, updated: 1000 };
    expect(withDrawingChanged(shape, undefined)).toBe(shape);
    const untimed = { id: 'scrawl', type: 'freedraw', x: 0, y: 0, points: [[0, 0]] };
    expect(withDrawingChanged(untimed, undefined)).toBe(untimed);
  });

  it("keeps the other members of the element's custom data, and leaves the element as it was", () => {
    const element = { ...scrawl(10, 20, [[0, 0], [30, 40]], 1000), customData: { other: 1, [CUSTOM_DATA]: { note: 'kept' } } };
    const before = structuredClone(element);

    const written = withDrawingChanged(element, undefined);

    expect(written.customData).toEqual({
      other: 1,
      [CUSTOM_DATA]: { note: 'kept', drawingChanged: { drawing: drawingOf(element), at: 1000 } },
    });
    expect(element).toEqual(before);
  });
});
