// @vitest-environment jsdom
import { feedbackKind, feedbackOf, listFeedback } from '@chalkline/sync';
import { describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { ASK_LABEL, bindAsk, QUICK_ASKS, type AskCanvas, type AskRoom, type Selection } from './ask';
import type { CanvasView } from './feedback';

const AT = '2026-11-07T01:02:03.000Z';

/** A canvas that isn't scrolled or zoomed, at the window's top left corner. */
const PLAIN: CanvasView = { scrollX: 0, scrollY: 0, zoom: 1, offsetLeft: 0, offsetTop: 0 };

/** A canvas scrolled, zoomed in to twice the size, and set off from the window's top left corner. */
const MOVED: CanvasView = { scrollX: -40, scrollY: 20, zoom: 2, offsetLeft: 10, offsetTop: 5 };

/** Two shapes the tests select, and the rectangle that holds them, in the board's coordinates. */
const SELECTED: Selection = { shapes: ['shape-1', 'shape-2'], bounds: { x: 100, y: 50, width: 460, height: 80 } };

/** Another shape, which a test selects while the box asks about `SELECTED`. */
const OTHER: Selection = { shapes: ['shape-3'], bounds: { x: 600, y: 400, width: 50, height: 50 } };

/** A stand-in for Excalidraw's canvas, whose view, selection and context menu each test sets. */
function canvasOf(view: CanvasView, selected: Selection | null) {
  let current = view;
  let selection = selected;
  let menu: HTMLElement | null = null;
  const handlers = new Set<() => void>();
  const tell = () => {
    for (const handler of handlers) handler();
  };
  const closeMenu = vi.fn<() => void>(() => {
    menu?.remove();
    menu = null;
    tell();
  });
  const canvas: AskCanvas = {
    view: () => current,
    selection: () => selection,
    contextMenu: () => menu,
    closeMenu,
    onChange: (handler) => {
      handlers.add(handler);
      return () => {
        handlers.delete(handler);
      };
    },
  };
  return {
    canvas,
    closeMenu,
    handlers,
    /** Sets the canvas's view, as a scroll or a zoom does, and tells each handler. */
    move(next: CanvasView) {
      current = next;
      tell();
    },
    /** Sets the canvas's selection, as a click or a drag over shapes does, and tells each handler. */
    select(next: Selection | null) {
      selection = next;
      tell();
    },
    /** Opens the canvas's context menu with one entry of its own, as a right click does, and tells each handler. */
    openMenu(): HTMLElement {
      const opened = document.createElement('ul');
      opened.className = 'context-menu';
      const copy = document.createElement('li');
      copy.textContent = 'Copy';
      opened.append(copy);
      document.body.append(opened);
      menu = opened;
      tell();
      return opened;
    },
  };
}

/** A stand-in for the board's room, where an agent's helper is or isn't. */
function roomOf(here: boolean) {
  let agent = here;
  const handlers = new Set<() => void>();
  const room: AskRoom = {
    agentHere: () => agent,
    onChange: (handler) => {
      handlers.add(handler);
      return () => {
        handlers.delete(handler);
      };
    },
  };
  return {
    room,
    /** Sets whether an agent's helper is on the board, as its joining or its leaving does, and tells each handler. */
    agentIs(next: boolean) {
      agent = next;
      for (const handler of handlers) handler();
    },
  };
}

interface PageOptions {
  view?: CanvasView;
  selection?: Selection | null;
  agent?: boolean;
}

function page({ view = PLAIN, selection = SELECTED, agent = true }: PageOptions = {}) {
  const layer = document.createElement('div');
  document.body.replaceChildren(layer);
  const map = feedbackOf(new Y.Doc());
  const fake = canvasOf(view, selection);
  const presence = roomOf(agent);
  let made = 0;
  const bound = bindAsk({ layer }, map, fake.canvas, presence.room, {
    writer: () => 'Ada',
    newId: () => `ask-${(made += 1)}`,
    now: () => new Date(AT),
  });
  return { layer, map, ...fake, ...presence, ...bound };
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

const opener = (layer: Element) => part(layer, 'button.ask-button') as HTMLButtonElement;
const box = (layer: Element) => part(layer, '.ask-box');
const field = (layer: Element) => part(layer, `textarea[aria-label="${ASK_LABEL}"]`) as HTMLTextAreaElement;

const key = (target: EventTarget, init: KeyboardEventInit) =>
  target.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));

/** The ask the tests expect for `SELECTED`, with `text`. */
const ask = (id: string, text: string, selection: Selection = SELECTED) => ({
  id,
  by: 'Ada',
  at: AT,
  text,
  region: selection.bounds,
  shapes: selection.shapes,
  status: 'open',
  answer: null,
  kind: 'ask',
});

describe('the Ask an agent button', () => {
  it('shows under the selected shapes while an agent is on the board', () => {
    const { layer } = page();
    const shown = opener(layer);
    expect(shown.hidden).toBe(false);
    expect(shown.textContent).toBe(ASK_LABEL);
    // The selection's bottom left corner is at (100, 130), and the button sits 12 pixels under it.
    expect({ left: shown.style.left, top: shown.style.top }).toEqual({ left: '100px', top: '142px' });
    expect(box(layer).hidden).toBe(true);
  });

  it("follows the canvas's scroll and zoom", () => {
    const { layer, move } = page({ view: MOVED });
    // (100 - 40) * 2 + 10 = 130, and (130 + 20) * 2 + 5 + 12 = 317.
    expect({ left: opener(layer).style.left, top: opener(layer).style.top }).toEqual({ left: '130px', top: '317px' });
    move(PLAIN);
    expect({ left: opener(layer).style.left, top: opener(layer).style.top }).toEqual({ left: '100px', top: '142px' });
  });

  it("hides while the person hasn't selected any shapes, and while no agent is on the board", () => {
    const { layer, select, agentIs } = page({ selection: null });
    expect(opener(layer).hidden).toBe(true);
    select(SELECTED);
    expect(opener(layer).hidden).toBe(false);
    agentIs(false);
    expect(opener(layer).hidden).toBe(true);
    agentIs(true);
    expect(opener(layer).hidden).toBe(false);
    select(null);
    expect(opener(layer).hidden).toBe(true);
  });

  it('hides while the box is open, and shows again once it closes', () => {
    const { layer } = page();
    opener(layer).click();
    expect(box(layer).hidden).toBe(false);
    expect(opener(layer).hidden).toBe(true);
    button(box(layer), 'Cancel').click();
    expect(box(layer).hidden).toBe(true);
    expect(opener(layer).hidden).toBe(false);
  });
});

describe('an ask', () => {
  it('goes to the board as a record of kind "ask" with the selected shapes and the rectangle that holds them', () => {
    const { layer, map } = page();
    opener(layer).click();
    expect(document.activeElement).toBe(field(layer));
    field(layer).value = '  Line these up  ';
    button(box(layer), 'Send').click();
    expect(listFeedback(map)).toEqual([ask('ask-1', 'Line these up')]);
    expect(feedbackKind(listFeedback(map)[0])).toBe('ask');
    expect(box(layer).hidden).toBe(true);
    expect(field(layer).value).toBe('');
  });

  it("puts the box beside the selection, with the selection's outline", () => {
    const { layer } = page({ view: MOVED });
    opener(layer).click();
    // The selection's top left corner is at (130, 145) on the window, and it is 920 pixels wide there, so
    // the box goes 8 pixels to its right, at 130 + 920 + 8 = 1058.
    expect({ left: box(layer).style.left, top: box(layer).style.top }).toEqual({ left: '1058px', top: '145px' });
    const outline = part(layer, '.ask-draft');
    expect(outline.hidden).toBe(false);
    expect({
      left: outline.style.left,
      top: outline.style.top,
      width: outline.style.width,
      height: outline.style.height,
    }).toEqual({ left: '130px', top: '145px', width: '920px', height: '160px' });
  });

  it('sends a quick ask with one click', () => {
    const { layer, map } = page();
    opener(layer).click();
    expect([...part(layer, '.ask-choices').querySelectorAll('button')].map((choice) => choice.textContent)).toEqual([
      ...QUICK_ASKS,
    ]);
    button(box(layer), 'Tidy this up').click();
    expect(listFeedback(map)).toEqual([ask('ask-1', 'Tidy this up')]);
    expect(box(layer).hidden).toBe(true);
  });

  it('asks about the shapes selected when the box opened', () => {
    const { layer, map, select } = page();
    opener(layer).click();
    select(OTHER);
    button(box(layer), 'Explain this').click();
    expect(listFeedback(map)).toEqual([ask('ask-1', 'Explain this')]);
  });

  it('sends on Enter, and leaves Shift+Enter to the field', () => {
    const { layer, map } = page();
    opener(layer).click();
    field(layer).value = 'Make these the same size';
    expect(key(field(layer), { key: 'Enter', shiftKey: true })).toBe(true);
    expect(listFeedback(map)).toEqual([]);
    expect(key(field(layer), { key: 'Enter' })).toBe(false);
    expect(listFeedback(map)).toEqual([ask('ask-1', 'Make these the same size')]);
  });

  it("doesn't write anything on Cancel, on Escape, or on a Send of a blank ask", () => {
    const { layer, map } = page();
    // Escape while the box is closed goes on to the canvas.
    expect(key(document, { key: 'Escape' })).toBe(true);
    opener(layer).click();
    field(layer).value = 'Not this';
    button(box(layer), 'Cancel').click();
    expect(box(layer).hidden).toBe(true);
    opener(layer).click();
    expect(field(layer).value).toBe('');
    expect(key(document, { key: 'Escape' })).toBe(false);
    expect(box(layer).hidden).toBe(true);
    opener(layer).click();
    field(layer).value = '   ';
    button(box(layer), 'Send').click();
    expect(box(layer).hidden).toBe(false);
    expect(listFeedback(map)).toEqual([]);
  });

  it("can't be sent while no agent is on the board, and can once one joins", () => {
    const { layer, map, agentIs } = page();
    opener(layer).click();
    expect(part(layer, '.ask-note').hidden).toBe(true);
    agentIs(false);
    expect(part(layer, '.ask-note').hidden).toBe(false);
    expect(button(box(layer), 'Send').disabled).toBe(true);
    for (const text of QUICK_ASKS) expect(button(box(layer), text).disabled).toBe(true);
    field(layer).value = 'Group these';
    key(field(layer), { key: 'Enter' });
    expect(listFeedback(map)).toEqual([]);
    expect(box(layer).hidden).toBe(false);
    agentIs(true);
    expect(part(layer, '.ask-note').hidden).toBe(true);
    expect(button(box(layer), 'Send').disabled).toBe(false);
    button(box(layer), 'Send').click();
    expect(listFeedback(map)).toEqual([ask('ask-1', 'Group these')]);
  });
});

describe("the canvas's context menu", () => {
  const entries = (menu: Element) => [...menu.children].map((child) => `${child.tagName.toLowerCase()} ${child.textContent ?? ''}`);

  it('holds Ask an agent at its top, which closes the menu and opens the box', () => {
    const { layer, openMenu, closeMenu } = page();
    const menu = openMenu();
    expect(entries(menu)).toEqual([`li ${ASK_LABEL}`, 'hr ', 'li Copy']);
    expect(menu.querySelector('.ask-menu-item .context-menu-item__label')?.textContent).toBe(ASK_LABEL);
    button(menu, ASK_LABEL).click();
    expect(closeMenu).toHaveBeenCalledTimes(1);
    expect(box(layer).hidden).toBe(false);
  });

  it("holds the entry once, however often the canvas changes while it's open", () => {
    const { openMenu, move } = page();
    const menu = openMenu();
    move(MOVED);
    move(PLAIN);
    expect(entries(menu)).toEqual([`li ${ASK_LABEL}`, 'hr ', 'li Copy']);
  });

  it("doesn't hold the entry while the person hasn't selected any shapes, or while no agent is on the board", () => {
    const unselected = page({ selection: null });
    expect(entries(unselected.openMenu())).toEqual(['li Copy']);
    const alone = page({ agent: false });
    expect(entries(alone.openMenu())).toEqual(['li Copy']);
    const left = page();
    const menu = left.openMenu();
    left.agentIs(false);
    expect(entries(menu)).toEqual(['li Copy']);
  });

  it('takes the entry out, and stops following the canvas and the room, on stop', () => {
    const { layer, openMenu, handlers, stop, agentIs } = page();
    const menu = openMenu();
    stop();
    expect(entries(menu)).toEqual(['li Copy']);
    expect(handlers.size).toBe(0);
    agentIs(false);
    agentIs(true);
    expect(entries(menu)).toEqual(['li Copy']);
    expect(key(document, { key: 'Escape' })).toBe(true);
    expect(box(layer).hidden).toBe(true);
  });
});
