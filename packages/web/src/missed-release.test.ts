// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { bindMissedReleases } from './missed-release';

const stops: (() => void)[] = [];

afterEach(() => {
  for (const stop of stops.splice(0)) stop();
  document.body.innerHTML = '';
});

function found(selector: string): Element {
  const element = document.querySelector(selector);
  if (element === null) throw new Error(`the page doesn't hold ${selector}`);
  return element;
}

/** A pointer event of `type` from the pointer `pointerId`, as a browser sends it. */
const pointer = (type: string, pointerType: string, pointerId: number) =>
  new PointerEvent(type, { pointerId, pointerType, bubbles: true, cancelable: true, composed: true });

const TYPES = ['pointerdown', 'pointerup', 'pointercancel'];

/**
 * A page that holds the board's element, with a canvas in it, and an element outside it, with missed releases bound
 * on the board's element. `seen` lists each pointer event that reaches the document, as its type, its pointer's type
 * and id, and `board` where it came from the canvas or `outside` where it came from the element outside the board.
 */
function page() {
  document.body.innerHTML = '<div id="app"><canvas></canvas></div><p id="outside"></p>';
  const canvas = found('#app canvas');
  const outside = found('#outside');
  const seen: string[] = [];
  const record = (event: Event) => {
    const { pointerType, pointerId } = event as PointerEvent;
    seen.push(`${event.type} ${pointerType} ${pointerId} ${event.target === canvas ? 'board' : 'outside'}`);
  };
  for (const type of TYPES) document.addEventListener(type, record);
  stops.push(() => {
    for (const type of TYPES) document.removeEventListener(type, record);
  });
  const stop = bindMissedReleases(found('#app'));
  stops.push(stop);
  return { canvas, outside, seen, stop };
}

describe('bindMissedReleases', () => {
  it("ends a pen's press whose release didn't come before the pen's next press reaches the board", () => {
    const { canvas, seen } = page();
    canvas.dispatchEvent(pointer('pointerdown', 'pen', 2));
    canvas.dispatchEvent(pointer('pointerdown', 'pen', 3));
    expect(seen).toEqual(['pointerdown pen 2 board', 'pointercancel pen 2 board', 'pointerdown pen 3 board']);
  });

  it('sends the cancel to the element the press reached, as a browser sends it', () => {
    const { canvas } = page();
    const cancels: PointerEvent[] = [];
    canvas.addEventListener('pointercancel', (event) => cancels.push(event as PointerEvent));
    canvas.dispatchEvent(pointer('pointerdown', 'pen', 2));
    canvas.dispatchEvent(pointer('pointerdown', 'mouse', 1));
    expect(cancels.map((cancel) => [cancel.pointerId, cancel.pointerType, cancel.bubbles, cancel.cancelable, cancel.composed])).toEqual([
      [2, 'pen', true, false, true],
    ]);
  });

  it("ends a mouse's press before a pen's, and a pen's before a mouse's", () => {
    const { canvas, seen } = page();
    canvas.dispatchEvent(pointer('pointerdown', 'mouse', 1));
    canvas.dispatchEvent(pointer('pointerdown', 'pen', 2));
    canvas.dispatchEvent(pointer('pointerdown', 'mouse', 1));
    expect(seen).toEqual([
      'pointerdown mouse 1 board',
      'pointercancel mouse 1 board',
      'pointerdown pen 2 board',
      'pointercancel pen 2 board',
      'pointerdown mouse 1 board',
    ]);
  });

  it('leaves a press whose release or cancel came, wherever it came', () => {
    const { canvas, outside, seen } = page();
    const events: [Element, string, string, number][] = [
      [canvas, 'pointerdown', 'pen', 2],
      [outside, 'pointerup', 'pen', 2],
      [canvas, 'pointerdown', 'pen', 3],
      [canvas, 'pointercancel', 'pen', 3],
      [canvas, 'pointerdown', 'mouse', 1],
      [canvas, 'pointerup', 'mouse', 1],
      [canvas, 'pointerdown', 'pen', 4],
    ];
    for (const [target, type, pointerType, pointerId] of events) target.dispatchEvent(pointer(type, pointerType, pointerId));
    expect(seen).toEqual([
      'pointerdown pen 2 board',
      'pointerup pen 2 outside',
      'pointerdown pen 3 board',
      'pointercancel pen 3 board',
      'pointerdown mouse 1 board',
      'pointerup mouse 1 board',
      'pointerdown pen 4 board',
    ]);
  });

  it('leaves the second press of the same pointer alone', () => {
    const { canvas, seen } = page();
    canvas.dispatchEvent(pointer('pointerdown', 'pen', 2));
    canvas.dispatchEvent(pointer('pointerdown', 'pen', 2));
    expect(seen).toEqual(['pointerdown pen 2 board', 'pointerdown pen 2 board']);
  });

  it("leaves fingers, which press several at once, and doesn't end a pen's press for a touch", () => {
    const { canvas, seen } = page();
    for (const [pointerType, pointerId] of [['touch', 5], ['touch', 6], ['pen', 2], ['touch', 7], ['pen', 3]] as const) {
      canvas.dispatchEvent(pointer('pointerdown', pointerType, pointerId));
    }
    expect(seen).toEqual([
      'pointerdown touch 5 board',
      'pointerdown touch 6 board',
      'pointerdown pen 2 board',
      'pointerdown touch 7 board',
      'pointercancel pen 2 board',
      'pointerdown pen 3 board',
    ]);
  });

  it('counts only a press that reached the board', () => {
    const { canvas, outside, seen } = page();
    outside.dispatchEvent(pointer('pointerdown', 'pen', 2));
    canvas.dispatchEvent(pointer('pointerdown', 'pen', 3));
    expect(seen).toEqual(['pointerdown pen 2 outside', 'pointerdown pen 3 board']);
  });

  it("doesn't count a press that the page stopped before it reached the board, as the side button's", () => {
    const { canvas, seen } = page();
    const stopper = (event: Event) => {
      if ((event as PointerEvent).pointerId === 9) event.stopImmediatePropagation();
    };
    window.addEventListener('pointerdown', stopper, true);
    stops.push(() => window.removeEventListener('pointerdown', stopper, true));
    canvas.dispatchEvent(pointer('pointerdown', 'pen', 9));
    canvas.dispatchEvent(pointer('pointerdown', 'pen', 3));
    expect(seen).toEqual(['pointerdown pen 3 board']);
  });

  it('stops ending presses once stopped', () => {
    const { canvas, seen, stop } = page();
    canvas.dispatchEvent(pointer('pointerdown', 'pen', 2));
    stop();
    canvas.dispatchEvent(pointer('pointerdown', 'pen', 3));
    expect(seen).toEqual(['pointerdown pen 2 board', 'pointerdown pen 3 board']);
  });
});
