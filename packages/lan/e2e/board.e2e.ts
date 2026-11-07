// The end-to-end test of designs/chalkline A10: one machine serves the built page and the relay,
// as chalkline-lan does, Playwright opens the board in two browser contexts, and the built
// chalkline-mcp, the agent's helper, joins the same board from its link through the same relay.
// The helper adds a labelled rectangle and a labelled ellipse and connects them with a labelled
// arrow, and the test waits until both browsers show each of them. A second test opens the board
// in a desktop's window and in a phone's, 390 px wide, checks that the page's controls sit in
// Excalidraw's own UI over a canvas that fills the window, uses each of them there, and keeps a
// screenshot of each layout. It needs the page and the helper that `npm run build` writes, and
// `npm run test:e2e` runs it.
import { randomBytes } from 'node:crypto';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RELAY_PARAM, relaysFromAddress } from '@chalkline/sync/relay';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DRAWING_SPACE_KEY } from '../../web/src/drawing-space';
import { RELAY_PATH, startLanServer, type LanServer } from '../src/server';

/** The built page, which `npm run build --workspace @chalkline/web` writes. */
const ROOT = fileURLToPath(new URL('../../web/dist/', import.meta.url));
/** The built helper, which `npm run build --workspace @chalkline/mcp` writes. */
const HELPER = fileURLToPath(new URL('../../mcp/dist/chalkline-mcp.mjs', import.meta.url));
/** The script each browser loads before the page's own, which waits for the helper's shapes. */
const PAGE_SCRIPT = fileURLToPath(new URL('./page.js', import.meta.url));
/** Where each browser's screenshot goes, which CI keeps as an artifact. */
const SCREENSHOTS = fileURLToPath(new URL('..', import.meta.url));
/** The name the test's MCP client connects with, which the helper records as each shape's creator. */
const CLIENT = 'chalkline-e2e';
/** How long each browser waits for the helper's shapes. */
const WAIT_MS = 120_000;
/** The board file the layout test opens with the main menu's Open file item: one rectangle. */
const OPENED_FILE = {
  type: 'excalidraw',
  version: 2,
  source: 'chalkline-e2e',
  elements: [
    { id: 'opened-box', type: 'rectangle', x: 40, y: 40, width: 160, height: 80, version: 1, versionNonce: 1 },
  ],
  appState: {},
  files: {},
};

/** A shape the helper added, as a browser should show it. */
interface Expected {
  id: string;
  type: 'rectangle' | 'ellipse' | 'arrow';
  label: string;
  /** The shape an arrow starts at. */
  start?: string;
  /** The shape an arrow ends at. */
  end?: string;
}

/** A shape as a browser shows it, as page.js reads it from the scene. */
interface Shown {
  id: string;
  type: string | null;
  label: string | null;
  creator: { kind: string; name: string } | null;
  start: string | null;
  end: string | null;
}

/** The parts of the page's handle that the layout test reads. */
interface Handle {
  room: string;
  awareness: { getLocalState(): Record<string, unknown> | null };
  api: {
    getAppState(): { viewBackgroundColor: string; gridModeEnabled: boolean };
    updateScene(scene: { appState: Record<string, unknown> }): void;
  };
}

/** What the page and page.js put on `window`. */
interface E2eWindow {
  chalklineReady?: Promise<Handle>;
  chalkline?: Handle;
  chalklineE2e: { shown(expected: Expected[], creator: string, waitMs: number): Promise<Shown[]> };
}

/** An element's place on the page, in CSS pixels. */
interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A browser context with the board open in its page. */
interface Board {
  name: string;
  page: Page;
}

/** How `openBoard` opens a board's page. */
interface OpenOptions {
  /** The window's size: 1200 by 800 where left out. */
  viewport?: { width: number; height: number };
  /** Emulates a phone, which reads the page's viewport tag and takes touches. */
  phone?: boolean;
  /** Puts a stand-in for speech recognition on the page, so that its microphone button asks where recognition runs. */
  fakeSpeech?: boolean;
}

/** A stand-in for the browser's speech recognition, which the page finds and never starts. */
function fakeSpeech(): void {
  class FakeRecognition extends EventTarget {
    lang = '';
    continuous = false;
    interimResults = false;
    start(): void {}
    stop(): void {}
    abort(): void {}
  }
  (window as unknown as Record<string, unknown>).SpeechRecognition = FakeRecognition;
}

/** Resolves once the page's board has started. */
async function ready(page: Page): Promise<void> {
  await page.waitForFunction(() => (window as unknown as E2eWindow).chalklineReady !== undefined);
  await page.evaluate(async () => {
    await (window as unknown as E2eWindow).chalklineReady;
  });
}

/** Opens `link` in a new context of `browser`, and resolves once the page's board has started. */
async function openBoard(browser: Browser, link: URL, name: string, options: OpenOptions = {}): Promise<Board> {
  const phone = options.phone ?? false;
  const context = await browser.newContext({
    viewport: options.viewport ?? { width: 1200, height: 800 },
    isMobile: phone,
    hasTouch: phone,
  });
  await context.addInitScript({ path: PAGE_SCRIPT });
  if (options.fakeSpeech === true) await context.addInitScript(fakeSpeech);
  const page = await context.newPage();
  page.on('console', (message) => console.log(`[${name} console.${message.type()}] ${message.text()}`));
  page.on('pageerror', (error) => console.log(`[${name} page error] ${error.message}`));
  await page.goto(link.href);
  await ready(page);
  return { name, page };
}

/** A new board's link on `port`, whose relay is the machine's own. */
function boardLink(port: number): URL {
  const link = new URL(`http://127.0.0.1:${port}/`);
  link.searchParams.set(RELAY_PARAM, RELAY_PATH);
  link.hash = `room=e2e-${randomBytes(8).toString('hex')}&key=${randomBytes(16).toString('hex')}`;
  return link;
}

/** The place of the first visible element `selector` finds on `page`, rounded to whole pixels. */
async function box(page: Page, selector: string): Promise<Box> {
  const found = await page.locator(`${selector} >> visible=true`).first().boundingBox();
  if (found === null) throw new Error(`the page doesn't show ${selector}`);
  return {
    x: Math.round(found.x),
    y: Math.round(found.y),
    width: Math.round(found.width),
    height: Math.round(found.height),
  };
}

/** Whether two boxes share any pixel. */
const overlap = (a: Box, b: Box) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

/** Whether `inner` lies within a window of `width` by `height`. */
const inside = (inner: Box, width: number, height: number) =>
  inner.x >= 0 && inner.y >= 0 && inner.x + inner.width <= width && inner.y + inner.height <= height;

/** Opens Excalidraw's main menu, where it isn't open already. */
async function openMenu(page: Page): Promise<void> {
  const menu = page.locator('.dropdown-menu >> visible=true');
  if ((await menu.count()) > 0) return;
  await page.locator('[data-testid="main-menu-trigger"] >> visible=true').first().click();
  await menu.first().waitFor();
}

/** Chooses the item `name` of Excalidraw's main menu. */
async function menuItem(page: Page, name: string): Promise<void> {
  await openMenu(page);
  await page.getByRole('button', { name, exact: true }).click();
}

/** Waits until the page of `board` shows each of `expected`, and keeps a screenshot of the page either way. */
async function shownIn(board: Board, expected: Expected[]): Promise<Shown[]> {
  try {
    const shown = await board.page.evaluate(
      (arg) => (window as unknown as E2eWindow).chalklineE2e.shown(arg.expected, arg.creator, arg.waitMs),
      { expected, creator: CLIENT, waitMs: WAIT_MS },
    );
    console.log(`${board.name}: the board shows ${JSON.stringify(shown)}`);
    return shown;
  } finally {
    await board.page.screenshot({ path: join(SCREENSHOTS, `e2e-${board.name}.png`) }).catch(() => undefined);
  }
}

/** Calls one of the helper's tools, checks that it didn't refuse the call, and returns its structured answer. */
async function call(client: Client, name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const result = (await client.callTool({ name, arguments: args })) as CallToolResult;
  expect(result.isError, `${name}: ${JSON.stringify(result.content)}`).not.toBe(true);
  return result.structuredContent ?? {};
}

describe('the local-network mode, end to end', () => {
  let server: LanServer | undefined;
  let browser: Browser | undefined;
  let client: Client | undefined;

  beforeAll(async () => {
    // The page and the helper come from the build, which CI runs before this test.
    await access(join(ROOT, 'index.html'));
    await access(HELPER);
    server = await startLanServer({ root: ROOT, port: 0, host: '127.0.0.1' });
    browser = await chromium.launch();
  }, 60_000);

  afterAll(async () => {
    await client?.close();
    await browser?.close();
    await server?.close();
  }, 60_000);

  it("shows the helper's labelled shapes and arrow in two browsers that meet through the machine's relay", async () => {
    const lan = server;
    const chrome = browser;
    if (lan === undefined || chrome === undefined) throw new Error('the server or the browser did not start');
    const link = boardLink(lan.port);
    const relay = `ws://127.0.0.1:${lan.port}${RELAY_PATH}`;
    expect(relaysFromAddress(link)).toEqual([relay]);

    // Two contexts of one browser are two participants, each with its own storage and peer id.
    const boards = await Promise.all(['first', 'second'].map((name) => openBoard(chrome, link, name)));
    for (const { page } of boards) expect(relaysFromAddress(page.url())).toEqual([relay]);

    client = new Client({ name: CLIENT, version: '0.0.0' });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [HELPER, link.href] }));
    const added = await call(client, 'add_shapes', {
      shapes: [
        { type: 'rectangle', x: 100, y: 100, width: 240, height: 80, label: { text: 'Drawn by the helper' } },
        { type: 'ellipse', x: 500, y: 100, width: 220, height: 80, label: { text: 'Shown in both browsers' } },
      ],
    });
    const [box, next] = added.ids as string[];
    const connected = await call(client, 'connect', { start: box, end: next, label: { text: 'then' } });
    const arrow = connected.id as string;

    const expected: Expected[] = [
      { id: box, type: 'rectangle', label: 'Drawn by the helper' },
      { id: next, type: 'ellipse', label: 'Shown in both browsers' },
      { id: arrow, type: 'arrow', label: 'then', start: box, end: next },
    ];
    const wanted: Shown[] = expected.map(({ id, type, label, start, end }) => ({
      id,
      type,
      label,
      creator: { kind: 'agent', name: CLIENT },
      start: start ?? null,
      end: end ?? null,
    }));
    const shown = await Promise.all(boards.map((board) => shownIn(board, expected)));
    for (const shapes of shown) expect(shapes).toEqual(wanted);
    // The browsers and the helper met through this machine's relay, the only one their links name.
    expect(lan.relay.getSubscriberCount()).toBeGreaterThan(0);
  }, 300_000);

  it.each([
    { layout: 'desktop', viewport: { width: 1200, height: 800 }, phone: false },
    { layout: 'phone', viewport: { width: 390, height: 844 }, phone: true },
  ])("puts the page's controls in Excalidraw's own UI on a $layout, where each of them works", async ({ layout, viewport, phone }) => {
    const lan = server;
    const chrome = browser;
    if (lan === undefined || chrome === undefined) throw new Error('the server or the browser did not start');
    const { page } = await openBoard(chrome, boardLink(lan.port), layout, { viewport, phone, fakeSpeech: true });
    const { width, height } = viewport;
    const shot = (file: string) => page.screenshot({ path: join(SCREENSHOTS, file) });
    try {
      // The page doesn't show a strip above the canvas: Excalidraw's canvas fills the window.
      expect(await page.locator('#bar').count()).toBe(0);
      expect(await box(page, '.excalidraw')).toEqual({ x: 0, y: 0, width, height });
      // The controls move into Excalidraw's top-right area as it shows the board.
      await page.waitForFunction(() => document.getElementById('controls')?.closest('.excalidraw') != null);

      // The status badge shows the whole status as its title, and unfolds and folds on a click or a tap.
      await page.waitForFunction(() => {
        const badge = document.getElementById('status-badge');
        return badge !== null && badge.title !== '' && badge.title === document.getElementById('status')?.textContent;
      });
      const badge = page.locator('#status-badge');
      await badge.click();
      expect(await badge.getAttribute('aria-expanded')).toBe('true');
      await badge.click();
      expect(await badge.getAttribute('aria-expanded')).toBe('false');

      if (phone) {
        // On a phone, the controls show the status and More until a person unfolds them.
        expect(await page.locator('#name').isVisible()).toBe(false);
        await shot('e2e-phone.png');
        const more = page.locator('#controls-toggle');
        await more.click();
        expect(await more.getAttribute('aria-expanded')).toBe('true');
        expect(await page.locator('#name').isVisible()).toBe(true);
        await shot('e2e-phone-open.png');
      } else {
        expect(await page.locator('#controls-toggle').isVisible()).toBe(false);
        await shot('e2e-light.png');
      }

      // The controls lie within the window, and clear of Excalidraw's toolbar, menu and other buttons.
      const controls = await box(page, '#controls');
      expect(inside(controls, width, height), JSON.stringify(controls)).toBe(true);
      const clear = ['.App-toolbar:has([data-testid="toolbar-rectangle"])', '[data-testid="main-menu-trigger"]'];
      if (phone) clear.push('.mobile-misc-tools-container');
      for (const selector of clear) {
        expect(overlap(controls, await box(page, selector)), `the controls overlap ${selector}`).toBe(false);
      }

      // The name field shares the name the others see.
      await page.locator('#name').fill('Ada');
      await page.waitForFunction(() => (window as unknown as E2eWindow).chalkline?.awareness.getLocalState()?.name === 'Ada');

      // Where the browser can speak, the Read agent messages aloud button shows, and each click turns reading on or
      // off; where it can't, the page doesn't show the button.
      const readAloud = page.locator('#read-aloud');
      if (await page.evaluate(() => 'speechSynthesis' in window && 'SpeechSynthesisUtterance' in window)) {
        await readAloud.click();
        expect(await readAloud.getAttribute('aria-pressed')).toBe('true');
        await readAloud.click();
        expect(await readAloud.getAttribute('aria-pressed')).toBe('false');
      } else {
        expect(await readAloud.isHidden()).toBe(true);
      }

      // The microphone button asks where recognition runs, in the chat, which opens clear of the controls.
      const chat = page.locator('#transcript');
      await page.locator('#mic').click();
      await chat.getByRole('button', { name: 'Start listening', exact: true }).waitFor();
      expect(overlap(await box(page, '#transcript'), await box(page, '#controls'))).toBe(false);
      await chat.getByRole('button', { name: 'Cancel', exact: true }).click();

      // The Chat button closes and opens the chat, and its Close button closes it with one press.
      const opener = page.locator('#transcript-button');
      await opener.click();
      expect(await chat.isHidden()).toBe(true);
      await opener.click();
      expect(await chat.isVisible()).toBe(true);
      if (phone) {
        // On a phone, the chat is a sheet across the window's width, from its bottom, with its Message field in sight.
        const sheet = await box(page, '#transcript');
        expect({ x: sheet.x, width: sheet.width, bottom: sheet.y + sheet.height }).toEqual({ x: 0, width, bottom: height });
        expect(inside(await box(page, '#transcript .chat-field'), width, height)).toBe(true);
        await shot('e2e-phone-chat.png');
        // While the on-screen keyboard shows, the sheet sits above it: the test sets the keyboard's height
        // on the chat, as followKeyboard does from the visual viewport.
        const keyboard = (inset: string) =>
          page.evaluate((value) => document.getElementById('transcript')?.style.setProperty('--keyboard-inset', value), inset);
        await keyboard('300px');
        const raised = await box(page, '#transcript');
        expect(raised.y + raised.height).toBeCloseTo(height - 300, 1);
        expect(inside(await box(page, '#transcript .chat-field'), width, height - 300)).toBe(true);
        await keyboard('0px');
      }
      await chat.getByRole('button', { name: 'Close the chat', exact: true }).click();
      expect(await chat.isHidden()).toBe(true);
      expect(await opener.getAttribute('aria-expanded')).toBe('false');

      // The main menu's Connection settings item opens the settings, which Cancel closes.
      await menuItem(page, 'Connection settings');
      const settings = page.locator('#settings');
      await settings.getByRole('button', { name: 'Cancel', exact: true }).click();
      expect(await settings.isHidden()).toBe(true);

      // The main menu's Save file item downloads the board.
      const [download] = await Promise.all([page.waitForEvent('download'), menuItem(page, 'Save file')]);
      expect(download.suggestedFilename()).toMatch(/^chalkline-.+\.excalidraw$/);

      // The main menu's Open file item asks for a file, and adds its shapes to the board.
      const [chooser] = await Promise.all([page.waitForEvent('filechooser'), menuItem(page, 'Open file')]);
      await chooser.setFiles({
        name: 'opened.excalidraw',
        mimeType: 'application/json',
        buffer: Buffer.from(JSON.stringify(OPENED_FILE)),
      });
      await page.waitForFunction(
        () => document.getElementById('status')?.textContent === 'Opened opened.excalidraw: 1 shape added to the board.',
      );

      // The main menu opens within the window.
      await openMenu(page);
      expect(inside(await box(page, '.dropdown-menu'), width, height)).toBe(true);
      await shot(phone ? 'e2e-phone-menu.png' : 'e2e-menu.png');
      await page.keyboard.press('Escape');

      if (!phone) {
        // The grid and the canvas's background stay with this browser across visits, as the name does.
        await menuItem(page, 'Show grid');
        await page.waitForFunction(() => (window as unknown as E2eWindow).chalkline?.api.getAppState().gridModeEnabled === true);
        await page.evaluate(() =>
          (window as unknown as E2eWindow).chalkline?.api.updateScene({ appState: { viewBackgroundColor: '#fff9db' } }),
        );
        // updateScene returns before React applies the new background, and the page keeps the drawing space
        // only once Excalidraw reports the change, so the test waits until the browser keeps the background
        // before the reload.
        await page.waitForFunction((key) => {
          const space: unknown = JSON.parse(window.localStorage.getItem(key) ?? 'null');
          return (space as { viewBackgroundColor?: unknown } | null)?.viewBackgroundColor === '#fff9db';
        }, DRAWING_SPACE_KEY);
        await page.reload();
        await ready(page);
        const kept = await page.evaluate(() => {
          const state = (window as unknown as E2eWindow).chalkline?.api.getAppState();
          const name = (document.getElementById('name') as HTMLInputElement | null)?.value;
          return { background: state?.viewBackgroundColor, grid: state?.gridModeEnabled, name };
        });
        expect(kept).toEqual({ background: '#fff9db', grid: true, name: 'Ada' });
        await openMenu(page);
        await page.getByRole('button', { name: 'Hide grid', exact: true }).waitFor();

        // The menu's dark mode item turns the canvas and the controls dark.
        await page.getByTestId('toggle-dark-mode').click();
        await page.locator('.excalidraw.theme--dark').waitFor();
        await page.keyboard.press('Escape');
        expect(await page.locator('#controls').evaluate((controls) => getComputedStyle(controls).backgroundColor)).toBe(
          'rgb(35, 35, 41)',
        );
        await shot('e2e-dark.png');
      }

      // The main menu's New board item opens a new board, in a new room.
      const before = (await page.evaluate(() => (window as unknown as E2eWindow).chalkline?.room)) ?? '';
      await openMenu(page);
      await Promise.all([page.waitForEvent('load'), page.getByRole('button', { name: 'New board', exact: true }).click()]);
      await ready(page);
      const after = await page.evaluate(() => (window as unknown as E2eWindow).chalkline?.room);
      expect(after).toBeDefined();
      expect(after).not.toBe(before);
    } finally {
      await page.screenshot({ path: join(SCREENSHOTS, `e2e-${layout}-last.png`) }).catch(() => undefined);
      await page.context().close();
    }
  }, 180_000);
});
