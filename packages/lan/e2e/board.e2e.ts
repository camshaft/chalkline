// The end-to-end test of designs/chalkline A10: one machine serves the built page and the relay,
// as chalkline-lan does, Playwright opens the board in two browser contexts, and the built
// chalkline-mcp, the agent's helper, joins the same board from its link through the same relay.
// The helper adds a labelled rectangle and a labelled ellipse and connects them with a labelled
// arrow, and the test waits until both browsers show each of them. A second test has one browser
// write a feedback over a rectangle the helper added (A13): the helper reads it, moves the
// rectangle and answers it, and the test waits until both browsers show the answer in the chat,
// the area's outline gone and the rectangle in its new place. A third test has one browser select
// two rectangles the helper added and ask an agent about them from the canvas's context menu: the
// helper reads the ask, of kind "ask", with both rectangles and the rectangle that holds them, and
// answers it. A fourth test has the helper add two drawings, each in a frame of its own name, and
// chooses the second in the page's frames list, which shows that frame whole at the canvas's center.
// A fifth test opens the board in a desktop's window and in a phone's, 390 px wide, checks that the
// page's controls sit in Excalidraw's own UI over a canvas that fills the window, uses each of them
// there, and keeps a screenshot of each layout; on the desktop it also presses the pen's side button.
// It needs the page and the helper that `npm run build` writes, and `npm run test:e2e` runs it.
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
import { ASK_LABEL, QUICK_ASKS } from '../../web/src/ask';
import { DRAWING_SPACE_KEY } from '../../web/src/drawing-space';
import { SIDE_BUTTON_KEY } from '../../web/src/pen';
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
/** The name the feedback test's writer enters in the name field, which the feedback records as its writer. */
const WRITER = 'Grace';
/** The feedback the writer sends over the helper's rectangle. */
const FEEDBACK = 'Move this box further down';
/** The rectangle's new top edge, in the board's units, where the helper moves it for the feedback. */
const MOVED_Y = 300;
/** The helper's answer to the feedback. */
const ANSWER = 'Moved the box down to y 300';
/** The quick ask the ask test sends about the two rectangles it selects. */
const [ASK] = QUICK_ASKS;
/** The helper's answer to the ask. */
const ASK_ANSWER = 'Lined up both boxes';
/** The names of the frames the frames test's helper puts its two drawings into, in the order it adds them. */
const FRAMES = ['First drawing', 'Second drawing'];
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

/** A feedback as read_feedback and answer_feedback answer it. */
interface FeedbackRecord {
  id: string;
  by: string;
  text: string;
  region: { x: number; y: number; width: number; height: number };
  shapes: string[];
  status: string;
  answer: { by: string; text: string } | null;
  /** "feedback", or "ask" for an ask that a person sent with Ask an agent. */
  kind: string;
}

/** A feedback as a browser shows it, as page.js reads it from the chat, the canvas's outlines and the scene. */
interface ShownFeedback {
  status: string | null;
  /** The feedback's text in the chat. */
  text: string | null;
  /** The answer the chat shows under the feedback: its writer, its tag and its text. */
  answer: { by: string | null; tag: string | null; text: string | null } | null;
  /** Whether the chat shows Reopen beside the feedback. */
  reopen: boolean;
  /** Whether the canvas outlines the feedback's area. */
  outlined: boolean;
  /** The top edge of the feedback's shape in the scene. */
  y: number | null;
}

/** The parts of the page's handle that the layout and feedback tests read. */
interface Handle {
  room: string;
  awareness: { getLocalState(): Record<string, unknown> | null };
  api: {
    getAppState(): {
      viewBackgroundColor: string;
      gridModeEnabled: boolean;
      activeTool: { type: string };
      scrollX: number;
      scrollY: number;
      zoom: { value: number };
      offsetLeft: number;
      offsetTop: number;
      width: number;
      height: number;
      selectedElementIds: Record<string, boolean>;
    };
    updateScene(scene: { appState: Record<string, unknown> }): void;
  };
}

/** What the page and page.js put on `window`. */
interface E2eWindow {
  chalklineReady?: Promise<Handle>;
  chalkline?: Handle;
  chalklineE2e: {
    shown(expected: Expected[], creator: string, waitMs: number): Promise<Shown[]>;
    answered(id: string, shapeId: string, y: number, waitMs: number): Promise<ShownFeedback>;
    picture(id: string, fileId: string, waitMs: number): Promise<ShownPicture>;
  };
}

/** An image as a page shows it: its type, its fileId, its file's MIME type, and the canvas's pixel at its center. */
interface ShownPicture {
  id: string;
  type: string | null;
  fileId: string | null;
  mimeType: string | null;
  color: number[] | null;
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

/**
 * Presses and releases the pen's side button at (`x`, `y`) on `page`. Playwright's mouse is a mouse, so the press
 * goes through Chromium's DevTools protocol, which sends it as a pen's secondary button.
 */
async function pressSideButton(page: Page, x: number, y: number): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  try {
    for (const type of ['mousePressed', 'mouseReleased'] as const) {
      await cdp.send('Input.dispatchMouseEvent', {
        type,
        x,
        y,
        button: 'right',
        buttons: type === 'mousePressed' ? 2 : 0,
        clickCount: 1,
        pointerType: 'pen',
      });
    }
  } finally {
    await cdp.detach();
  }
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

/** Waits until the page of `board` shows the feedback `id` answered, with `shapeId` at `y`, and keeps a screenshot either way. */
async function answeredIn(board: Board, id: string, shapeId: string, y: number): Promise<ShownFeedback> {
  try {
    const shown = await board.page.evaluate(
      (arg) => (window as unknown as E2eWindow).chalklineE2e.answered(arg.id, arg.shapeId, arg.y, arg.waitMs),
      { id, shapeId, y, waitMs: WAIT_MS },
    );
    console.log(`${board.name}: the board shows the feedback as ${JSON.stringify(shown)}`);
    return shown;
  } finally {
    await board.page.screenshot({ path: join(SCREENSHOTS, `e2e-${board.name}.png`) }).catch(() => undefined);
  }
}

/** Waits until the page of `board` shows the image `id` of the file `fileId`, drawn red on its canvas, and keeps a screenshot either way. */
async function pictureIn(board: Board, id: string, fileId: string): Promise<ShownPicture> {
  try {
    const shown = await board.page.evaluate(
      (arg) => (window as unknown as E2eWindow).chalklineE2e.picture(arg.id, arg.fileId, arg.waitMs),
      { id, fileId, waitMs: WAIT_MS },
    );
    console.log(`${board.name}: the board shows the picture as ${JSON.stringify(shown)}`);
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

  it('shows in a browser the picture that the helper places with add_image', async () => {
    const lan = server;
    const chrome = browser;
    if (lan === undefined || chrome === undefined) throw new Error('the server or the browser did not start');
    const link = boardLink(lan.port);
    const board = await openBoard(chrome, link, 'picture');
    const helper = new Client({ name: CLIENT, version: '0.0.0' });
    try {
      await helper.connect(new StdioClientTransport({ command: process.execPath, args: [HELPER, link.href] }));
      const svg =
        '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="60"><rect width="120" height="60" fill="#ff0000"/></svg>';
      const added = await call(helper, 'add_image', {
        data_url: `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`,
        x: 100,
        y: 100,
        width: 120,
      });
      expect(added).toMatchObject({ width: 120, height: 60 });
      const shown = await pictureIn(board, added.id as string, added.file as string);
      expect(shown).toMatchObject({ id: added.id, type: 'image', fileId: added.file, mimeType: 'image/svg+xml' });
    } finally {
      await helper.close();
      await board.page.context().close();
    }
  }, 180_000);

  it("shows in both browsers the helper's answer to a feedback that one browser wrote over a shape", async () => {
    const lan = server;
    const chrome = browser;
    if (lan === undefined || chrome === undefined) throw new Error('the server or the browser did not start');
    const link = boardLink(lan.port);
    const [writer, reader] = await Promise.all(['feedback-writer', 'feedback-reader'].map((name) => openBoard(chrome, link, name)));
    const helper = new Client({ name: CLIENT, version: '0.0.0' });
    try {
      await helper.connect(new StdioClientTransport({ command: process.execPath, args: [HELPER, link.href] }));
      const added = await call(helper, 'add_shapes', {
        shapes: [{ type: 'rectangle', x: 100, y: 100, width: 240, height: 80, label: { text: 'Move me down' } }],
      });
      const [shape] = added.ids as string[];
      const expected: Expected[] = [{ id: shape, type: 'rectangle', label: 'Move me down' }];
      await Promise.all([writer, reader].map((board) => shownIn(board, expected)));

      // The name field sets the name that the feedback records as its writer.
      const { page } = writer;
      await page.locator('#name').fill(WRITER);
      await page.waitForFunction(
        (name) => (window as unknown as E2eWindow).chalkline?.awareness.getLocalState()?.name === name,
        WRITER,
      );

      // The Feedback button puts the canvas in feedback mode, where a drag over the rectangle marks an area.
      const button = page.locator('#feedback-button');
      await button.click();
      expect(await button.getAttribute('aria-pressed')).toBe('true');
      const view = await page.evaluate(() => {
        const state = (window as unknown as E2eWindow).chalkline?.api.getAppState();
        if (state === undefined) throw new Error("the page doesn't show a board");
        return {
          scrollX: state.scrollX,
          scrollY: state.scrollY,
          zoom: state.zoom.value,
          left: state.offsetLeft,
          top: state.offsetTop,
        };
      });
      // The window's point of a point of the board, rounded to whole pixels, and the board's point of a
      // window's point, as the page reads it from the pointer.
      const onWindow = (x: number, y: number) => ({
        x: Math.round((x + view.scrollX) * view.zoom + view.left),
        y: Math.round((y + view.scrollY) * view.zoom + view.top),
      });
      const onBoard = ({ x, y }: { x: number; y: number }) => ({
        x: (x - view.left) / view.zoom - view.scrollX,
        y: (y - view.top) / view.zoom - view.scrollY,
      });
      const from = onWindow(120, 110);
      const to = onWindow(320, 170);
      await page.mouse.move(from.x, from.y);
      await page.mouse.down();
      await page.mouse.move(to.x, to.y, { steps: 5 });
      await page.mouse.up();

      // Send in the text box beside the area writes the feedback to the board, and ends the mode.
      const dialog = page.locator('.feedback-box');
      await dialog.locator('.feedback-field').fill(FEEDBACK);
      await dialog.getByRole('button', { name: 'Send', exact: true }).click();
      expect(await button.getAttribute('aria-pressed')).toBe('false');

      // The helper reads the feedback: its writer, its text, its area in the board's units, and the rectangle.
      const read = await call(helper, 'read_feedback', {});
      expect(read.cursor).toBe(1);
      const opened = read.opened as { feedback: FeedbackRecord; shapes: { id: string }[] }[];
      expect(opened).toHaveLength(1);
      const [{ feedback, shapes }] = opened;
      expect(feedback).toMatchObject({ by: WRITER, text: FEEDBACK, status: 'open', answer: null, kind: 'feedback' });
      expect(feedback.shapes).toContain(shape);
      expect(shapes.map(({ id }) => id)).toContain(shape);
      const corner = onBoard(from);
      const far = onBoard(to);
      expect(feedback.region.x).toBeCloseTo(corner.x, 1);
      expect(feedback.region.y).toBeCloseTo(corner.y, 1);
      expect(feedback.region.width).toBeCloseTo(far.x - corner.x, 1);
      expect(feedback.region.height).toBeCloseTo(far.y - corner.y, 1);

      // The helper moves the rectangle down and answers the feedback with what it changed.
      await call(helper, 'update_shape', { id: shape, y: MOVED_Y });
      const answered = await call(helper, 'answer_feedback', { id: feedback.id, text: ANSWER });
      expect((answered.feedback as FeedbackRecord).status).toBe('answered');

      // Both browsers show the answer under the feedback in the chat, with Reopen, with the area's outline
      // gone and with the rectangle in its new place.
      const wanted: ShownFeedback = {
        status: 'answered',
        text: FEEDBACK,
        answer: { by: CLIENT, tag: 'Answer', text: ANSWER },
        reopen: true,
        outlined: false,
        y: MOVED_Y,
      };
      const shown = await Promise.all([writer, reader].map((board) => answeredIn(board, feedback.id, shape, MOVED_Y)));
      for (const state of shown) expect(state).toEqual(wanted);
    } finally {
      await helper.close();
      await Promise.all([writer, reader].map((board) => board.page.context().close()));
    }
  }, 300_000);

  it("sends the helper an ask about two shapes that a browser selected, from the canvas's context menu", async () => {
    const lan = server;
    const chrome = browser;
    if (lan === undefined || chrome === undefined) throw new Error('the server or the browser did not start');
    const link = boardLink(lan.port);
    const board = await openBoard(chrome, link, 'asker');
    const helper = new Client({ name: CLIENT, version: '0.0.0' });
    try {
      await helper.connect(new StdioClientTransport({ command: process.execPath, args: [HELPER, link.href] }));
      const added = await call(helper, 'add_shapes', {
        shapes: [
          { type: 'rectangle', x: 100, y: 300, width: 160, height: 80, label: { text: 'First' } },
          { type: 'rectangle', x: 400, y: 300, width: 160, height: 80, label: { text: 'Second' } },
        ],
      });
      const ids = added.ids as string[];
      const [first, second] = ids;
      await shownIn(board, [
        { id: first, type: 'rectangle', label: 'First' },
        { id: second, type: 'rectangle', label: 'Second' },
      ]);

      // The name field sets the name that the ask records as its writer.
      const { page } = board;
      await page.locator('#name').fill(WRITER);
      await page.waitForFunction(
        (name) => (window as unknown as E2eWindow).chalkline?.awareness.getLocalState()?.name === name,
        WRITER,
      );
      const view = await page.evaluate(() => {
        const state = (window as unknown as E2eWindow).chalkline?.api.getAppState();
        if (state === undefined) throw new Error("the page doesn't show a board");
        return { scrollX: state.scrollX, scrollY: state.scrollY, zoom: state.zoom.value, left: state.offsetLeft, top: state.offsetTop };
      });
      // The window's point of a point of the board, rounded to whole pixels.
      const onWindow = (x: number, y: number) => ({
        x: Math.round((x + view.scrollX) * view.zoom + view.left),
        y: Math.round((y + view.scrollY) * view.zoom + view.top),
      });

      // A drag over the empty canvas around both rectangles selects them, as Excalidraw's selection tool does.
      const from = onWindow(60, 260);
      const to = onWindow(600, 420);
      await page.mouse.move(from.x, from.y);
      await page.mouse.down();
      await page.mouse.move(to.x, to.y, { steps: 10 });
      await page.mouse.up();
      await page.waitForFunction((wanted) => {
        const selected = (window as unknown as E2eWindow).chalkline?.api.getAppState().selectedElementIds ?? {};
        return wanted.every((id) => selected[id] === true);
      }, ids);

      // With the helper on the board, Ask an agent shows under the selection.
      await page.locator('.ask-button').waitFor({ state: 'visible' });

      // A right click inside the selection opens the canvas's context menu, whose first entry is Ask an
      // agent, which opens the box beside the selection; a quick ask there sends at once.
      const inside = onWindow(330, 340);
      await page.mouse.click(inside.x, inside.y, { button: 'right' });
      await page.locator('.context-menu').getByRole('button', { name: ASK_LABEL, exact: true }).click();
      const dialog = page.locator('.ask-box');
      await dialog.getByRole('button', { name: ASK, exact: true }).click();
      await dialog.waitFor({ state: 'hidden' });

      // The helper reads the ask: its kind, its writer, its text, both rectangles, and the rectangle that holds them.
      const read = await call(helper, 'read_feedback', {});
      const opened = read.opened as { feedback: FeedbackRecord; shapes: { id: string }[] }[];
      expect(opened).toHaveLength(1);
      const [{ feedback, shapes }] = opened;
      expect(feedback).toMatchObject({ kind: 'ask', by: WRITER, text: ASK, status: 'open', answer: null });
      expect([...feedback.shapes].sort()).toEqual([...ids].sort());
      expect(shapes.map(({ id }) => id)).toEqual(expect.arrayContaining(ids));
      expect(feedback.region.x).toBeCloseTo(100, 0);
      expect(feedback.region.y).toBeCloseTo(300, 0);
      expect(feedback.region.width).toBeCloseTo(460, 0);
      expect(feedback.region.height).toBeCloseTo(80, 0);

      // The helper answers the ask, which keeps its kind.
      const answered = await call(helper, 'answer_feedback', { id: feedback.id, text: ASK_ANSWER });
      expect(answered.feedback).toMatchObject({ kind: 'ask', status: 'answered', answer: { text: ASK_ANSWER } });
    } finally {
      await helper.close();
      await board.page.context().close();
    }
  }, 300_000);

  it("shows the second of two drawings that the helper put in named frames, when the page's frames list chooses it", async () => {
    const lan = server;
    const chrome = browser;
    if (lan === undefined || chrome === undefined) throw new Error('the server or the browser did not start');
    const link = boardLink(lan.port);
    const { page } = await openBoard(chrome, link, 'frames');
    const helper = new Client({ name: CLIENT, version: '0.0.0' });
    try {
      await helper.connect(new StdioClientTransport({ command: process.execPath, args: [HELPER, link.href] }));
      // Two drawings far apart, each in a frame of its own name.
      await call(helper, 'add_shapes', {
        shapes: [{ type: 'rectangle', x: 0, y: 0, width: 240, height: 120, label: { text: 'One' } }],
        frame: { name: FRAMES[0] },
      });
      const second = await call(helper, 'add_shapes', {
        shapes: [
          { type: 'ellipse', x: 3000, y: 2000, width: 300, height: 200, label: { text: 'Two' } },
          { type: 'rectangle', x: 3400, y: 2100, width: 200, height: 100 },
        ],
        frame: { name: FRAMES[1] },
      });
      const frames = (await call(helper, 'get_board', {})).frames as { id: string; name?: string; x: number; y: number; width: number; height: number }[];
      expect(frames.map(({ name }) => name)).toEqual(FRAMES);
      const target = frames[1];
      expect(target.id).toBe(second.frame);

      // The frames list holds both frames' names, in the board's order, once the page holds both frames.
      await page.waitForFunction(
        (names) => {
          const select = document.querySelector<HTMLSelectElement>('#frames-list');
          if (select === null || select.hidden) return false;
          const listed = Array.from(select.options, (option) => option.textContent).slice(1);
          return JSON.stringify(listed) === JSON.stringify(names);
        },
        FRAMES,
        { timeout: WAIT_MS },
      );
      expect(await page.locator('#frames-list').isVisible()).toBe(true);
      await page.selectOption('#frames-list', { label: FRAMES[1] });

      // The canvas then shows the second frame whole, at its center, and the list goes back to its prompt.
      const view = await page.evaluate(() => {
        const state = (window as unknown as E2eWindow).chalkline?.api.getAppState();
        if (state === undefined) throw new Error("the page doesn't show a board");
        return { scrollX: state.scrollX, scrollY: state.scrollY, zoom: state.zoom.value, width: state.width, height: state.height };
      });
      expect(view.width / 2 / view.zoom - view.scrollX).toBeCloseTo(target.x + target.width / 2, -1);
      expect(view.height / 2 / view.zoom - view.scrollY).toBeCloseTo(target.y + target.height / 2, -1);
      expect(target.width * view.zoom).toBeLessThanOrEqual(view.width);
      expect(target.height * view.zoom).toBeLessThanOrEqual(view.height);
      expect(await page.locator('#frames-list').inputValue()).toBe('');
    } finally {
      await helper.close();
      await page.context().close();
    }
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

        // A press of the pen's side button switches tools in place of opening Excalidraw's menu, as the main
        // menu's Pen side button items choose, and the choice stays with this browser across visits.
        const toolIs = (type: string) =>
          page.waitForFunction(
            (expected) => (window as unknown as E2eWindow).chalkline?.api.getAppState().activeTool.type === expected,
            type,
          );
        await pressSideButton(page, 600, 450);
        await toolIs('freedraw');
        await pressSideButton(page, 600, 450);
        await toolIs('selection');
        expect(await page.locator('.context-menu').count()).toBe(0);
        // A mouse's right click still opens Excalidraw's menu, and a click elsewhere closes it.
        await page.mouse.click(600, 450, { button: 'right' });
        await page.locator('.context-menu').waitFor();
        await page.mouse.click(300, 650);
        await page.locator('.context-menu').waitFor({ state: 'hidden' });
        await menuItem(page, 'Toggle the eraser');
        await pressSideButton(page, 600, 450);
        await toolIs('eraser');
        await page.waitForFunction((key) => window.localStorage.getItem(key) === 'eraser', SIDE_BUTTON_KEY);
        await page.reload();
        await ready(page);
        await pressSideButton(page, 600, 450);
        await toolIs('eraser');
        await pressSideButton(page, 600, 450);
        await toolIs('selection');
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
