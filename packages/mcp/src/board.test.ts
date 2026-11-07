import { describe, expect, it } from 'vitest';
import { readBoard } from './board';

function element(fields: Record<string, unknown>): Record<string, unknown> {
  return { x: 0, y: 0, width: 100, height: 50, isDeleted: false, ...fields };
}

describe('readBoard', () => {
  it('lists the shapes back to front, by fractional index and then by id', () => {
    const shapes = readBoard([
      element({ id: 'c', type: 'rectangle', index: 'a2' }),
      element({ id: 'b', type: 'ellipse', index: null }),
      element({ id: 'a', type: 'diamond', index: 'a1' }),
      element({ id: 'd', type: 'rectangle', index: 'a1' }),
    ]);
    expect(shapes.map((shape) => shape.id)).toEqual(['a', 'd', 'c', 'b']);
  });

  it("makes each bound text its container's label, and lists a text of its own as a shape", () => {
    const shapes = readBoard([
      element({ id: 'box', type: 'rectangle', index: 'a0', x: 10, y: 20, width: 200, height: 80 }),
      element({ id: 'label', type: 'text', index: 'a1', containerId: 'box', text: 'Wrapped\nlabel', originalText: 'Wrapped label' }),
      element({ id: 'note', type: 'text', index: 'a2', containerId: null, text: 'A note', originalText: 'A note' }),
    ]);
    expect(shapes).toEqual([
      { id: 'box', kind: 'rectangle', x: 10, y: 20, width: 200, height: 80, label: 'Wrapped label' },
      { id: 'note', kind: 'text', x: 0, y: 0, width: 100, height: 50, label: 'A note' },
    ]);
  });

  it("answers the shapes an arrow is bound to, and leaves out a binding to a shape that isn't listed", () => {
    const shapes = readBoard([
      element({ id: 'from', type: 'rectangle', index: 'a0' }),
      element({ id: 'to', type: 'ellipse', index: 'a1', isDeleted: true }),
      element({
        id: 'arrow',
        type: 'arrow',
        index: 'a2',
        startBinding: { elementId: 'from', focus: 0, gap: 1 },
        endBinding: { elementId: 'to', focus: 0, gap: 1 },
      }),
      element({ id: 'arrow-label', type: 'text', index: 'a3', containerId: 'arrow', text: 'yes', originalText: 'yes' }),
    ]);
    expect(shapes).toEqual([
      { id: 'from', kind: 'rectangle', x: 0, y: 0, width: 100, height: 50 },
      { id: 'arrow', kind: 'arrow', x: 0, y: 0, width: 100, height: 50, label: 'yes', start: 'from' },
    ]);
  });

  it('lists a bound text as a shape of its own where its container is deleted', () => {
    const shapes = readBoard([
      element({ id: 'box', type: 'rectangle', index: 'a0', isDeleted: true }),
      element({ id: 'label', type: 'text', index: 'a1', containerId: 'box', text: 'Left behind', originalText: 'Left behind' }),
    ]);
    expect(shapes).toEqual([{ id: 'label', kind: 'text', x: 0, y: 0, width: 100, height: 50, label: 'Left behind' }]);
  });

  it("leaves out values that aren't elements", () => {
    const shapes = readBoard([
      null,
      'rectangle',
      7,
      { id: 'no-type', x: 0, y: 0, width: 1, height: 1 },
      element({ id: 7, type: 'rectangle' }),
      element({ id: 'not-a-number', type: 'rectangle', x: Number.NaN }),
      element({ id: 'kept', type: 'rectangle', index: 'a0' }),
    ]);
    expect(shapes.map((shape) => shape.id)).toEqual(['kept']);
  });
});
