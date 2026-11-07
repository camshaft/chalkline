/**
 * What the pen's side button does on the board. A pen tablet's side button, the button on the pen's barrel, reaches
 * the page as a press of the pen's secondary button: a `pointerdown` whose `pointerType` is `pen` and whose `button`
 * is 2, the button a mouse's right click reports too, and Excalidraw opens its context menu on it. The person chooses
 * in the main menu what the press does, such as switching between the last two tools, so that they change tools
 * without the keyboard. The page keeps the choice in the browser's storage, as it keeps the person's name, so that it
 * stays across visits. It is this browser's, and doesn't reach the board's other pages.
 */
import type { ToolType } from '@excalidraw/excalidraw/types';

/** What a press of the pen's side button does. */
export type SideButtonAction = 'swap' | 'eraser' | 'select' | 'menu';

/** Each choice of the setting, in the main menu's order, with the words its item shows. */
export const SIDE_BUTTON_ACTIONS: readonly { action: SideButtonAction; label: string }[] = [
  { action: 'swap', label: 'Switch between the last two tools' },
  { action: 'eraser', label: 'Toggle the eraser' },
  { action: 'select', label: 'Toggle the selection tool' },
  { action: 'menu', label: 'Open the menu' },
];

/**
 * What the side button does until the person chooses: it switches between the last two tools, so that a person who
 * draws with the pen moves between two tools, such as free draw and the selection tool, without the keyboard.
 * Excalidraw's context menu stays one choice away, and a mouse's right click still opens it.
 */
export const DEFAULT_SIDE_BUTTON: SideButtonAction = 'swap';

/** The key the setting has in the browser's storage. */
export const SIDE_BUTTON_KEY = 'chalkline.penSideButton';

/** The part of a browser's storage that the setting reads and writes. */
export type SideButtonStorage = Pick<Storage, 'getItem' | 'setItem'>;

const isAction = (value: unknown): value is SideButtonAction => SIDE_BUTTON_ACTIONS.some(({ action }) => action === value);

/**
 * The choice `storage` keeps, or the default where the browser doesn't keep a choice, keeps one this page doesn't
 * know, or refuses the read.
 */
export function keptSideButton(storage: SideButtonStorage | undefined): SideButtonAction {
  if (storage === undefined) return DEFAULT_SIDE_BUTTON;
  try {
    const kept = storage.getItem(SIDE_BUTTON_KEY);
    return isAction(kept) ? kept : DEFAULT_SIDE_BUTTON;
  } catch {
    return DEFAULT_SIDE_BUTTON;
  }
}

/** Keeps `action` in `storage`. A browser that refuses the write keeps the choice it held. */
export function keepSideButton(storage: SideButtonStorage | undefined, action: SideButtonAction): void {
  if (storage === undefined) return;
  try {
    storage.setItem(SIDE_BUTTON_KEY, action);
  } catch {
    // The browser refuses to keep it, as a private window can; the setting still holds the choice this visit.
  }
}

/** The setting, as the main menu reads and sets it. */
export interface SideButtonSetting {
  /** What a press of the side button does now. */
  get(): SideButtonAction;
  /** Sets what a press of the side button does, and keeps it for this browser's next visit. */
  set(action: SideButtonAction): void;
}

/** The setting, which starts at the choice `storage` keeps and keeps each choice set. */
export function sideButtonSetting(storage: SideButtonStorage | undefined): SideButtonSetting {
  let action = keptSideButton(storage);
  return {
    get: () => action,
    set: (next) => {
      action = next;
      keepSideButton(storage, next);
    },
  };
}

/** A tool the side button sets. It never sets Excalidraw's image tool, which asks for a file. */
export type PenTool = Exclude<ToolType, 'image'>;

/** A tool Excalidraw's app state holds, which can also be the image tool or a custom tool. */
export type HeldTool = ToolType | 'custom';

const isPenTool = (tool: HeldTool): tool is PenTool => tool !== 'image' && tool !== 'custom';

/**
 * The tool to go back to from `current`: `previous`, the tool before it, where there is one and it isn't `current`;
 * otherwise free draw, or the selection tool from free draw.
 */
function back(current: HeldTool, previous: PenTool | null): PenTool {
  if (previous !== null && previous !== current) return previous;
  return current === 'freedraw' ? 'selection' : 'freedraw';
}

/**
 * The tool a press of the side button sets for `action`, where `current` is the tool now and `previous` the tool
 * before it, or null where the press stays Excalidraw's, which opens its context menu on it.
 */
export function nextTool(action: SideButtonAction, current: HeldTool, previous: PenTool | null): PenTool | null {
  switch (action) {
    case 'swap':
      return back(current, previous);
    case 'eraser':
      return current === 'eraser' ? back(current, previous) : 'eraser';
    case 'select':
      return current === 'selection' ? back(current, previous) : 'selection';
    case 'menu':
      return null;
  }
}

/** The board whose tool the side button sets, as the page reads it from Excalidraw's API. */
export interface PenBoard {
  /** The tool active now. */
  tool(): HeldTool;
  /** Makes `tool` the active tool. */
  setTool(tool: PenTool): void;
  /** Calls `listener` on each change of Excalidraw's scene or app state; returns the call that stops it. */
  onChange(listener: () => void): () => void;
}

/** The events of a press that the page stops where it acts on the press. */
const STOPPED = ['pointerdown', 'pointerup', 'pointercancel', 'contextmenu'] as const;

/**
 * Makes a press of the pen's side button on `element` set the tool that `action` reads at the press, in place of
 * opening Excalidraw's context menu. It listens on the window as each event starts on its way to `element`, before
 * the page's other listeners, and where the press sets a tool, it stops the press, the release or the cancel of that
 * pen, and the context menu that comes after the press, so that Excalidraw doesn't receive them. A press of another
 * button, a mouse's right click among them, and a press the action leaves to Excalidraw go on as before. It follows
 * each change of the tool, so that a press goes back to the tool before the current one. Returns `stop`, which stops
 * both.
 */
export function bindPenSideButton(element: Element, board: PenBoard, action: () => SideButtonAction): () => void {
  const target: EventTarget = element.ownerDocument.defaultView ?? element.ownerDocument;
  let current = board.tool();
  let previous: PenTool | null = null;
  const follow = (tool: HeldTool) => {
    if (tool === current) return;
    if (isPenTool(current)) previous = current;
    current = tool;
  };
  const stopFollowing = board.onChange(() => follow(board.tool()));
  // The pen whose press the page acted on, until its release, and whether the page stops the context menu that
  // comes next.
  let held: number | null = null;
  let menuStopped = false;
  const stopEvent = (event: Event) => {
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  const listener = (event: Event) => {
    const press = event as PointerEvent;
    switch (event.type) {
      case 'pointerdown': {
        menuStopped = false;
        if (press.pointerType !== 'pen' || press.button !== 2) return;
        if (!(event.target instanceof Node) || !element.contains(event.target)) return;
        // The tool can change without a report to `follow` yet, so the press reads it.
        follow(board.tool());
        const tool = nextTool(action(), current, previous);
        if (tool === null) return;
        stopEvent(event);
        held = press.pointerId;
        menuStopped = true;
        board.setTool(tool);
        follow(tool);
        return;
      }
      case 'pointerup':
      case 'pointercancel':
        if (held === null || press.pointerId !== held) return;
        held = null;
        stopEvent(event);
        return;
      case 'contextmenu':
        if (!menuStopped) return;
        menuStopped = false;
        stopEvent(event);
        return;
    }
  };
  for (const type of STOPPED) target.addEventListener(type, listener, true);
  return () => {
    for (const type of STOPPED) target.removeEventListener(type, listener, true);
    stopFollowing();
  };
}
