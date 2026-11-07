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

  it("reads a line's or an arrow's size from its points, as the last point's offset from the first", () => {
    const shapes = readBoard([
      element({ id: 'stem', type: 'line', index: 'a0', width: 0, height: 50, points: [[0, 0], [100, -50]] }),
      element({ id: 'bound', type: 'arrow', index: 'a1', width: 0, height: 50, points: [[0, 0.5], [12, 30], [0, 49.5]] }),
      element({ id: 'dot', type: 'line', index: 'a2', points: [[0, 0]] }),
      element({ id: 'odd', type: 'arrow', index: 'a3', points: [[0, 0], ['far', 10]] }),
      element({ id: 'box', type: 'rectangle', index: 'a4', points: [[0, 0], [5, 5]] }),
    ]);
    expect(shapes.map(({ id, width, height }) => ({ id, width, height }))).toEqual([
      { id: 'stem', width: 100, height: -50 },
      { id: 'bound', width: 0, height: 49 },
      { id: 'dot', width: 100, height: 50 },
      { id: 'odd', width: 100, height: 50 },
      { id: 'box', width: 100, height: 50 },
    ]);
  });

  it("lists the points of a line, an arrow or a freehand stroke, and leaves them out where one isn't a point", () => {
    const shapes = readBoard([
      element({ id: 'zigzag', type: 'line', index: 'a0', points: [[0, 0], [40, 30], [80, -10]] }),
      element({ id: 'stroke', type: 'freedraw', index: 'a1', points: [[0, 0], [3, 4], [6, 2]] }),
      element({ id: 'odd', type: 'arrow', index: 'a2', points: [[0, 0], ['far', 10]] }),
      element({ id: 'box', type: 'rectangle', index: 'a3', points: [[0, 0], [5, 5]] }),
    ]);
    expect(shapes.map(({ id, width, height, points }) => ({ id, width, height, points }))).toEqual([
      { id: 'zigzag', width: 80, height: -10, points: [[0, 0], [40, 30], [80, -10]] },
      { id: 'stroke', width: 100, height: 50, points: [[0, 0], [3, 4], [6, 2]] },
      { id: 'odd', width: 100, height: 50 },
      { id: 'box', width: 100, height: 50 },
    ]);
  });

  it('lists 100 of the points of a stroke that holds more, evenly spaced from its first to its last, with the count of all', () => {
    const many = Array.from({ length: 199 }, (_, place) => [place, place % 3]);
    const hundred = Array.from({ length: 100 }, (_, place) => [place, 0]);
    const [stroke, line] = readBoard([
      element({ id: 'stroke', type: 'freedraw', index: 'a0', points: many }),
      element({ id: 'line', type: 'line', index: 'a1', points: hundred }),
    ]);
    expect(stroke.pointCount).toBe(199);
    expect(stroke.points).toEqual(Array.from({ length: 100 }, (_, place) => many[place * 2]));
    expect(line.points).toEqual(hundred);
    expect(line.pointCount).toBeUndefined();
  });

  it("answers each shape's colors, and each style, font and alignment that isn't Excalidraw's default", () => {
    const plain = { strokeColor: '#1e1e1e', backgroundColor: 'transparent', strokeWidth: 2, strokeStyle: 'solid', fillStyle: 'solid', roughness: 1, opacity: 100 };
    const shapes = readBoard([
      element({ id: 'plain', type: 'rectangle', index: 'a0', ...plain }),
      element({ id: 'plain-label', type: 'text', index: 'a1', containerId: 'plain', text: 'Plain', originalText: 'Plain', fontFamily: 5, textAlign: 'center' }),
      element({
        id: 'wash',
        type: 'ellipse',
        index: 'a2',
        strokeColor: '#1971c2',
        backgroundColor: '#a5d8ff',
        strokeWidth: 1,
        strokeStyle: 'dashed',
        fillStyle: 'hachure',
        roughness: 0,
        opacity: 40,
      }),
      element({ id: 'wash-label', type: 'text', index: 'a3', containerId: 'wash', text: 'Wash', originalText: 'Wash', fontFamily: 8, textAlign: 'left' }),
      element({ id: 'note', type: 'text', index: 'a4', ...plain, text: 'Note', originalText: 'Note', fontFamily: 5, textAlign: 'left' }),
      element({ id: 'code', type: 'text', index: 'a5', ...plain, text: 'Code', originalText: 'Code', fontFamily: 8, textAlign: 'right' }),
    ]);
    const colors = { strokeColor: '#1e1e1e', backgroundColor: 'transparent' };
    expect(shapes).toEqual([
      { id: 'plain', kind: 'rectangle', x: 0, y: 0, width: 100, height: 50, label: 'Plain', ...colors },
      {
        id: 'wash',
        kind: 'ellipse',
        x: 0,
        y: 0,
        width: 100,
        height: 50,
        label: 'Wash',
        strokeColor: '#1971c2',
        backgroundColor: '#a5d8ff',
        strokeWidth: 1,
        strokeStyle: 'dashed',
        fillStyle: 'hachure',
        roughness: 0,
        opacity: 40,
        fontFamily: 'Comic Shanns',
        textAlign: 'left',
      },
      { id: 'note', kind: 'text', x: 0, y: 0, width: 100, height: 50, label: 'Note', ...colors },
      { id: 'code', kind: 'text', x: 0, y: 0, width: 100, height: 50, label: 'Code', ...colors, fontFamily: 'Comic Shanns', textAlign: 'right' },
    ]);
  });
});
