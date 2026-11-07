// The end-to-end test of designs/chalkline A10: one machine serves the built page and the relay,
// as chalkline-lan does, Playwright opens the board in two browser contexts, and the built
// chalkline-mcp, the agent's helper, joins the same board from its link through the same relay.
// The helper adds a labelled rectangle and a labelled ellipse and connects them with a labelled
// arrow, and the test waits until both browsers show each of them. It needs the page and the
// helper that `npm run build` writes, and `npm run test:e2e` runs it.
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

/** What the page and page.js put on `window`. */
interface E2eWindow {
  chalklineReady?: Promise<unknown>;
  chalklineE2e: { shown(expected: Expected[], creator: string, waitMs: number): Promise<Shown[]> };
}

/** A browser context with the board open in its page. */
interface Board {
  name: string;
  page: Page;
}

/** Opens `link` in a new context of `browser`, and resolves once the page's board has started. */
async function openBoard(browser: Browser, link: URL, name: string): Promise<Board> {
  const context = await browser.newContext({ viewport: { width: 1200, height: 800 } });
  await context.addInitScript({ path: PAGE_SCRIPT });
  const page = await context.newPage();
  page.on('console', (message) => console.log(`[${name} console.${message.type()}] ${message.text()}`));
  page.on('pageerror', (error) => console.log(`[${name} page error] ${error.message}`));
  await page.goto(link.href);
  await page.waitForFunction(() => (window as unknown as E2eWindow).chalklineReady !== undefined);
  await page.evaluate(async () => {
    await (window as unknown as E2eWindow).chalklineReady;
  });
  return { name, page };
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
    const link = new URL(`http://127.0.0.1:${lan.port}/`);
    link.searchParams.set(RELAY_PARAM, RELAY_PATH);
    link.hash = `room=e2e-${randomBytes(8).toString('hex')}&key=${randomBytes(16).toString('hex')}`;
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
});
