// The live probe's browser: opens the page's own address and waits for its
// join screen, puts the board's link in the address as a person who pastes it
// in the address bar, types its name in the name field, draws a rectangle with
// the mouse, and waits until the board shows each participant's shape, the
// script's labelled box, and each other browser's cursor with its name. Next it
// saves the board to a file with the Save file button, opens a file that holds
// a copy of its rectangle, and waits until the board shows each browser's copy.
// It then marks seen-<name>, stays until the script marks done-script, and
// marks bye-<name> as it leaves. Last, it presses New board and waits until the
// page loads again on a new room's link. The Probe workflow runs one copy on
// each of two runners, and draw-box on a third.
//
// Settings, from the environment:
//   PROBE_NAME     this browser's name in the room's probe map and by its cursor, such as chromium
//   BROWSER        chromium or firefox (default: PROBE_NAME)
//   OFFSET         how far right of the first browser's rectangle to draw, in pixels
//   ROOM, KEY      the room's name and password
//   PARTICIPANTS   every name whose shape to wait for, such as chromium,firefox,script
//   BROWSERS       every browser's name, whose cursor the other browsers wait for, such as chromium,firefox
//                  (default: none)
//   LABEL          the label of the script's box
//   PAGE_URL       the page to open; left empty, this script serves the local build
//   WAIT_SECONDS   how long each wait lasts before the probe fails (default: 480)
import { appendFile, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium, firefox } from 'playwright';
import { preview } from 'vite';

function setting(name, fallback) {
  const value = process.env[name] || fallback;
  if (value === undefined) throw new Error(`set ${name}`);
  return value;
}

const name = setting('PROBE_NAME');
const browserName = setting('BROWSER', name);
const offset = Number(setting('OFFSET', '0'));
const room = setting('ROOM');
const key = setting('KEY');
const participants = setting('PARTICIPANTS')
  .split(',')
  .map((participant) => participant.trim())
  .filter((participant) => participant.length > 0);
const others = setting('BROWSERS', '')
  .split(',')
  .map((other) => other.trim())
  .filter((other) => other.length > 0 && other !== name);
const label = setting('LABEL');
const waitMs = Number(setting('WAIT_SECONDS', '480')) * 1000;
const screenshot = `probe-${name}.png`;

let server;
let pageUrl = process.env.PAGE_URL;
if (!pageUrl) {
  server = await preview({
    root: fileURLToPath(new URL('..', import.meta.url)),
    preview: { host: '127.0.0.1', port: 4173, strictPort: true },
  });
  pageUrl = 'http://127.0.0.1:4173/';
}
const link = new URL(pageUrl);
link.hash = new URLSearchParams({ room, key }).toString();

const launcher = { chromium, firefox }[browserName];
if (launcher === undefined) throw new Error(`BROWSER is ${browserName}, which isn't chromium or firefox`);
const browser = await launcher.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
page.on('console', (message) => console.log(`[${name} console.${message.type()}] ${message.text()}`));
page.on('pageerror', (error) => console.log(`[${name} page error] ${error.message}`));

try {
  // The page's own address doesn't name a board, so the page shows its join screen.
  const home = new URL(link);
  home.hash = '';
  await page.goto(home.toString());
  await page.locator('.join-screen').waitFor({ timeout: 30_000 });
  console.log(`${name}: the page's own address shows the join screen`);

  // Put the board's link in the address, as a person who pastes it in the address bar: only the
  // fragment changes, so the page doesn't load again, and it joins the board the link names.
  await page.goto(link.toString());
  await page.waitForFunction(() => window.chalklineReady !== undefined);
  const selfId = await page.evaluate(async (who) => {
    const handle = await window.chalklineReady;
    handle.doc.getMap('probe').set(`peer-${who}`, handle.selfId);
    return handle.selfId;
  }, name);
  console.log(`${name}: opened ${link.origin}${link.pathname} and joined room ${room} as ${selfId}`);

  // Type this browser's name in the name field, as a person does, so that the other browsers show it by its cursor.
  await page.locator('#name').fill(name);

  // Draw a rectangle with the mouse, as a person would.
  // Left of x = 320 the selected tool's properties panel covers the canvas, so draw to its right.
  const x = 360 + offset;
  const y = 200;
  const width = 240;
  // The tool's radio input sits under its icon, so click the label that holds both, as a person does.
  await page.locator('label', { has: page.locator('[data-testid="toolbar-rectangle"]') }).click();
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + width, y + 140, { steps: 12 });
  await page.mouse.up();
  const drawn = await page.waitForFunction(
    ({ x, width }) =>
      window.chalkline.api
        .getSceneElements()
        .find((element) => element.type === 'rectangle' && Math.abs(element.x - x) < 12 && Math.abs(element.width - width) < 12)
        ?.id,
    { x, width },
    { timeout: 30_000 },
  );
  const drawnId = await drawn.jsonValue();
  await page.evaluate(({ who, id }) => window.chalkline.doc.getMap('probe').set(`drawn-${who}`, id), { who: name, id: drawnId });
  console.log(`${name}: drew the rectangle ${drawnId}`);

  // Wait, on the scene's and the document's change events, until every shape is on the board.
  const seen = await page.evaluate(
    ({ participants, label, waitMs }) =>
      new Promise((resolve, reject) => {
        const { api, doc } = window.chalkline;
        const probe = doc.getMap('probe');
        const state = () => {
          const elements = api.getSceneElements();
          const ids = new Set(elements.map((element) => element.id));
          const drawn = Object.fromEntries(participants.map((participant) => [participant, probe.get(`drawn-${participant}`) ?? null]));
          const missing = participants.filter((participant) => !ids.has(drawn[participant]));
          const labelled = elements.some(
            (element) => element.type === 'text' && element.originalText === label && ids.has(element.containerId),
          );
          return { drawn, missing, labelled };
        };
        let finished = false;
        let stopScene = () => {};
        let timer;
        const finish = (error, value) => {
          if (finished) return;
          finished = true;
          stopScene();
          doc.off('update', check);
          clearTimeout(timer);
          if (error) reject(error);
          else resolve(value);
        };
        const check = () => {
          const now = state();
          if (now.missing.length === 0 && now.labelled) finish(null, now);
        };
        stopScene = api.onChange(check);
        doc.on('update', check);
        timer = setTimeout(() => finish(new Error(`timed out waiting for every shape: ${JSON.stringify(state())}`)), waitMs);
        check();
      }),
    { participants, label, waitMs },
  );
  console.log(`${name}: the board shows every shape: ${JSON.stringify(seen)}`);

  // Wait, on the scene's change events, until the board shows each other browser's cursor with its name.
  const cursors = await page.evaluate(
    ({ others, waitMs }) =>
      new Promise((resolve, reject) => {
        const { api } = window.chalkline;
        const state = () => {
          const shown = [...api.getAppState().collaborators.values()];
          const cursors = Object.fromEntries(
            others.map((other) => [
              other,
              shown.find((collaborator) => collaborator.username === other && collaborator.pointer !== undefined)?.pointer ??
                null,
            ]),
          );
          const missing = others.filter((other) => cursors[other] === null);
          return { cursors, missing, shown: shown.map(({ username, pointer }) => ({ username, pointer })) };
        };
        let finished = false;
        let stopScene = () => {};
        let timer;
        const finish = (error, value) => {
          if (finished) return;
          finished = true;
          stopScene();
          clearTimeout(timer);
          if (error) reject(error);
          else resolve(value);
        };
        const check = () => {
          const now = state();
          if (now.missing.length === 0) finish(null, now.cursors);
        };
        stopScene = api.onChange(check);
        timer = setTimeout(() => finish(new Error(`timed out waiting for every cursor: ${JSON.stringify(state())}`)), waitMs);
        check();
      }),
    { others, waitMs },
  );
  console.log(`${name}: the board shows each other browser's cursor: ${JSON.stringify(cursors)}`);

  // Save the board with the Save file button, as a person does, and read the file the browser downloads.
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 30_000 }),
    page.locator('#save-button').click(),
  ]);
  const savedName = download.suggestedFilename();
  const saved = JSON.parse(await readFile(await download.path(), 'utf8'));
  const savedBox = Array.isArray(saved.elements) ? saved.elements.find((element) => element.id === drawnId) : undefined;
  if (saved.type !== 'excalidraw' || savedBox === undefined) {
    throw new Error(`the saved file ${savedName} doesn't hold the rectangle ${drawnId}: ${JSON.stringify(saved).slice(0, 2000)}`);
  }
  console.log(`${name}: saved the board as ${savedName}, which holds ${saved.elements.length} elements`);

  // Open a file that holds a copy of this browser's rectangle under a new id, below the first one, with
  // the Open file button's file input, and wait until the board shows each browser's opened copy.
  const opened = `opened-${name}`;
  const copy = { ...savedBox, id: opened, y: savedBox.y + 200 };
  // Excalidraw gives the copy a place in the stacking order as it reads the file.
  delete copy.index;
  await page.locator('#open-file').setInputFiles({
    name: `${opened}.excalidraw`,
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify({ ...saved, elements: [copy] })),
  });
  const openedIds = [name, ...others].map((browser) => `opened-${browser}`);
  await page.evaluate(
    ({ ids, waitMs }) =>
      new Promise((resolve, reject) => {
        const { api, doc } = window.chalkline;
        const missing = () => {
          const shown = new Set(api.getSceneElements().map((element) => element.id));
          return ids.filter((id) => !shown.has(id));
        };
        let finished = false;
        let stopScene = () => {};
        let timer;
        const finish = (error) => {
          if (finished) return;
          finished = true;
          stopScene();
          doc.off('update', check);
          clearTimeout(timer);
          if (error) reject(error);
          else resolve();
        };
        const check = () => {
          if (missing().length === 0) finish(null);
        };
        stopScene = api.onChange(check);
        doc.on('update', check);
        timer = setTimeout(
          () => finish(new Error(`timed out waiting for each opened copy: ${JSON.stringify({ missing: missing(), status: document.getElementById('status')?.textContent })}`)),
          waitMs,
        );
        check();
      }),
    { ids: openedIds, waitMs },
  );
  console.log(`${name}: the board shows each browser's copy opened from a file: ${JSON.stringify(openedIds)}`);

  // Mark this browser's view as seen, and stay until the script has every browser's mark: a
  // browser that left at once could take its mark with it before any peer received it.
  await page.evaluate((who) => window.chalkline.doc.getMap('probe').set(`seen-${who}`, new Date().toISOString()), name);
  await page.evaluate(
    ({ key, waitMs }) =>
      new Promise((resolve, reject) => {
        const probe = window.chalkline.doc.getMap('probe');
        const timer = setTimeout(() => {
          probe.unobserve(check);
          reject(new Error(`timed out waiting for ${key}: ${JSON.stringify(probe.toJSON())}`));
        }, waitMs);
        function check() {
          if (!probe.has(key)) return;
          probe.unobserve(check);
          clearTimeout(timer);
          resolve();
        }
        probe.observe(check);
        check();
      }),
    { key: 'done-script', waitMs },
  );
  console.log(`${name}: the script has every browser's mark`);

  const probeState = await page.evaluate(() => window.chalkline.doc.getMap('probe').toJSON());
  const names = Object.fromEntries(
    Object.entries(probeState)
      .filter(([entry]) => entry.startsWith('peer-'))
      .map(([entry, peerId]) => [peerId, entry.slice('peer-'.length)]),
  );
  const reports = await page.evaluate(() => window.chalkline.connectionReports());
  const describe = (candidate) =>
    candidate === undefined ? 'unknown' : `${candidate.type} ${candidate.protocol} ${candidate.address}:${candidate.port}`;
  const rows = Object.entries(reports).map(([peerId, report]) => {
    const peer = names[peerId] ?? peerId;
    console.log(`${name}: connection to ${peer}: ${JSON.stringify(report)}`);
    return `| ${peer} | ${report.connectionState ?? 'unknown'} | ${describe(report.local)} | ${describe(report.remote)} |`;
  });
  await page.screenshot({ path: screenshot });

  if (process.env.GITHUB_STEP_SUMMARY) {
    const summary = [
      `### ${name}`,
      '',
      `Opened ${link.origin}${link.pathname} as "${name}", drew rectangle \`${drawnId}\`, and saw each participant's shape (${participants.join(', ')}), the box labelled "${label}", and each other browser's cursor with its name (${others.join(', ') || 'none'}). It saved the board as \`${savedName}\`, opened a copy of its rectangle from a file, and saw each browser's copy (${openedIds.join(', ')}).`,
      '',
      '| Peer | Connection | This browser\'s candidate | The peer\'s candidate |',
      '| --- | --- | --- | --- |',
      ...rows,
      '',
    ];
    await appendFile(process.env.GITHUB_STEP_SUMMARY, `${summary.join('\n')}\n`);
  }

  // Say goodbye, so that the script may leave as well.
  await page.evaluate((who) => window.chalkline.doc.getMap('probe').set(`bye-${who}`, new Date().toISOString()), name);
  console.log(`${name}: said goodbye`);

  // Start another board from the bar's New board button, as a person does: the page loads again on a new room's link.
  await Promise.all([page.waitForEvent('load'), page.getByRole('button', { name: 'New board', exact: true }).click()]);
  await page.waitForFunction(() => window.chalklineReady !== undefined);
  const next = await page.evaluate(async () => (await window.chalklineReady).room);
  const nextLink = new URLSearchParams(new URL(page.url()).hash.slice(1));
  if (next === room || nextLink.get('room') !== next || !nextLink.get('key')) {
    throw new Error(`New board opened room ${next} at ${new URL(page.url()).pathname}, in place of a new room with a password`);
  }
  console.log(`${name}: New board opened the new room ${next}`);
} catch (error) {
  process.exitCode = 1;
  console.error(`${name}: the probe failed: ${error instanceof Error ? error.stack : error}`);
  const board = await page
    .evaluate(() => ({
      tool: window.chalkline?.api.getAppState().activeTool.type,
      elements: window.chalkline?.api
        .getSceneElements()
        .map(({ id, type, x, y, width, height }) => ({ id, type, x, y, width, height })),
      probe: window.chalkline?.doc.getMap('probe').toJSON(),
      peers: window.chalkline?.peers(),
      name: document.getElementById('name')?.value,
      cursors: [...(window.chalkline?.api.getAppState().collaborators.values() ?? [])].map(({ username, pointer }) => ({
        username,
        pointer,
      })),
    }))
    .catch((readError) => `unread: ${readError}`);
  console.error(`${name}: the board when the probe failed: ${JSON.stringify(board)}`);
  await page.screenshot({ path: screenshot }).catch(() => {});
} finally {
  await browser.close();
  await server?.close();
}
