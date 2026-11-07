import { describe, expect, it } from 'vitest';
import { readBoard } from './board';
import { creatorOf, CUSTOM_DATA, withCreator, type Creator } from './creator';

const AGENT: Creator = { kind: 'agent', name: 'agent' };

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
