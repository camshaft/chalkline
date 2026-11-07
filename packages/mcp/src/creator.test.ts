import { describe, expect, it } from 'vitest';
import { readBoard } from './board';
import { changerOf, creatorOf, CUSTOM_DATA, withChange, withCreator, type Creator } from './creator';

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
