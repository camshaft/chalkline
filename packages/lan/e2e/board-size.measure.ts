// The board-size measurement: one machine serves the built page and the relay, as chalkline-lan
// does, Playwright opens a board in Chromium, and the built chalkline-mcp, the agent's helper, fills
// the board through add_shapes with the kinds of shape an agent's pictures are made of: small
// rectangles, ellipses and lines. It measures a board of 100 shapes and one of 4,000, and prints for
// each how long the page takes to load the board again, to draw it
// zoomed in and zoomed out, and to show a shape that one update_shape call moves, and the shapes that
// 100 update_shape calls move one after another, as an agent's calls do. It needs the page and the
// helper that `npm run build` writes, and `npm run measure` runs it.
import { randomBytes } from 'node:crypto';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RELAY_PARAM } from '@chalkline/sync/relay';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { chromium, type Browser, type CDPSession, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RELAY_PATH, startLanServer, type LanServer } from '../src/server';

/** The built page, which `npm run build --workspace @chalkline/web` writes. */
const ROOT = fileURLToPath(new URL('../../web/dist/', import.meta.url));
/** The built helper, which `npm run build --workspace @chalkline/mcp` writes. */
const HELPER = fileURLToPath(new URL('../../mcp/dist/chalkline-mcp.mjs', import.meta.url));
/** The script the browser loads before the page's own, which waits for shapes and draws frames. */
const PAGE_SCRIPT = fileURLToPath(new URL('./measure-page.js', import.meta.url));
/** The name the measurement's MCP client connects with. */
const CLIENT = 'chalkline-measure';
/** The browser window's size. */
const VIEWPORT = { width: 1200, height: 800 };
/** The sizes of the boards the measurement fills. */
const SIZES = [100, 4000];
/** How far apart, in pixels, the shapes of a board's grid are. */
const SPACING = 60;
/** How many shapes each add_shapes call adds. */
const SHAPES_PER_CALL = 100;
/** How many update_shape calls the page shows one at a time, each before the next call, for the median of one. */
const SINGLE_CHANGES = 10;
/** How many update_shape calls go one after another, each once the one before has answered, as an agent's do. */
const CHANGES_IN_A_ROW = 100;
/** How many frames each view draws, for the cost of one. */
const FRAMES = 20;
/** How long each wait of the page lasts. */
const WAIT_MS = 600_000;

/** What measure-page.js and the page put on `window`. */
interface MeasureWindow {
  chalklineMeasure: {
    ready(): Promise<void>;
    watchLoad(count: number): void;
    loaded(waitMs: number): Promise<{ shownMs: number; drawnMs: number }>;
    shown(count: number, waitMs: number): Promise<void>;
    connected(waitMs: number): Promise<void>;
    view(zoom: number, scrollX: number, scrollY: number): Promise<void>;
    pans(count: number): Promise<void>;
    shownAt(id: string, x: number, waitMs: number): Promise<void>;
    remote(): { ms: number; count: number };
  };
}

const VIEWS = ['zoomed in', 'zoomed out'] as const;
type ViewName = (typeof VIEWS)[number];

interface View {
  zoom: number;
  scrollX: number;
  scrollY: number;
}

/** What an operation cost the page. */
interface Cost {
  /** The main thread's busy time, from Chromium's TaskDuration metric. */
  busyMs: number;
  /** The time the page spent in the transactions that applied its peers' changes. */
  remoteMs: number;
  /** The time from the operation's start until it ended, as this process saw it. */
  wallMs: number;
}

interface ViewNumbers {
  zoom: number;
  /** The first frames at the view's zoom, which draw each shape at that zoom. */
  firstDraw: Cost;
  /** FRAMES frames at the view, each after a move of one pixel. */
  frames: Cost;
  /** The median of SINGLE_CHANGES update_shape calls, each shown before the next. */
  change: Cost;
  /** CHANGES_IN_A_ROW update_shape calls, one after another, until the page shows the last. */
  row: Cost;
}

interface BoardNumbers {
  count: number;
  load: { shownMs: number; drawnMs: number };
  views: Record<ViewName, ViewNumbers>;
}

/** The columns of a board's grid, about one and a half times as many as its rows. */
function columnsOf(count: number): number {
  return Math.ceil(Math.sqrt(count * 1.5));
}

function idOf(index: number): string {
  return `shape-${index}`;
}

/** The left edge of shape `index` as add_shapes adds it. */
function leftOf(index: number, columns: number): number {
  return (index % columns) * SPACING;
}

/** Shape `index` of a board: a small rectangle, ellipse or line in its cell of the grid. */
function shapeAt(index: number, columns: number): Record<string, unknown> {
  const id = idOf(index);
  const x = leftOf(index, columns);
  const y = Math.trunc(index / columns) * SPACING;
  switch (index % 3) {
    case 0:
      return { type: 'rectangle', id, x, y, width: 40, height: 30, backgroundColor: '#a5d8ff' };
    case 1:
      return { type: 'ellipse', id, x, y, width: 40, height: 30, backgroundColor: '#ffc9c9' };
    default:
      return { type: 'line', id, x, y: y + 15, width: 40, height: 10 };
  }
}

/** The view of each name: zoom 2 at the board's top left, and the whole board in the window. */
function viewOf(name: ViewName, count: number): View {
  if (name === 'zoomed in') return { zoom: 2, scrollX: 0, scrollY: 0 };
  const columns = columnsOf(count);
  const width = columns * SPACING;
  const height = Math.ceil(count / columns) * SPACING;
  const zoom = Math.max(0.1, Math.min(VIEWPORT.width / width, VIEWPORT.height / height) * 0.9);
  return { zoom: Math.round(zoom * 100) / 100, scrollX: 0, scrollY: 0 };
}

/** Calls one of the helper's tools, and checks that it didn't refuse the call. */
async function call(client: Client, name: string, args: Record<string, unknown>): Promise<void> {
  const result = (await client.callTool({ name, arguments: args })) as CallToolResult;
  expect(result.isError, `${name}: ${JSON.stringify(result.content)}`).not.toBe(true);
}

/** The main thread's busy time so far, in milliseconds, from Chromium's TaskDuration metric. */
async function busyMs(cdp: CDPSession): Promise<number> {
  const { metrics } = await cdp.send('Performance.getMetrics');
  const task = metrics.find((metric) => metric.name === 'TaskDuration');
  if (task === undefined) throw new Error("Chromium's metrics lack TaskDuration");
  return task.value * 1000;
}

/** What `work` costs the page. */
async function cost(cdp: CDPSession, page: Page, work: () => Promise<unknown>): Promise<Cost> {
  const remote = () => page.evaluate(() => (window as unknown as MeasureWindow).chalklineMeasure.remote().ms);
  const busyBefore = await busyMs(cdp);
  const remoteBefore = await remote();
  const started = performance.now();
  await work();
  const wallMs = performance.now() - started;
  const remoteAfter = await remote();
  const busyAfter = await busyMs(cdp);
  return { busyMs: busyAfter - busyBefore, remoteMs: remoteAfter - remoteBefore, wallMs };
}

function median(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.trunc(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function medianCost(costs: Cost[]): Cost {
  return {
    busyMs: median(costs.map((each) => each.busyMs)),
    remoteMs: median(costs.map((each) => each.remoteMs)),
    wallMs: median(costs.map((each) => each.wallMs)),
  };
}

/** Fills a new board with `count` shapes through the helper, and measures the page on it. */
async function measureBoard(server: LanServer, browser: Browser, count: number): Promise<BoardNumbers> {
  const link = new URL(`http://127.0.0.1:${server.port}/`);
  link.searchParams.set(RELAY_PARAM, RELAY_PATH);
  link.hash = `room=measure-${randomBytes(8).toString('hex')}&key=${randomBytes(16).toString('hex')}`;
  const context = await browser.newContext({ viewport: VIEWPORT });
  const client = new Client({ name: CLIENT, version: '0.0.0' });
  try {
    await context.addInitScript({ path: PAGE_SCRIPT });
    const page = await context.newPage();
    page.on('pageerror', (error) => console.log(`[${count} shapes: page error] ${error.message}`));
    await page.goto(link.href);
    await page.evaluate(() => (window as unknown as MeasureWindow).chalklineMeasure.ready());
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [HELPER, link.href] }));

    const columns = columnsOf(count);
    for (let start = 0; start < count; start += SHAPES_PER_CALL) {
      const shapes: Record<string, unknown>[] = [];
      for (let index = start; index < Math.min(count, start + SHAPES_PER_CALL); index += 1) {
        shapes.push(shapeAt(index, columns));
      }
      await call(client, 'add_shapes', { shapes });
    }
    await page.evaluate(
      (arg) => (window as unknown as MeasureWindow).chalklineMeasure.shown(arg.count, arg.waitMs),
      { count, waitMs: WAIT_MS },
    );
    console.log(`${count} shapes: the page shows every shape the helper added`);

    // The page loads again, and takes the board from the copy this browser keeps or from the helper,
    // whichever reaches it first.
    await context.addInitScript(
      (expected: number) => (window as unknown as MeasureWindow).chalklineMeasure.watchLoad(expected),
      count,
    );
    await page.reload();
    const load = await page.evaluate(
      (waitMs) => (window as unknown as MeasureWindow).chalklineMeasure.loaded(waitMs),
      WAIT_MS,
    );
    await page.evaluate((waitMs) => (window as unknown as MeasureWindow).chalklineMeasure.connected(waitMs), WAIT_MS);
    console.log(`${count} shapes: loaded again, ${JSON.stringify(load)}`);

    const cdp = await context.newCDPSession(page);
    await cdp.send('Performance.enable');
    const lefts = new Map<string, number>();
    for (let index = 0; index < count; index += 1) lefts.set(idOf(index), leftOf(index, columns));
    /** Moves shape `index` 5 pixels right with update_shape, and answers its id and its new x. */
    const move = async (index: number): Promise<{ id: string; x: number }> => {
      const id = idOf(index);
      const x = (lefts.get(id) ?? 0) + 5;
      lefts.set(id, x);
      await call(client, 'update_shape', { id, x });
      return { id, x };
    };
    const shownAt = (moved: { id: string; x: number }) =>
      page.evaluate(
        (arg) => (window as unknown as MeasureWindow).chalklineMeasure.shownAt(arg.id, arg.x, arg.waitMs),
        { ...moved, waitMs: WAIT_MS },
      );

    const views = {} as Record<ViewName, ViewNumbers>;
    for (const name of VIEWS) {
      const view = viewOf(name, count);
      const firstDraw = await cost(cdp, page, () =>
        page.evaluate(
          (arg) => (window as unknown as MeasureWindow).chalklineMeasure.view(arg.zoom, arg.scrollX, arg.scrollY),
          view,
        ),
      );
      const frames = await cost(cdp, page, () =>
        page.evaluate((frameCount) => (window as unknown as MeasureWindow).chalklineMeasure.pans(frameCount), FRAMES),
      );
      // The shapes of the board's first row, which each view shows.
      const singles: Cost[] = [];
      for (let index = 0; index < SINGLE_CHANGES; index += 1) {
        singles.push(await cost(cdp, page, async () => shownAt(await move(index))));
      }
      const row = await cost(cdp, page, async () => {
        let last = { id: idOf(0), x: 0 };
        for (let index = 0; index < Math.min(CHANGES_IN_A_ROW, count); index += 1) last = await move(index);
        await shownAt(last);
      });
      views[name] = { zoom: view.zoom, firstDraw, frames, change: medianCost(singles), row };
      console.log(`${count} shapes, ${name}: ${JSON.stringify(views[name])}`);
    }
    return { count, load, views };
  } finally {
    await client.close();
    await context.close();
  }
}

function fixed(value: number, digits = 1): string {
  return value.toFixed(digits);
}

/** The measurement's numbers as a Markdown table, a column for each board. */
function table(boards: BoardNumbers[]): string {
  const rows: [string, (board: BoardNumbers) => string][] = [
    ['Load again: every shape shown (ms after navigation)', (board) => fixed(board.load.shownMs, 0)],
    ['Load again: the frame after it (ms after navigation)', (board) => fixed(board.load.drawnMs, 0)],
  ];
  for (const name of VIEWS) {
    const of = (board: BoardNumbers) => board.views[name];
    rows.push(
      [`${name}: zoom`, (board) => fixed(of(board).zoom, 2)],
      [`${name}: first frames at the zoom (main-thread ms)`, (board) => fixed(of(board).firstDraw.busyMs)],
      [`${name}: one frame of a pan (main-thread ms)`, (board) => fixed(of(board).frames.busyMs / FRAMES)],
      [`${name}: one update_shape, median (main-thread ms)`, (board) => fixed(of(board).change.busyMs)],
      [
        `${name}: one update_shape, median (ms in the change's transaction)`,
        (board) => fixed(of(board).change.remoteMs),
      ],
      [`${name}: one update_shape, median (ms until shown)`, (board) => fixed(of(board).change.wallMs, 0)],
      [
        `${name}: ${CHANGES_IN_A_ROW} update_shape calls in a row (main-thread ms per call)`,
        (board) => fixed(of(board).row.busyMs / CHANGES_IN_A_ROW),
      ],
      [
        `${name}: ${CHANGES_IN_A_ROW} update_shape calls in a row (ms in transactions per call)`,
        (board) => fixed(of(board).row.remoteMs / CHANGES_IN_A_ROW),
      ],
      [
        `${name}: ${CHANGES_IN_A_ROW} update_shape calls in a row (s until the last shows)`,
        (board) => fixed(of(board).row.wallMs / 1000, 2),
      ],
    );
  }
  const header = `| | ${boards.map((board) => `${board.count} shapes`).join(' | ')} |`;
  const rule = `|---|${boards.map(() => '---:').join('|')}|`;
  const lines = rows.map(([label, value]) => `| ${label} | ${boards.map(value).join(' | ')} |`);
  return [header, rule, ...lines].join('\n');
}

describe('the page on a board of 100 shapes and on one of 4,000', () => {
  let server: LanServer | undefined;
  let browser: Browser | undefined;

  beforeAll(async () => {
    // The page and the helper come from the build, which CI runs before this measurement.
    await access(join(ROOT, 'index.html'));
    await access(HELPER);
    server = await startLanServer({ root: ROOT, port: 0, host: '127.0.0.1' });
    browser = await chromium.launch();
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    await server?.close();
  }, 60_000);

  it("loads, draws and applies the helper's changes on each board, and prints the numbers", async () => {
    const lan = server;
    const chrome = browser;
    if (lan === undefined || chrome === undefined) throw new Error('the server or the browser did not start');
    const boards: BoardNumbers[] = [];
    for (const count of SIZES) boards.push(await measureBoard(lan, chrome, count));
    console.log(`The board-size measurement:\n\n${table(boards)}\n`);
  }, 2_400_000);
});
