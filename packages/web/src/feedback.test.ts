// @vitest-environment jsdom
import { feedbackOf, listFeedback, writeFeedback, type Feedback, type Region } from '@chalkline/sync';
import { describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { bindFeedback, boardPoint, regionBetween, windowPoint, type CanvasView, type FeedbackCanvas } from './feedback';

const AT = '2026-11-07T01:02:03.000Z';

/** A canvas that isn't scrolled or zoomed, at the window's top left corner. */
const PLAIN: CanvasView = { scrollX: 0, scrollY: 0, zoom: 1, offsetLeft: 0, offsetTop: 0 };

/** A canvas scrolled, zoomed in to twice the size, and set off from the window's top left corner. */
const MOVED: CanvasView = { scrollX: -40, scrollY: 20, zoom: 2, offsetLeft: 10, offsetTop: 5 };

/** The area the tests mark, in the board's coordinates. */
const AREA: Region = { x: 100, y: 50, width: 200, height: 80 };

/** A stand-in for Excalidraw's canvas, whose view each test sets. */
function canvasOf(view: CanvasView, shapes: string[]) {
  let current = view;
  const handlers = new Set<() => void>();
  const shapesIn = vi.fn<(region: Region) => string[]>(() => shapes);
  const showRegion = vi.fn<(region: Region) => void>();
  const canvas: FeedbackCanvas = {
    view: () => current,
    shapesIn,
    showRegion,
    onChange: (handler) => {
      handlers.add(handler);
      return () => {
        handlers.delete(handler);
      };
    },
  };
  return {
    canvas,
    shapesIn,
    showRegion,
    handlers,
    /** Sets the canvas's view, as a scroll or a zoom does, and tells each handler. */
    move(next: CanvasView) {
      current = next;
      for (const handler of handlers) handler();
    },
  };
}

function page(view: CanvasView = PLAIN, shapes: string[] = [], map = feedbackOf(new Y.Doc())) {
  const button = document.createElement('button');
  const layer = document.createElement('div');
  document.body.replaceChildren(button, layer);
  const fake = canvasOf(view, shapes);
  let made = 0;
  const bound = bindFeedback({ button, layer }, map, fake.canvas, {
    writer: () => 'Ada',
    newId: () => `feedback-${(made += 1)}`,
    now: () => new Date(AT),
  });
  return { button, layer, map, ...fake, ...bound };
}

function part(root: Element, selector: string): HTMLElement {
  const found = root.querySelector<HTMLElement>(selector);
  if (found === null) throw new Error(`the layer lacks ${selector}`);
  return found;
}

function button(root: Element, text: string): HTMLButtonElement {
  const found = [...root.querySelectorAll('button')].find((candidate) => candidate.textContent === text);
  if (found === undefined) throw new Error(`the layer lacks the ${text} button`);
  return found;
}

const field = (layer: Element) => part(layer, 'textarea[aria-label="Feedback"]') as HTMLTextAreaElement;

const pointer = (target: EventTarget, type: string, clientX = 0, clientY = 0) =>
  target.dispatchEvent(new MouseEvent(type, { clientX, clientY, button: 0, bubbles: true, cancelable: true }));

/** Drags on the layer from one window point to another, as a person drags a mouse or a finger. */
function drag(layer: HTMLElement, from: [number, number], to: [number, number]) {
  pointer(layer, 'pointerdown', ...from);
  pointer(layer, 'pointermove', (from[0] + to[0]) / 2, (from[1] + to[1]) / 2);
  pointer(layer, 'pointermove', ...to);
  pointer(layer, 'pointerup', ...to);
}

const key = (target: EventTarget, init: KeyboardEventInit) =>
  target.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));

/** Where an element sits on the layer, as its style places it. */
const placed = (element: HTMLElement) => ({
  left: element.style.left,
  top: element.style.top,
  width: element.style.width,
  height: element.style.height,
});

const outlines = (layer: Element) =>
  [...layer.querySelectorAll<HTMLElement>('.feedback-outline')].map((outline) => ({
    id: outline.dataset.id,
    name: outline.querySelector('.feedback-outline-name')?.textContent,
    shown: outline.classList.contains('feedback-shown'),
    ...placed(outline),
  }));

const record = (id: string, by: string, region: Region, answered = false): Feedback => ({
  id,
  by,
  at: AT,
  text: `Feedback ${id}`,
  region,
  shapes: [],
  status: answered ? 'answered' : 'open',
  answer: answered ? { by: 'agent', at: AT, text: 'Moved it' } : null,
});

describe('board and window points', () => {
  it("turns a window point into the board point under it, and back, with the canvas's scroll and zoom", () => {
    expect(boardPoint(100, 50, PLAIN)).toEqual({ x: 100, y: 50 });
    // (130 - 10) / 2 - (-40) = 100, and (145 - 5) / 2 - 20 = 50, as Excalidraw's viewportCoordsToSceneCoords counts.
    expect(boardPoint(130, 145, MOVED)).toEqual({ x: 100, y: 50 });
    expect(windowPoint({ x: 100, y: 50 }, MOVED)).toEqual({ x: 130, y: 145 });
    expect(windowPoint({ x: 300, y: 130 }, MOVED)).toEqual({ x: 530, y: 305 });
  });

  it('makes the same rectangle whichever way the drag goes', () => {
    expect(regionBetween({ x: 100, y: 50 }, { x: 300, y: 130 })).toEqual(AREA);
    expect(regionBetween({ x: 300, y: 130 }, { x: 100, y: 50 })).toEqual(AREA);
    expect(regionBetween({ x: 100, y: 130 }, { x: 300, y: 50 })).toEqual(AREA);
  });
});

describe('feedback mode', () => {
  it('starts only from the Feedback button, which says whether it is on and ends it again', () => {
    const { button: feedbackButton, layer, map } = page();
    expect(feedbackButton.getAttribute('aria-pressed')).toBe('false');
    expect(layer.classList.contains('feedback-active')).toBe(false);
    expect(part(layer, '.feedback-hint').hidden).toBe(true);
    // Outside feedback mode, a drag over the canvas doesn't mark an area.
    drag(layer, [100, 50], [300, 130]);
    expect(part(layer, '.feedback-draft').hidden).toBe(true);
    expect(part(layer, '.feedback-box').hidden).toBe(true);

    feedbackButton.click();
    expect(feedbackButton.getAttribute('aria-pressed')).toBe('true');
    expect(layer.classList.contains('feedback-active')).toBe(true);
    expect(part(layer, '.feedback-hint').hidden).toBe(false);
    feedbackButton.click();
    expect(feedbackButton.getAttribute('aria-pressed')).toBe('false');
    expect(layer.classList.contains('feedback-active')).toBe(false);
    expect(map.size).toBe(0);
  });

  it('draws the rectangle on the layer as the person drags, and opens the text box beside it when the drag ends', () => {
    const { button: feedbackButton, layer, map } = page(MOVED);
    feedbackButton.click();
    pointer(layer, 'pointerdown', 130, 145);
    pointer(layer, 'pointermove', 330, 225);
    expect(part(layer, '.feedback-draft').hidden).toBe(false);
    expect(placed(part(layer, '.feedback-draft'))).toEqual({ left: '130px', top: '145px', width: '200px', height: '80px' });
    expect(part(layer, '.feedback-box').hidden).toBe(true);
    pointer(layer, 'pointermove', 530, 305);
    pointer(layer, 'pointerup', 530, 305);
    expect(placed(part(layer, '.feedback-draft'))).toEqual({ left: '130px', top: '145px', width: '400px', height: '160px' });
    const box = part(layer, '.feedback-box');
    expect(box.hidden).toBe(false);
    // The box opens on the rectangle's right, 8 pixels from its edge, level with its top.
    expect([box.style.left, box.style.top]).toEqual(['538px', '145px']);
    expect(document.activeElement).toBe(field(layer));
    expect(part(layer, '.feedback-hint').hidden).toBe(true);
    // The rectangle is on the layer alone: nothing reaches the board until Send.
    expect(map.size).toBe(0);
  });

  it("doesn't open the text box for a press without a drag", () => {
    const { button: feedbackButton, layer } = page();
    feedbackButton.click();
    pointer(layer, 'pointerdown', 100, 50);
    pointer(layer, 'pointerup', 100, 50);
    expect(part(layer, '.feedback-box').hidden).toBe(true);
    expect(part(layer, '.feedback-draft').hidden).toBe(true);
    expect(feedbackButton.getAttribute('aria-pressed')).toBe('true');
  });

  it('writes one open feedback on Send, with its writer, time and text, the area in board coordinates and the shapes it overlaps', () => {
    const { button: feedbackButton, layer, map, shapesIn } = page(PLAIN, ['shape-1', 'shape-2']);
    feedbackButton.click();
    drag(layer, [100, 50], [300, 130]);
    field(layer).value = '  Make this box blue  ';
    button(part(layer, '.feedback-box'), 'Send').click();
    expect(shapesIn).toHaveBeenCalledWith(AREA);
    expect(listFeedback(map)).toEqual([
      {
        id: 'feedback-1',
        by: 'Ada',
        at: AT,
        text: 'Make this box blue',
        region: AREA,
        shapes: ['shape-1', 'shape-2'],
        status: 'open',
        answer: null,
      },
    ]);
    // Send ends the mode.
    expect(feedbackButton.getAttribute('aria-pressed')).toBe('false');
    expect(part(layer, '.feedback-box').hidden).toBe(true);
    expect(part(layer, '.feedback-draft').hidden).toBe(true);
    expect(field(layer).value).toBe('');
  });

  it('records the same board coordinates for a rectangle drawn at another scroll and zoom', () => {
    const plain = page(PLAIN);
    plain.button.click();
    drag(plain.layer, [100, 50], [300, 130]);
    field(plain.layer).value = 'From a plain view';
    button(part(plain.layer, '.feedback-box'), 'Send').click();
    plain.stop();

    // The same area on a canvas scrolled and zoomed in, dragged from its bottom right corner to its top left.
    const moved = page(MOVED);
    moved.button.click();
    drag(moved.layer, [530, 305], [130, 145]);
    field(moved.layer).value = 'From a moved view';
    button(part(moved.layer, '.feedback-box'), 'Send').click();

    expect(listFeedback(plain.map).map(({ text, region }) => ({ text, region }))).toEqual([{ text: 'From a plain view', region: AREA }]);
    expect(listFeedback(moved.map).map(({ text, region }) => ({ text, region }))).toEqual([{ text: 'From a moved view', region: AREA }]);
  });

  it('sends on Enter, and leaves Shift+Enter and a blank text to the field', () => {
    const { button: feedbackButton, layer, map } = page();
    feedbackButton.click();
    drag(layer, [100, 50], [300, 130]);
    const text = field(layer);
    text.value = '   ';
    button(part(layer, '.feedback-box'), 'Send').click();
    key(text, { key: 'Enter' });
    expect(map.size).toBe(0);
    expect(part(layer, '.feedback-box').hidden).toBe(false);
    text.value = 'Two lines';
    expect(key(text, { key: 'Enter', shiftKey: true })).toBe(true);
    expect(key(text, { key: 'Enter', isComposing: true })).toBe(true);
    expect(map.size).toBe(0);
    expect(key(text, { key: 'Enter' })).toBe(false);
    expect(listFeedback(map).map((sent) => sent.text)).toEqual(['Two lines']);
  });

  it('ends the mode without writing anything on Escape, on Cancel and on the Feedback button', () => {
    const { button: feedbackButton, layer, map } = page();
    const off = () => {
      expect(feedbackButton.getAttribute('aria-pressed')).toBe('false');
      expect(layer.classList.contains('feedback-active')).toBe(false);
      expect(part(layer, '.feedback-box').hidden).toBe(true);
      expect(part(layer, '.feedback-hint').hidden).toBe(true);
      expect(part(layer, '.feedback-draft').hidden).toBe(true);
    };
    // Escape before the drag, and Escape in the text box.
    feedbackButton.click();
    expect(key(document.body, { key: 'Escape' })).toBe(false);
    off();
    feedbackButton.click();
    drag(layer, [100, 50], [300, 130]);
    field(layer).value = 'Not sent';
    key(field(layer), { key: 'Escape' });
    off();
    expect(field(layer).value).toBe('');
    expect(document.activeElement).toBe(feedbackButton);
    // The hint's Cancel and the text box's Cancel.
    feedbackButton.click();
    button(part(layer, '.feedback-hint'), 'Cancel').click();
    off();
    feedbackButton.click();
    drag(layer, [100, 50], [300, 130]);
    field(layer).value = 'Not sent';
    button(part(layer, '.feedback-box'), 'Cancel').click();
    off();
    // The Feedback button while the text box is open.
    feedbackButton.click();
    drag(layer, [100, 50], [300, 130]);
    field(layer).value = 'Not sent';
    feedbackButton.click();
    off();
    expect(map.size).toBe(0);
    // Escape outside feedback mode goes on to the page.
    expect(key(document.body, { key: 'Escape' })).toBe(true);
  });
});

describe('the outlines of open feedback', () => {
  it("outlines each open feedback with its writer's name, where its area lies on the canvas, and leaves out an answered one", () => {
    const map = feedbackOf(new Y.Doc());
    writeFeedback(map, record('open-1', 'Grace', AREA));
    writeFeedback(map, record('answered-1', 'Lin', { x: 0, y: 0, width: 10, height: 10 }, true));
    const { layer } = page(MOVED, [], map);
    expect(outlines(layer)).toEqual([
      { id: 'open-1', name: 'Grace', shown: false, left: '130px', top: '145px', width: '400px', height: '160px' },
    ]);
  });

  it("draws a peer's feedback as it arrives, follows the canvas's scroll and zoom, and goes once it is answered", () => {
    const doc = new Y.Doc();
    const { layer, move } = page(PLAIN, [], feedbackOf(doc));
    expect(outlines(layer)).toEqual([]);
    const peer = new Y.Doc();
    writeFeedback(feedbackOf(peer), record('peer-1', 'Grace', AREA));
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(peer));
    expect(outlines(layer)).toEqual([
      { id: 'peer-1', name: 'Grace', shown: false, left: '100px', top: '50px', width: '200px', height: '80px' },
    ]);
    move(MOVED);
    expect(outlines(layer)).toEqual([
      { id: 'peer-1', name: 'Grace', shown: false, left: '130px', top: '145px', width: '400px', height: '160px' },
    ]);
    writeFeedback(feedbackOf(peer), record('peer-1', 'Grace', AREA, true));
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(peer));
    expect(outlines(layer)).toEqual([]);
  });

  it('draws the outline of an answered feedback again once a person reopens it', () => {
    const map = feedbackOf(new Y.Doc());
    const answered = record('reopened-1', 'Grace', AREA, true);
    writeFeedback(map, answered);
    const { layer } = page(PLAIN, [], map);
    expect(outlines(layer)).toEqual([]);
    writeFeedback(map, { ...answered, status: 'open' });
    expect(outlines(layer)).toEqual([
      { id: 'reopened-1', name: 'Grace', shown: false, left: '100px', top: '50px', width: '200px', height: '80px' },
    ]);
  });

  it('scrolls and zooms the canvas to the area that Show asks for, and outlines it until the next click or tap', () => {
    const map = feedbackOf(new Y.Doc());
    const answered = record('answered-1', 'Lin', AREA, true);
    writeFeedback(map, answered);
    const { layer, show, showRegion } = page(PLAIN, [], map);
    expect(outlines(layer)).toEqual([]);
    show(answered);
    expect(showRegion).toHaveBeenCalledWith(AREA);
    expect(outlines(layer)).toEqual([
      { id: 'answered-1', name: 'Lin', shown: true, left: '100px', top: '50px', width: '200px', height: '80px' },
    ]);
    pointer(document.body, 'pointerdown');
    expect(outlines(layer)).toEqual([]);
  });

  it('stops following the feedback and the canvas once stopped', () => {
    const { layer, map, handlers, stop } = page();
    stop();
    writeFeedback(map, record('late-1', 'Grace', AREA));
    expect(outlines(layer)).toEqual([]);
    expect(handlers.size).toBe(0);
  });
});
