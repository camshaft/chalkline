// The live probe's browser: opens the board, draws a rectangle with the mouse,
// and waits until the board shows each participant's shape and the script's
// labelled box. The Probe workflow runs one copy on each of two runners, and
// draw-box on a third.
//
// Settings, from the environment:
//   PROBE_NAME     this browser's name in the room's probe map, such as chromium
//   BROWSER        chromium or firefox (default: PROBE_NAME)
//   OFFSET         how far right of the first browser's rectangle to draw, in pixels
//   ROOM, KEY      the room's name and password
//   PARTICIPANTS   every name whose shape to wait for, such as chromium,firefox,script
//   LABEL          the label of the script's box
//   PAGE_URL       the page to open; left empty, this script serves the local build
//   WAIT_SECONDS   how long each wait lasts before the probe fails (default: 480)
import { appendFile } from 'node:fs/promises';
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
  await page.goto(link.toString());
  await page.waitForFunction(() => window.chalklineReady !== undefined);
  const selfId = await page.evaluate(async (who) => {
    const handle = await window.chalklineReady;
    handle.doc.getMap('probe').set(`peer-${who}`, handle.selfId);
    return handle.selfId;
  }, name);
  console.log(`${name}: opened ${link.origin}${link.pathname} and joined room ${room} as ${selfId}`);

  // Draw a rectangle with the mouse, as a person would.
  const x = 200 + offset;
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
  await page.evaluate((who) => window.chalkline.doc.getMap('probe').set(`seen-${who}`, new Date().toISOString()), name);

  if (process.env.GITHUB_STEP_SUMMARY) {
    const summary = [
      `### ${name}`,
      '',
      `Opened ${link.origin}${link.pathname}, drew rectangle \`${drawnId}\`, and saw each participant's shape (${participants.join(', ')}) and the box labelled "${label}".`,
      '',
      '| Peer | Connection | This browser\'s candidate | The peer\'s candidate |',
      '| --- | --- | --- | --- |',
      ...rows,
      '',
    ];
    await appendFile(process.env.GITHUB_STEP_SUMMARY, `${summary.join('\n')}\n`);
  }

  // Stay until the script leaves, so that every peer can still reach this browser while it waits.
  const scriptId = probeState['peer-script'];
  const ending = await page.evaluate(
    ({ scriptId, waitMs }) =>
      new Promise((resolve) => {
        const handle = window.chalkline;
        if (!handle.peers().includes(scriptId)) {
          resolve('the script had left');
          return;
        }
        let stop = () => {};
        const timer = setTimeout(() => {
          stop();
          resolve('the script was still in the room when the wait ended');
        }, waitMs);
        stop = handle.onPeerLeave((peerId) => {
          if (peerId !== scriptId) return;
          stop();
          clearTimeout(timer);
          resolve('the script left');
        });
      }),
    { scriptId, waitMs },
  );
  console.log(`${name}: ${ending}`);
} catch (error) {
  process.exitCode = 1;
  console.error(`${name}: the probe failed: ${error instanceof Error ? error.stack : error}`);
  await page.screenshot({ path: screenshot }).catch(() => {});
} finally {
  await browser.close();
  await server?.close();
}
