import { listFeedback, newEntryId, writeFeedback, type Feedback, type Region } from '@chalkline/sync';
import type * as Y from 'yjs';

/**
 * The canvas's view, as Excalidraw's `appState` holds it: its scroll, its zoom, and where the canvas's
 * top left corner lies in the window.
 */
export interface CanvasView {
  /** `appState.scrollX`. */
  scrollX: number;
  /** `appState.scrollY`. */
  scrollY: number;
  /** `appState.zoom.value`. */
  zoom: number;
  /** `appState.offsetLeft`: the canvas's left edge, in the window's coordinates. */
  offsetLeft: number;
  /** `appState.offsetTop`: the canvas's top edge, in the window's coordinates. */
  offsetTop: number;
}

/** A point, in the board's coordinates or in the window's, as the function that returns it says. */
export interface Point {
  x: number;
  y: number;
}

/**
 * The board point under the window point (`clientX`, `clientY`), as Excalidraw's
 * `viewportCoordsToSceneCoords` turns one into the other.
 */
export function boardPoint(clientX: number, clientY: number, view: CanvasView): Point {
  return {
    x: (clientX - view.offsetLeft) / view.zoom - view.scrollX,
    y: (clientY - view.offsetTop) / view.zoom - view.scrollY,
  };
}

/** The window point over the board point `point`, as Excalidraw's `sceneCoordsToViewportCoords` turns one into the other. */
export function windowPoint(point: Point, view: CanvasView): Point {
  return {
    x: (point.x + view.scrollX) * view.zoom + view.offsetLeft,
    y: (point.y + view.scrollY) * view.zoom + view.offsetTop,
  };
}

/** The rectangle with the corners `a` and `b`, whichever way a drag went from one to the other. */
export function regionBetween(a: Point, b: Point): Region {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(b.x - a.x), height: Math.abs(b.y - a.y) };
}

/** What `bindFeedback` reads from the canvas, and does to it. */
export interface FeedbackCanvas {
  /** The canvas's view now. */
  view(): CanvasView;
  /** The ids of the board's shapes whose bounds, rotation included, overlap `region`. */
  shapesIn(region: Region): string[];
  /** Scrolls and zooms the canvas so that it shows `region`. */
  showRegion(region: Region): void;
  /** Calls `handler` on each change of the canvas, a change of its view among them; returns the call that stops it. */
  onChange(handler: () => void): () => void;
}

/** The page's elements that `bindFeedback` binds. */
export interface FeedbackElements {
  /** The controls' Feedback button, which starts and ends feedback mode. */
  button: HTMLButtonElement;
  /** The layer over the canvas, which `bindFeedback` fills. */
  layer: HTMLElement;
}

/** Who writes the feedback sent from this page, and the id and the time of each. */
export interface FeedbackOptions {
  /** The person's name, as the board shows it now. */
  writer(): string;
  /** A new feedback's id; random where left out. */
  newId?: () => string;
  /** The time now; the clock where left out. */
  now?: () => Date;
}

/** Where feedback mode stands: off; drawing, where a drag marks an area; or writing, where the text box beside the area is open. */
type Mode = 'off' | 'drawing' | 'writing';

/** The pixels between the marked area and the text box beside it. */
const BOX_GAP = 8;

/**
 * Binds the board's feedback (designs/chalkline A13) to `layer`, the layer over the canvas. The Feedback
 * button puts the canvas in feedback mode, in which a drag on the layer draws a dashed rectangle, which
 * doesn't change the board. When the drag ends, a text box opens beside the rectangle, with Send and
 * Cancel. Send, as Enter does, writes the feedback to `feedback` under `options.writer()`, with the
 * rectangle in the board's coordinates and the ids of the shapes that overlap it, and ends the mode;
 * Shift+Enter adds a line break. Escape, Cancel and the Feedback button end the mode without writing
 * anything. While a feedback is open, the layer draws its rectangle as a dashed outline with its
 * writer's name, which follows the canvas's scroll and zoom.
 *
 * Returns `show`, which scrolls and zooms the canvas to a feedback's area and outlines that area until
 * the person's next click or tap, and `stop`, which ends the mode and stops following the feedback and
 * the canvas.
 */
export function bindFeedback(
  { button, layer }: FeedbackElements,
  feedback: Y.Map<unknown>,
  canvas: FeedbackCanvas,
  options: FeedbackOptions,
): { show(record: Feedback): void; stop(): void } {
  const doc = layer.ownerDocument;
  const newId = options.newId ?? newEntryId;
  const now = options.now ?? (() => new Date());
  const make = <K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text = ''): HTMLElementTagNameMap[K] => {
    const made = doc.createElement(tag);
    made.className = className;
    made.textContent = text;
    return made;
  };
  const action = (text: string, onClick: () => void): HTMLButtonElement => {
    const made = make('button', 'chalkline-button', text);
    made.type = 'button';
    made.addEventListener('click', onClick);
    return made;
  };

  const outlines = make('div', 'feedback-outlines');
  const draftOutline = make('div', 'feedback-draft');
  const hint = make('div', 'feedback-hint');
  hint.append(make('span', '', 'Drag over the area your feedback is about.'), action('Cancel', () => end()));
  const field = make('textarea', 'feedback-field');
  field.rows = 3;
  field.placeholder = 'What should change here?';
  field.setAttribute('aria-label', 'Feedback');
  const box = make('div', 'feedback-box');
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-label', 'Feedback on the marked area');
  const boxActions = make('div', 'feedback-actions');
  boxActions.append(
    action('Cancel', () => end()),
    action('Send', () => send()),
  );
  box.append(field, boxActions);
  layer.replaceChildren(outlines, draftOutline, box, hint);

  let mode: Mode = 'off';
  // The board point where the drag started, while the person drags.
  let start: Point | null = null;
  // The area the person marked, in the board's coordinates, from the drag's start until the mode ends.
  let draft: Region | null = null;
  // The feedback whose area Show outlines.
  let shown: string | null = null;

  /** Puts `element` over `region`, in the layer's own coordinates. */
  const place = (element: HTMLElement, region: Region, view: CanvasView, origin: DOMRect): void => {
    const corner = windowPoint(region, view);
    element.style.left = `${corner.x - origin.left}px`;
    element.style.top = `${corner.y - origin.top}px`;
    element.style.width = `${region.width * view.zoom}px`;
    element.style.height = `${region.height * view.zoom}px`;
  };

  const render = (): void => {
    const view = canvas.view();
    const origin = layer.getBoundingClientRect();
    // The outlines show only open feedback (A11), and the feedback that Show outlines.
    const drawn = listFeedback(feedback).filter((record) => record.status === 'open' || record.id === shown);
    outlines.replaceChildren(
      ...drawn.map((record) => {
        const outline = make('div', record.id === shown ? 'feedback-outline feedback-shown' : 'feedback-outline');
        outline.dataset.id = record.id;
        outline.append(make('span', 'feedback-outline-name', record.by));
        place(outline, record.region, view, origin);
        return outline;
      }),
    );
    draftOutline.hidden = draft === null;
    if (draft !== null) place(draftOutline, draft, view, origin);
    if (mode === 'writing' && draft !== null) {
      const corner = windowPoint(draft, view);
      const left = corner.x - origin.left;
      const right = left + draft.width * view.zoom + BOX_GAP;
      // The box goes on the area's right, or on its left where the layer lacks the room on the right.
      const room = layer.clientWidth;
      const width = box.offsetWidth;
      box.style.left = `${room > 0 && right + width > room ? Math.max(0, left - BOX_GAP - width) : right}px`;
      box.style.top = `${Math.max(0, corner.y - origin.top)}px`;
    }
  };

  const setMode = (next: Mode): void => {
    mode = next;
    layer.classList.toggle('feedback-active', next !== 'off');
    button.setAttribute('aria-pressed', String(next !== 'off'));
    hint.hidden = next !== 'drawing';
    box.hidden = next !== 'writing';
  };

  const move = (event: PointerEvent): void => {
    if (start === null) return;
    draft = regionBetween(start, boardPoint(event.clientX, event.clientY, canvas.view()));
    render();
  };
  const up = (event: PointerEvent): void => {
    if (start === null) return;
    const area = regionBetween(start, boardPoint(event.clientX, event.clientY, canvas.view()));
    stopDrag();
    // A press without a drag doesn't mark an area, so the mode waits for a drag.
    if (area.width === 0 || area.height === 0) {
      draft = null;
      render();
      return;
    }
    draft = area;
    setMode('writing');
    render();
    field.focus();
  };
  const cancelDrag = (): void => {
    stopDrag();
    draft = null;
    render();
  };
  const stopDrag = (): void => {
    start = null;
    doc.removeEventListener('pointermove', move);
    doc.removeEventListener('pointerup', up);
    doc.removeEventListener('pointercancel', cancelDrag);
  };

  const begin = (): void => {
    draft = null;
    setMode('drawing');
    render();
  };
  const end = (): void => {
    const focused = box.contains(doc.activeElement);
    stopDrag();
    draft = null;
    field.value = '';
    setMode('off');
    render();
    if (focused) button.focus();
  };
  const send = (): void => {
    const text = field.value.trim();
    if (text === '' || draft === null) {
      field.focus();
      return;
    }
    const region = draft;
    writeFeedback(feedback, {
      id: newId(),
      by: options.writer(),
      at: now().toISOString(),
      text,
      region,
      shapes: canvas.shapesIn(region),
      status: 'open',
      answer: null,
      reopened: null,
    });
    end();
  };

  button.addEventListener('click', () => {
    if (mode === 'off') begin();
    else end();
  });
  layer.addEventListener('pointerdown', (event) => {
    if (mode !== 'drawing' || event.button !== 0) return;
    if (event.target instanceof Node && hint.contains(event.target)) return;
    event.preventDefault();
    start = boardPoint(event.clientX, event.clientY, canvas.view());
    draft = regionBetween(start, start);
    doc.addEventListener('pointermove', move);
    doc.addEventListener('pointerup', up);
    doc.addEventListener('pointercancel', cancelDrag);
    render();
  });
  field.addEventListener('keydown', (event) => {
    // Shift+Enter, and Enter while an input method composes a character, go to the field as other keys do.
    if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
    event.preventDefault();
    send();
  });
  // Escape ends the mode from anywhere on the page, before the canvas or the chat reads the key.
  const escape = (event: KeyboardEvent): void => {
    if (mode === 'off' || event.key !== 'Escape' || event.isComposing) return;
    event.preventDefault();
    event.stopPropagation();
    end();
  };
  doc.addEventListener('keydown', escape, true);
  // The area that Show outlines stays outlined until the person's next click or tap, wherever it is.
  const unshow = (): void => {
    if (shown === null) return;
    shown = null;
    render();
  };
  doc.addEventListener('pointerdown', unshow, true);

  setMode('off');
  feedback.observe(render);
  const stopCanvas = canvas.onChange(render);
  render();

  return {
    show(record) {
      canvas.showRegion(record.region);
      shown = record.id;
      render();
    },
    stop() {
      end();
      feedback.unobserve(render);
      stopCanvas();
      doc.removeEventListener('keydown', escape, true);
      doc.removeEventListener('pointerdown', unshow, true);
    },
  };
}
