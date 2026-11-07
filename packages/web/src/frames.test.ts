// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { bindFramesList, framesOf, LIST_PROMPT, UNNAMED_FRAME, type FramesBoard, type ListedFrame } from './frames';

function frame(id: string, fields: Record<string, unknown> = {}) {
  return { id, type: 'frame', x: 0, y: 0, width: 100, height: 50, isDeleted: false, name: id, ...fields };
}

/** A board whose frames the test sets, which calls each change handler on each set, and the frames it showed. */
function testBoard(initial: ListedFrame[] = []) {
  let frames = initial;
  const handlers: (() => void)[] = [];
  const shown: ListedFrame[] = [];
  const board: FramesBoard = {
    frames: () => frames,
    show: (chosen) => shown.push(chosen),
    onChange: (handler) => handlers.push(handler),
  };
  return {
    board,
    shown,
    set(next: ListedFrame[]) {
      frames = next;
      for (const handler of handlers) handler();
    },
  };
}

function options(select: HTMLSelectElement): [string, string | null][] {
  return [...select.options].map((option) => [option.value, option.textContent]);
}

const ONE: ListedFrame = { id: 'one', name: 'One', x: 0, y: 0, width: 200, height: 100 };
const TWO: ListedFrame = { id: 'two', name: 'Two', x: 1000, y: 500, width: 300, height: 200 };

describe('framesOf', () => {
  it("lists the board's frames in the board's order, each with its name and its bounds", () => {
    const listed = framesOf([
      frame('first', { name: 'One', x: 10, y: 20, width: 300, height: 200 }),
      { id: 'box', type: 'rectangle', x: 0, y: 0, width: 10, height: 10, isDeleted: false },
      frame('unnamed', { name: null }),
      frame('empty', { name: '' }),
      frame('deleted', { isDeleted: true }),
      frame('last', { name: 'Last', x: -5 }),
    ]);
    expect(listed).toEqual([
      { id: 'first', name: 'One', x: 10, y: 20, width: 300, height: 200 },
      { id: 'unnamed', name: UNNAMED_FRAME, x: 0, y: 0, width: 100, height: 50 },
      { id: 'empty', name: UNNAMED_FRAME, x: 0, y: 0, width: 100, height: 50 },
      { id: 'last', name: 'Last', x: -5, y: 0, width: 100, height: 50 },
    ]);
  });
});

describe('bindFramesList', () => {
  it("hides while the board doesn't hold a frame, and lists each frame by its name, after the prompt, once it does", () => {
    const select = document.createElement('select');
    const test = testBoard();
    bindFramesList(select, test.board);
    expect(select.hidden).toBe(true);
    expect(options(select)).toEqual([['', LIST_PROMPT]]);

    test.set([ONE, TWO]);
    expect(select.hidden).toBe(false);
    expect(options(select)).toEqual([
      ['', LIST_PROMPT],
      ['one', 'One'],
      ['two', 'Two'],
    ]);
    expect(select.value).toBe('');

    test.set([TWO, { ...ONE, name: 'Renamed' }]);
    expect(options(select)).toEqual([
      ['', LIST_PROMPT],
      ['two', 'Two'],
      ['one', 'Renamed'],
    ]);

    test.set([]);
    expect(select.hidden).toBe(true);
    expect(options(select)).toEqual([['', LIST_PROMPT]]);
  });

  it('keeps its options where a change of the board moves a frame and keeps its name and its place', () => {
    const select = document.createElement('select');
    const test = testBoard([ONE, TWO]);
    bindFramesList(select, test.board);
    const kept = select.options[2];
    test.set([ONE, { ...TWO, x: 2000 }]);
    expect(select.options[2]).toBe(kept);
  });

  it('shows the frame a person chooses, where it lies at that moment, and goes back to the prompt', () => {
    const select = document.createElement('select');
    const test = testBoard([ONE, TWO]);
    bindFramesList(select, test.board);
    const moved = { ...TWO, x: 2000, y: 1500 };
    test.set([ONE, moved]);
    select.value = 'two';
    select.dispatchEvent(new Event('change'));
    expect(test.shown).toEqual([moved]);
    expect(select.value).toBe('');

    // Choosing the prompt shows nothing.
    select.value = '';
    select.dispatchEvent(new Event('change'));
    expect(test.shown).toEqual([moved]);
  });
});
