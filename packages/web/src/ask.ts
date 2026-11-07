import { newEntryId, writeFeedback, type Region } from '@chalkline/sync';
import type * as Y from 'yjs';
import { windowPoint, type CanvasView, type FeedbackOptions } from './feedback';

/** The words of the button beside a selection, and of the canvas's menu entry, that ask an agent about the selected shapes. */
export const ASK_LABEL = 'Ask an agent';

/** The asks that a person sends with one click, each as the ask's text. */
export const QUICK_ASKS: readonly string[] = ['Tidy this up', 'Explain this'];

/** The shapes a person selected on the canvas. */
export interface Selection {
  /** The ids of the selected shapes, without the text inside a selected shape. */
  shapes: string[];
  /** The rectangle that holds every selected shape, in the board's coordinates. */
  bounds: Region;
}

/** What `selectionOf` reads of the canvas's state. */
export interface SelectionState {
  /** The ids of the selected shapes, each with true. */
  selectedElementIds: Readonly<Record<string, boolean>>;
  /** Whether the person is dragging the selected shapes. */
  selectedElementsAreBeingDragged: boolean;
  isResizing: boolean;
  isRotating: boolean;
  /** The rectangle the person drags out to select shapes, while they drag it, or null. */
  selectionElement: unknown;
  /** The text the person is writing, while they write it, or null. */
  editingTextElement: unknown;
  /** The shape the person is drawing, while they draw it, or null. */
  newElement: unknown;
}

/** What `selectionOf` reads of each shape on the canvas. */
export interface SelectionShape {
  id: string;
  type: string;
  /** For a text, the shape the text is inside, or null. */
  containerId?: string | null;
}

/**
 * The shapes selected in `state`, as `AskCanvas.selection` answers them, or null while the person drags,
 * resizes, rotates, draws or writes, or hasn't selected any shape. `shapes` answers every shape on the canvas,
 * and `selectionOf` calls it only where `state` holds a selected shape: the canvas calls its handlers on each of
 * its changes, and a board can hold thousands of shapes. `bounds` answers the rectangle that holds the selected
 * shapes.
 */
export function selectionOf<S extends SelectionShape>(
  state: SelectionState,
  shapes: () => readonly S[],
  bounds: (selected: readonly S[]) => Region,
): Selection | null {
  if (
    state.selectedElementsAreBeingDragged ||
    state.isResizing ||
    state.isRotating ||
    state.selectionElement !== null ||
    state.editingTextElement !== null ||
    state.newElement !== null
  ) {
    return null;
  }
  if (!Object.values(state.selectedElementIds).includes(true)) return null;
  const selected = shapes().filter((shape) => state.selectedElementIds[shape.id] === true);
  if (selected.length === 0) return null;
  // The text inside a selected shape goes with its shape, so the ask lists the shape alone.
  const ids = selected
    .filter(
      (shape) =>
        !(shape.type === 'text' && shape.containerId != null && state.selectedElementIds[shape.containerId] === true),
    )
    .map((shape) => shape.id);
  return { shapes: ids, bounds: bounds(selected) };
}

/** What `bindAsk` reads from the canvas, and does to it. */
export interface AskCanvas {
  /** The canvas's view now. */
  view(): CanvasView;
  /**
   * The shapes selected now, or null where the person hasn't selected any, or is still dragging,
   * resizing, rotating or drawing them.
   */
  selection(): Selection | null;
  /** The canvas's context menu while it is open, or null. */
  contextMenu(): HTMLElement | null;
  /** Closes the canvas's context menu. */
  closeMenu(): void;
  /** Calls `handler` on each change of the canvas, a change of its view or its selection among them; returns the call that stops it. */
  onChange(handler: () => void): () => void;
}

/** What `bindAsk` reads of the board's room. */
export interface AskRoom {
  /** Whether an agent's helper is on the board now. */
  agentHere(): boolean;
  /** Calls `handler` on each change of who is on the board; returns the call that stops it. */
  onChange(handler: () => void): () => void;
}

/** The page's element that `bindAsk` fills. */
export interface AskElements {
  /** The layer over the canvas. */
  layer: HTMLElement;
}

/** The pixels between the selection's bottom edge and the Ask an agent button under it. */
const GAP = 12;

/** The pixels between the selection and the ask's box beside it. */
const BOX_GAP = 8;

/** The class of the entry that `bindAsk` adds at the top of the canvas's context menu. */
const MENU_ENTRY = 'ask-menu-item';

/** The class of the separator under that entry. */
const MENU_SEPARATOR = 'ask-menu-separator';

/**
 * Binds Ask an agent to `layer`, the layer over the canvas. While an agent's helper is on the board and
 * the person has selected shapes, an Ask an agent button shows under the selection, and the canvas's
 * context menu holds an Ask an agent entry at its top. Either opens a box beside the selection, which
 * asks about the shapes selected when it opened: each quick ask sends its text at once, and Send, as
 * Enter does, sends the text the person wrote; Shift+Enter adds a line break. An ask goes to
 * `feedback` as a record of kind "ask", under `options.writer()`, with the selected shapes' ids and the
 * rectangle that holds them, and closes the box. Escape and Cancel close the box without writing
 * anything. While no agent is on the board, the box says so and doesn't send.
 *
 * Returns `open`, which opens the box for the selection now, and `stop`, which closes the box and
 * stops following the canvas and the room.
 */
export function bindAsk(
  { layer }: AskElements,
  feedback: Y.Map<unknown>,
  canvas: AskCanvas,
  room: AskRoom,
  options: FeedbackOptions,
): { open(): void; stop(): void } {
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

  const outline = make('div', 'feedback-draft ask-draft');
  const opener = action(ASK_LABEL, () => open());
  opener.classList.add('ask-button');
  opener.title = 'Ask an agent about the selected shapes';
  const quick = QUICK_ASKS.map((text) => action(text, () => send(text)));
  const choices = make('div', 'ask-choices');
  choices.append(...quick);
  const field = make('textarea', 'feedback-field');
  field.rows = 3;
  field.placeholder = 'Or write what the agent should do with these shapes';
  field.setAttribute('aria-label', ASK_LABEL);
  const note = make('p', 'ask-note', "No agent is on the board now, so the ask can't be sent until one joins.");
  const sendButton = action('Send', () => send(field.value));
  const actions = make('div', 'feedback-actions');
  actions.append(
    action('Cancel', () => close()),
    sendButton,
  );
  const box = make('div', 'feedback-box ask-box');
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-label', 'Ask an agent about the selected shapes');
  box.append(choices, field, note, actions);
  layer.replaceChildren(outline, opener, box);

  // The selection the open box asks about, as it stood when the box opened, or null while the box is closed.
  let asked: Selection | null = null;

  /** Puts the button under the selection's bottom left corner, or above its top where the layer lacks the room below. */
  const placeButton = (bounds: Region, view: CanvasView, origin: DOMRect): void => {
    const top = windowPoint(bounds, view);
    const bottom = windowPoint({ x: bounds.x, y: bounds.y + bounds.height }, view);
    const below = bottom.y - origin.top + GAP;
    const height = opener.offsetHeight;
    const space = layer.clientHeight;
    opener.style.left = `${Math.max(0, bottom.x - origin.left)}px`;
    opener.style.top = `${space > 0 && below + height > space ? Math.max(0, top.y - origin.top - GAP - height) : below}px`;
  };

  /** Puts the outline over `bounds`, and the box on its right, or on its left where the layer lacks the room on the right. */
  const placeBox = (bounds: Region, view: CanvasView, origin: DOMRect): void => {
    const corner = windowPoint(bounds, view);
    const left = corner.x - origin.left;
    const top = corner.y - origin.top;
    outline.style.left = `${left}px`;
    outline.style.top = `${top}px`;
    outline.style.width = `${bounds.width * view.zoom}px`;
    outline.style.height = `${bounds.height * view.zoom}px`;
    const right = left + bounds.width * view.zoom + BOX_GAP;
    const space = layer.clientWidth;
    const width = box.offsetWidth;
    box.style.left = `${space > 0 && right + width > space ? Math.max(0, left - BOX_GAP - width) : right}px`;
    box.style.top = `${Math.max(0, top)}px`;
  };

  // Whether the canvas's context menu may hold the entry, so that a change that doesn't offer the entry
  // looks for the menu only where the menu may hold an entry to take out.
  let entered = false;

  /** Adds the entry at the top of the canvas's context menu where `offered` is true, and takes it out where it is false. */
  const offerInMenu = (offered: boolean): void => {
    if (!offered && !entered) return;
    const menu = canvas.contextMenu();
    if (menu === null) {
      entered = false;
      return;
    }
    const added = menu.querySelectorAll(`.${MENU_ENTRY}, .${MENU_SEPARATOR}`);
    if (!offered) {
      for (const part of Array.from(added)) part.remove();
      entered = false;
      return;
    }
    entered = true;
    // The canvas calls each handler on each of its changes, so the entry goes in once for each menu it opens.
    if (added.length > 0) return;
    const entry = make('li', MENU_ENTRY);
    const entryButton = make('button', 'context-menu-item');
    entryButton.type = 'button';
    entryButton.append(make('div', 'context-menu-item__label', ASK_LABEL));
    entryButton.addEventListener('click', () => open());
    entry.append(entryButton);
    menu.prepend(entry, make('hr', `context-menu-item-separator ${MENU_SEPARATOR}`));
  };

  /** Shows or hides `part`, and writes it only where that changes it. */
  const show = (part: HTMLElement, shown: boolean): void => {
    if (part.hidden === shown) part.hidden = !shown;
  };
  /** Enables or disables `control`, and writes it only where that changes it. */
  const enable = (control: HTMLButtonElement, enabled: boolean): void => {
    if (control.disabled === enabled) control.disabled = !enabled;
  };

  // The canvas and the room call `render` on each of their changes, each change of a shape among them, so a
  // render that shows nothing new doesn't write the page, read every shape or make the browser lay out the page.
  const render = (): void => {
    const here = room.agentHere();
    // The button and the menu's entry show only while an agent is on the board to answer, the person
    // has selected shapes, and the box is closed.
    const selection = here && asked === null ? canvas.selection() : null;
    show(opener, selection !== null);
    show(outline, asked !== null);
    show(box, asked !== null);
    if (selection !== null || asked !== null) {
      // Reading the layer's place makes the browser lay out the page, so render reads it only where the layer shows something.
      const view = canvas.view();
      const origin = layer.getBoundingClientRect();
      if (selection !== null) placeButton(selection.bounds, view, origin);
      if (asked !== null) placeBox(asked.bounds, view, origin);
    }
    show(note, !here);
    enable(sendButton, here);
    for (const choice of quick) enable(choice, here);
    offerInMenu(selection !== null);
  };

  const open = (): void => {
    const selection = canvas.selection();
    if (selection === null || !room.agentHere()) return;
    asked = { shapes: [...selection.shapes], bounds: { ...selection.bounds } };
    canvas.closeMenu();
    render();
    field.focus();
  };
  const close = (): void => {
    const focused = box.contains(doc.activeElement);
    asked = null;
    field.value = '';
    render();
    if (focused && !opener.hidden) opener.focus();
  };
  const send = (text: string): void => {
    if (asked === null) return;
    const asking = text.trim();
    if (asking === '' || !room.agentHere()) {
      field.focus();
      return;
    }
    writeFeedback(feedback, {
      id: newId(),
      by: options.writer(),
      at: now().toISOString(),
      text: asking,
      region: asked.bounds,
      shapes: asked.shapes,
      status: 'open',
      answer: null,
      reopened: null,
      kind: 'ask',
    });
    close();
  };

  field.addEventListener('keydown', (event) => {
    // Shift+Enter, and Enter while an input method composes a character, go to the field as other keys do.
    if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
    event.preventDefault();
    send(field.value);
  });
  // Escape closes the box from anywhere on the page, before the canvas or the chat reads the key.
  const escape = (event: KeyboardEvent): void => {
    if (asked === null || event.key !== 'Escape' || event.isComposing) return;
    event.preventDefault();
    event.stopPropagation();
    close();
  };
  doc.addEventListener('keydown', escape, true);

  const stopCanvas = canvas.onChange(render);
  const stopRoom = room.onChange(render);
  render();

  return {
    open,
    stop() {
      close();
      offerInMenu(false);
      stopCanvas();
      stopRoom();
      doc.removeEventListener('keydown', escape, true);
    },
  };
}
