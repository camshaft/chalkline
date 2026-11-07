// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import {
  bindPenSideButton,
  DEFAULT_SIDE_BUTTON,
  keepSideButton,
  keptSideButton,
  nextTool,
  SIDE_BUTTON_ACTIONS,
  SIDE_BUTTON_KEY,
  sideButtonSetting,
  type HeldTool,
  type PenBoard,
  type PenTool,
  type SideButtonAction,
  type SideButtonStorage,
} from './pen';

class MemoryStorage implements SideButtonStorage {
  readonly items = new Map<string, string>();

  getItem(key: string): string | null {
    return this.items.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.items.set(key, value);
  }
}

/** A browser's storage that refuses each read and write, as a private window can. */
const refusing: SideButtonStorage = {
  getItem: () => {
    throw new Error('the browser refuses to read its storage');
  },
  setItem: () => {
    throw new Error('the browser refuses to write its storage');
  },
};

describe('the pen side button setting', () => {
  it('switches between the last two tools until the person chooses', () => {
    expect(DEFAULT_SIDE_BUTTON).toBe('swap');
    expect(keptSideButton(undefined)).toBe('swap');
    expect(keptSideButton(new MemoryStorage())).toBe('swap');
  });

  it('lists each choice once, in the order the menu shows them', () => {
    expect(SIDE_BUTTON_ACTIONS.map(({ action }) => action)).toEqual(['swap', 'eraser', 'select', 'menu']);
  });

  it('reads back each choice it keeps', () => {
    const storage = new MemoryStorage();
    for (const { action } of SIDE_BUTTON_ACTIONS) {
      keepSideButton(storage, action);
      expect(storage.items.get(SIDE_BUTTON_KEY)).toBe(action);
      expect(keptSideButton(storage)).toBe(action);
    }
  });

  it("reads the default where the browser keeps a choice the page doesn't know, or refuses the read", () => {
    const storage = new MemoryStorage();
    storage.items.set(SIDE_BUTTON_KEY, 'jump');
    expect(keptSideButton(storage)).toBe('swap');
    expect(keptSideButton(refusing)).toBe('swap');
  });

  it('starts at the kept choice, and keeps each choice set', () => {
    const storage = new MemoryStorage();
    keepSideButton(storage, 'select');
    const setting = sideButtonSetting(storage);
    expect(setting.get()).toBe('select');
    setting.set('menu');
    expect(setting.get()).toBe('menu');
    expect(sideButtonSetting(storage).get()).toBe('menu');
  });

  it('holds the choice for this visit where the browser refuses to keep it', () => {
    expect(() => keepSideButton(refusing, 'eraser')).not.toThrow();
    const setting = sideButtonSetting(refusing);
    setting.set('eraser');
    expect(setting.get()).toBe('eraser');
  });
});

describe('nextTool', () => {
  it.each<[SideButtonAction, HeldTool, PenTool | null, PenTool | null]>([
    ['swap', 'freedraw', 'selection', 'selection'],
    ['swap', 'rectangle', 'freedraw', 'freedraw'],
    ['swap', 'selection', null, 'freedraw'],
    ['swap', 'freedraw', null, 'selection'],
    ['swap', 'freedraw', 'freedraw', 'selection'],
    ['swap', 'image', 'arrow', 'arrow'],
    ['swap', 'custom', null, 'freedraw'],
    ['eraser', 'freedraw', 'selection', 'eraser'],
    ['eraser', 'eraser', 'arrow', 'arrow'],
    ['eraser', 'eraser', null, 'freedraw'],
    ['select', 'freedraw', null, 'selection'],
    ['select', 'selection', 'ellipse', 'ellipse'],
    ['select', 'selection', null, 'freedraw'],
    ['menu', 'freedraw', 'selection', null],
  ])('for %s from %s, after %s, sets %s', (action, current, previous, expected) => {
    expect(nextTool(action, current, previous)).toBe(expected);
  });
});

/** A board whose tool changes as Excalidraw's does: a change through `setTool` or `choose` calls each listener. */
function fakeBoard(start: HeldTool) {
  let tool = start;
  const listeners = new Set<() => void>();
  const set: PenTool[] = [];
  const changed = () => {
    for (const listener of listeners) listener();
  };
  const board: PenBoard = {
    tool: () => tool,
    setTool: (next) => {
      set.push(next);
      tool = next;
      changed();
    },
    onChange: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  return {
    board,
    /** Each tool the side button set, in order. */
    set,
    listeners,
    /** Changes the tool as the toolbar or a shortcut does. */
    choose: (next: HeldTool) => {
      tool = next;
      changed();
    },
    /** Changes the tool without a call of the listeners, as where Excalidraw hasn't reported the change yet. */
    quietly: (next: HeldTool) => {
      tool = next;
    },
  };
}

/** A pointer event of `type`. jsdom's MouseEvent stands in for the browser's PointerEvent. */
function pointer(type: string, pointerType: 'pen' | 'mouse', button: number): MouseEvent {
  const event = new MouseEvent(type, { button, bubbles: true, cancelable: true });
  Object.defineProperties(event, {
    pointerType: { value: pointerType },
    pointerId: { value: pointerType === 'pen' ? 2 : 1 },
  });
  return event;
}

/** The context menu event a browser sends for a press of the secondary button. */
const contextMenu = () => new MouseEvent('contextmenu', { button: 2, bubbles: true, cancelable: true });

function found(selector: string): Element {
  const element = document.querySelector(selector);
  if (element === null) throw new Error(`the page doesn't hold ${selector}`);
  return element;
}

const stops: (() => void)[] = [];

afterEach(() => {
  for (const stop of stops.splice(0)) stop();
  document.body.innerHTML = '';
});

/**
 * A page that holds the board's element, with a canvas in it, and an element outside it, with the side button bound
 * on the board's element. `seen` lists each event the board's element receives, as Excalidraw's listeners there do.
 */
function page(board: PenBoard, action: () => SideButtonAction) {
  document.body.innerHTML = '<div id="app"><canvas></canvas></div><p id="outside"></p>';
  const app = found('#app');
  const seen: string[] = [];
  for (const type of ['pointerdown', 'pointerup', 'pointercancel', 'contextmenu']) {
    app.addEventListener(type, () => seen.push(type));
  }
  const stop = bindPenSideButton(app, board, action);
  stops.push(stop);
  return { canvas: found('#app canvas'), outside: found('#outside'), seen, stop };
}

/** Presses and releases the pen's side button on `target`, with the context menu after the release, as Windows sends it. */
function press(target: Element): void {
  target.dispatchEvent(pointer('pointerdown', 'pen', 2));
  target.dispatchEvent(pointer('pointerup', 'pen', 2));
  target.dispatchEvent(contextMenu());
}

describe('bindPenSideButton', () => {
  it("switches tools on a press of the side button, and the board doesn't receive the press, its release or the menu", () => {
    const { board, set } = fakeBoard('selection');
    const { canvas, seen } = page(board, () => 'swap');
    const down = pointer('pointerdown', 'pen', 2);
    const menu = contextMenu();
    const up = pointer('pointerup', 'pen', 2);
    // Some systems send the context menu as the button goes down, before its release.
    for (const event of [down, menu, up]) canvas.dispatchEvent(event);
    expect(set).toEqual(['freedraw']);
    expect(seen).toEqual([]);
    expect([down.defaultPrevented, menu.defaultPrevented, up.defaultPrevented]).toEqual([true, true, true]);
  });

  it('stops the menu that comes after the release', () => {
    const { board, set } = fakeBoard('selection');
    const { canvas, seen } = page(board, () => 'swap');
    press(canvas);
    expect(set).toEqual(['freedraw']);
    expect(seen).toEqual([]);
  });

  it('goes back to the tool before the current one, whichever way the person chose it', () => {
    const { board, set, choose } = fakeBoard('selection');
    const { canvas } = page(board, () => 'swap');
    press(canvas);
    press(canvas);
    expect(set).toEqual(['freedraw', 'selection']);
    // The toolbar or a shortcut picks the rectangle: the next press goes back to the selection tool, and the one
    // after it to the rectangle.
    choose('rectangle');
    press(canvas);
    press(canvas);
    expect(set).toEqual(['freedraw', 'selection', 'selection', 'rectangle']);
  });

  it('goes back past the image tool and custom tools, which it never sets', () => {
    const { board, set, choose } = fakeBoard('selection');
    const { canvas } = page(board, () => 'swap');
    choose('arrow');
    choose('image');
    press(canvas);
    choose('custom');
    press(canvas);
    expect(set).toEqual(['arrow', 'arrow']);
  });

  it("reads the tool as the press comes, where the board hasn't reported its change yet", () => {
    const { board, set, quietly } = fakeBoard('selection');
    const { canvas } = page(board, () => 'swap');
    quietly('ellipse');
    press(canvas);
    expect(set).toEqual(['selection']);
  });

  it('toggles the eraser or the selection tool, as the setting reads at each press', () => {
    const { board, set } = fakeBoard('freedraw');
    let action: SideButtonAction = 'eraser';
    const { canvas } = page(board, () => action);
    press(canvas);
    press(canvas);
    action = 'select';
    press(canvas);
    press(canvas);
    expect(set).toEqual(['eraser', 'freedraw', 'selection', 'freedraw']);
  });

  it('leaves the press to Excalidraw, which opens its menu, where the setting says so', () => {
    const { board, set } = fakeBoard('freedraw');
    const { canvas, seen } = page(board, () => 'menu');
    const down = pointer('pointerdown', 'pen', 2);
    const menu = contextMenu();
    canvas.dispatchEvent(down);
    canvas.dispatchEvent(menu);
    canvas.dispatchEvent(pointer('pointerup', 'pen', 2));
    expect(set).toEqual([]);
    expect(seen).toEqual(['pointerdown', 'contextmenu', 'pointerup']);
    expect([down.defaultPrevented, menu.defaultPrevented]).toEqual([false, false]);
  });

  it("leaves a mouse's right click, the pen's tip and its eraser end to Excalidraw", () => {
    const { board, set } = fakeBoard('freedraw');
    const { canvas, seen } = page(board, () => 'swap');
    canvas.dispatchEvent(pointer('pointerdown', 'mouse', 2));
    canvas.dispatchEvent(contextMenu());
    canvas.dispatchEvent(pointer('pointerup', 'mouse', 2));
    for (const button of [0, 5]) {
      canvas.dispatchEvent(pointer('pointerdown', 'pen', button));
      canvas.dispatchEvent(pointer('pointerup', 'pen', button));
    }
    expect(set).toEqual([]);
    expect(seen).toEqual(['pointerdown', 'contextmenu', 'pointerup', 'pointerdown', 'pointerup', 'pointerdown', 'pointerup']);
  });

  it("opens Excalidraw's menu on a right click after a press whose menu the browser didn't send", () => {
    const { board } = fakeBoard('freedraw');
    const { canvas, seen } = page(board, () => 'swap');
    canvas.dispatchEvent(pointer('pointerdown', 'pen', 2));
    canvas.dispatchEvent(pointer('pointerup', 'pen', 2));
    canvas.dispatchEvent(pointer('pointerdown', 'mouse', 2));
    const menu = contextMenu();
    canvas.dispatchEvent(menu);
    expect(seen).toEqual(['pointerdown', 'contextmenu']);
    expect(menu.defaultPrevented).toBe(false);
  });

  it('leaves a press outside the board to the page', () => {
    const { board, set } = fakeBoard('freedraw');
    const { outside } = page(board, () => 'swap');
    const down = pointer('pointerdown', 'pen', 2);
    outside.dispatchEvent(down);
    expect(set).toEqual([]);
    expect(down.defaultPrevented).toBe(false);
  });

  it('stops only the release or the cancel of the pen it acted on', () => {
    const { board } = fakeBoard('freedraw');
    const { canvas, seen } = page(board, () => 'swap');
    canvas.dispatchEvent(pointer('pointerdown', 'pen', 2));
    canvas.dispatchEvent(pointer('pointerup', 'mouse', 0));
    canvas.dispatchEvent(pointer('pointercancel', 'pen', 2));
    canvas.dispatchEvent(pointer('pointerup', 'pen', 2));
    expect(seen).toEqual(['pointerup', 'pointerup']);
  });

  it("lets the board receive the release of the pen's next press, where the side button's release didn't come", () => {
    const { board, set } = fakeBoard('freedraw');
    const { canvas, seen } = page(board, () => 'swap');
    canvas.dispatchEvent(pointer('pointerdown', 'pen', 2));
    expect(set).toEqual(['selection']);
    const down = pointer('pointerdown', 'pen', 0);
    const up = pointer('pointerup', 'pen', 0);
    canvas.dispatchEvent(down);
    canvas.dispatchEvent(up);
    expect(seen).toEqual(['pointerdown', 'pointerup']);
    expect([down.defaultPrevented, up.defaultPrevented]).toEqual([false, false]);
  });

  it('stops acting on presses and following the board once stopped', () => {
    const { board, set, listeners } = fakeBoard('freedraw');
    const { canvas, seen, stop } = page(board, () => 'swap');
    stop();
    canvas.dispatchEvent(pointer('pointerdown', 'pen', 2));
    expect(set).toEqual([]);
    expect(seen).toEqual(['pointerdown']);
    expect(listeners.size).toBe(0);
  });
});
