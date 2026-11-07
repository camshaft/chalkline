// The live probe's browser: opens the page's own address and waits for its
// join screen, puts the board's link in the address as a person who pastes it
// in the address bar, types its name in the name field, draws a rectangle with
// the mouse, and waits until the board shows each participant's shape, the
// script's labelled box, and each other browser's cursor with its name. Next it
// saves the board to a file with the main menu's Save file item, opens a file that holds
// a copy of its rectangle and an image whose picture is a PNG of about 262 KB,
// and waits until the board shows each browser's copy and image and holds each
// image's picture.
// Once every browser has seen each copy, the first browser resets the canvas
// from Excalidraw's menu, and each browser waits until its board shows none of
// the shapes. Next it writes a request for a page to draw a Mermaid diagram, as
// the agent's helper does with add_mermaid, and waits until the board shows each
// browser's diagram. Next it opens the chat with its button, types a message in
// the chat's field and presses Enter, and waits until its chat shows each
// browser's message under that browser's name. It then marks seen-<name>, stays until the script marks
// done-script, and marks bye-<name> as it leaves. Last, it chooses New board in the main menu and
// waits until the page loads again on a new room's link. The Probe workflow runs
// one copy on each of two runners, and draw-box on a third.
//
// Settings, from the environment:
//   PROBE_NAME     this browser's name in the room's probe map and by its cursor, such as chromium
//   BROWSER        chromium or firefox (default: PROBE_NAME)
//   OFFSET         how far right of the first browser's rectangle to draw, in pixels
//   ROOM, KEY      the room's name and password
//   PARTICIPANTS   every name whose shape to wait for, such as chromium,firefox,script
//   BROWSERS       every browser's name, whose cursor the other browsers wait for, such as chromium,firefox;
//                  the first one resets the canvas (default: none, and this browser resets it)
//   LABEL          the label of the script's box
//   PAGE_URL       the page to open; left empty, this script serves the local build
//   WAIT_SECONDS   how long each wait lasts before the probe fails (default: 480)
import { appendFile, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { crc32 } from 'node:zlib';
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
// The browser that resets the canvas once every browser has seen each shape: the first of BROWSERS.
const resetter =
  setting('BROWSERS', '')
    .split(',')
    .map((browser) => browser.trim())
    .find((browser) => browser.length > 0) ?? name;
const label = setting('LABEL');
const waitMs = Number(setting('WAIT_SECONDS', '480')) * 1000;
const screenshot = `probe-${name}.png`;

/**
 * A PNG of `size` by `size` pixels of noise, as a data URL, the same on every runner: its pixels come
 * from a fixed xorshift sequence, and its image data is stored without compression, so its bytes don't
 * depend on the zlib version. At 256 by 256 pixels it holds about 262 KB, more than one 16 KB frame of
 * a connection to a peer, so it travels to each peer in many frames.
 */
function noisePng(size) {
  const rowBytes = 1 + size * 4;
  const raw = Buffer.alloc(size * rowBytes);
  let state = 0x2545f491;
  for (let index = 0; index < raw.length; index += 1) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    // Each row starts with its filter type, 0 for none.
    raw[index] = index % rowBytes === 0 ? 0 : state & 0xff;
  }
  // A zlib stream of stored blocks: its header, blocks of at most 65535 bytes, and the Adler-32 of the data.
  const stream = [Buffer.from([0x78, 0x01])];
  for (let offset = 0; offset < raw.length; offset += 65535) {
    const data = raw.subarray(offset, offset + 65535);
    const block = Buffer.alloc(5);
    block[0] = offset + data.length === raw.length ? 1 : 0;
    block.writeUInt16LE(data.length, 1);
    block.writeUInt16LE(0xffff - data.length, 3);
    stream.push(block, data);
  }
  let low = 1;
  let high = 0;
  for (const byte of raw) {
    low = (low + byte) % 65521;
    high = (high + low) % 65521;
  }
  const adler = Buffer.alloc(4);
  adler.writeUInt32BE(high * 65536 + low);
  stream.push(adler);
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const check = Buffer.alloc(4);
    check.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, check]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // 8 bits a channel
  header[9] = 6; // red, green, blue and alpha; the compression, filter and interlace methods stay 0
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const png = Buffer.concat([
    signature,
    chunk('IHDR', header),
    chunk('IDAT', Buffer.concat(stream)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  return `data:image/png;base64,${png.toString('base64')}`;
}

// The picture of the image that each browser opens from a file.
const picture = noisePng(256);

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

  // Save the board with the main menu's Save file item, as a person does, and read the file the browser downloads.
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 30_000 }),
    page
      .getByTestId('main-menu-trigger')
      .click()
      .then(() => page.getByRole('button', { name: 'Save file', exact: true }).click()),
  ]);
  const savedName = download.suggestedFilename();
  const saved = JSON.parse(await readFile(await download.path(), 'utf8'));
  const savedBox = Array.isArray(saved.elements) ? saved.elements.find((element) => element.id === drawnId) : undefined;
  if (saved.type !== 'excalidraw' || savedBox === undefined) {
    throw new Error(`the saved file ${savedName} doesn't hold the rectangle ${drawnId}: ${JSON.stringify(saved).slice(0, 2000)}`);
  }
  console.log(`${name}: saved the board as ${savedName}, which holds ${saved.elements.length} elements`);

  // Open a file that holds a copy of this browser's rectangle under a new id, below the first one, and an
  // image with its picture beside the copy, with the file input of the main menu's Open file item. Then wait until the
  // board shows each browser's opened copy and image, and holds each image's picture as its file has it.
  const opened = `opened-${name}`;
  const copy = { ...savedBox, id: opened, y: savedBox.y + 200 };
  // Excalidraw gives the copy a place in the stacking order as it reads the file.
  delete copy.index;
  const pictureId = `picture-${name}`;
  const image = {
    ...copy,
    id: `image-${name}`,
    type: 'image',
    x: copy.x + copy.width + 40,
    fileId: pictureId,
    status: 'saved',
    scale: [1, 1],
    crop: null,
  };
  await page.locator('#open-file').setInputFiles({
    name: `${opened}.excalidraw`,
    mimeType: 'application/json',
    buffer: Buffer.from(
      JSON.stringify({
        ...saved,
        elements: [copy, image],
        files: { [pictureId]: { id: pictureId, mimeType: 'image/png', dataURL: picture, created: Date.now() } },
      }),
    ),
  });
  const browsers = [name, ...others];
  const openedIds = browsers.flatMap((browser) => [`opened-${browser}`, `image-${browser}`]);
  const pictureIds = browsers.map((browser) => `picture-${browser}`);
  await page.evaluate(
    ({ ids, pictures, dataURL, waitMs }) =>
      new Promise((resolve, reject) => {
        const { api, doc } = window.chalkline;
        const missing = () => {
          const shown = new Set(api.getSceneElements().map((element) => element.id));
          const files = api.getFiles();
          return [...ids.filter((id) => !shown.has(id)), ...pictures.filter((id) => files[id]?.dataURL !== dataURL)];
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
          () => finish(new Error(`timed out waiting for each opened copy, image and picture: ${JSON.stringify({ missing: missing(), status: document.getElementById('status')?.textContent })}`)),
          waitMs,
        );
        check();
      }),
    { ids: openedIds, pictures: pictureIds, dataURL: picture, waitMs },
  );
  console.log(
    `${name}: the board shows each browser's copy and image opened from a file (${openedIds.join(', ')}), and holds each picture of ${picture.length} characters (${pictureIds.join(', ')})`,
  );

  // Once every browser has seen each shape and copy, reset the canvas from Excalidraw's menu on the
  // first browser, as a person does, and wait until the board shows none of the shapes: the reset
  // marks each shape deleted, and the binding shares the deleted copies with every page.
  await page.evaluate((who) => window.chalkline.doc.getMap('probe').set(`ready-${who}`, new Date().toISOString()), name);
  if (name === resetter) {
    await page.evaluate(
      ({ keys, waitMs }) =>
        new Promise((resolve, reject) => {
          const probe = window.chalkline.doc.getMap('probe');
          const timer = setTimeout(() => {
            probe.unobserve(check);
            reject(new Error(`timed out waiting for ${keys.join(', ')}: ${JSON.stringify(probe.toJSON())}`));
          }, waitMs);
          function check() {
            if (!keys.every((key) => probe.has(key))) return;
            probe.unobserve(check);
            clearTimeout(timer);
            resolve();
          }
          probe.observe(check);
          check();
        }),
      { keys: [name, ...others].map((browser) => `ready-${browser}`), waitMs },
    );
    await page.getByTestId('main-menu-trigger').click();
    await page.getByTestId('clear-canvas-button').click();
    await page.getByRole('button', { name: 'Confirm', exact: true }).click();
    console.log(`${name}: reset the canvas from Excalidraw's menu`);
  }
  await page.evaluate(
    (waitMs) =>
      new Promise((resolve, reject) => {
        const { api, doc } = window.chalkline;
        const shown = () => api.getSceneElements().map((element) => element.id);
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
          if (shown().length === 0) finish(null);
        };
        stopScene = api.onChange(check);
        doc.on('update', check);
        timer = setTimeout(() => finish(new Error(`timed out waiting for the reset to clear the board: ${JSON.stringify(shown())}`)), waitMs);
        check();
      }),
    waitMs,
  );
  console.log(`${name}: the board shows none of the shapes after ${resetter} reset the canvas`);

  // Write a request for a page to draw a Mermaid diagram, as the agent's helper does with
  // add_mermaid, and wait, on the scene's and the document's change events, until each browser's
  // request is done and the board shows its shapes. One page of the room converts each request.
  await page.evaluate(
    ({ id, who, x }) =>
      window.chalkline.doc.getMap('requests').set(id, {
        kind: 'mermaid',
        text: `flowchart LR\n  start["${who}"] --> finish["drawn"]`,
        by: who,
        status: 'pending',
        error: null,
        at: { x, y: 600 },
      }),
    { id: `mermaid-${name}`, who: name, x: 360 + offset },
  );
  const requestIds = [name, ...others].map((browser) => `mermaid-${browser}`);
  const diagrams = await page.evaluate(
    ({ ids, waitMs }) =>
      new Promise((resolve, reject) => {
        const { api, doc } = window.chalkline;
        const requests = doc.getMap('requests');
        const state = () => {
          const shown = new Set(api.getSceneElements().map((element) => element.id));
          const read = Object.fromEntries(ids.map((id) => [id, requests.get(id) ?? null]));
          const failed = ids.filter((id) => read[id]?.status === 'failed');
          const missing = ids.filter(
            (id) =>
              read[id]?.status !== 'done' ||
              !Array.isArray(read[id].ids) ||
              read[id].ids.length === 0 ||
              !read[id].ids.every((shape) => shown.has(shape)),
          );
          return { read, failed, missing };
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
          if (now.failed.length > 0) finish(new Error(`a page couldn't convert a Mermaid request: ${JSON.stringify(now.read)}`));
          else if (now.missing.length === 0) finish(null, Object.fromEntries(ids.map((id) => [id, now.read[id].ids])));
        };
        stopScene = api.onChange(check);
        doc.on('update', check);
        timer = setTimeout(() => finish(new Error(`timed out waiting for each Mermaid diagram: ${JSON.stringify(state())}`)), waitMs);
        check();
      }),
    { ids: requestIds, waitMs },
  );
  console.log(`${name}: the board shows each browser's Mermaid diagram: ${JSON.stringify(diagrams)}`);

  // Open the chat with its button, type a message in its field and press Enter, as a person does,
  // and wait, on the panel's own changes, until the chat shows each browser's message as a typed
  // entry under that browser's name.
  await page.getByRole('button', { name: /^Chat( \(\d+\))?$/ }).click();
  const messageField = page.getByRole('textbox', { name: 'Message' });
  await messageField.fill(`Hello from ${name}`);
  await messageField.press('Enter');
  const chat = await page.evaluate(
    ({ wanted, waitMs }) =>
      new Promise((resolve, reject) => {
        const panel = document.getElementById('transcript');
        const shown = () =>
          [...panel.querySelectorAll('.transcript-entries li')].map((item) => ({
            speaker: item.querySelector('.transcript-speaker')?.textContent,
            via: item.dataset.via,
            text: item.querySelector('.transcript-text')?.textContent,
          }));
        let finished = false;
        let timer;
        const observer = new MutationObserver(() => check());
        const finish = (error, value) => {
          if (finished) return;
          finished = true;
          observer.disconnect();
          clearTimeout(timer);
          if (error) reject(error);
          else resolve(value);
        };
        const check = () => {
          const now = shown();
          const missing = wanted.filter(
            ({ speaker, text }) => !now.some((entry) => entry.via === 'typed' && entry.speaker === speaker && entry.text === text),
          );
          if (missing.length === 0) finish(null, now);
        };
        observer.observe(panel, { childList: true, subtree: true, characterData: true });
        timer = setTimeout(() => finish(new Error(`timed out waiting for each browser's chat message: ${JSON.stringify(shown())}`)), waitMs);
        check();
      }),
    { wanted: [name, ...others].map((browser) => ({ speaker: browser, text: `Hello from ${browser}` })), waitMs },
  );
  console.log(`${name}: the chat shows each browser's typed message: ${JSON.stringify(chat)}`);

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
      `Opened ${link.origin}${link.pathname} as "${name}", drew rectangle \`${drawnId}\`, and saw each participant's shape (${participants.join(', ')}), the box labelled "${label}", and each other browser's cursor with its name (${others.join(', ') || 'none'}). It saved the board as \`${savedName}\`, opened a copy of its rectangle and an image from a file, and saw each browser's copy and image (${openedIds.join(', ')}) and each picture (${pictureIds.join(', ')}).`,
      `After ${resetter} reset the canvas from Excalidraw's menu, the board showed none of the shapes.`,
      `The board showed each browser's Mermaid diagram: ${JSON.stringify(diagrams)}.`,
      `It typed "Hello from ${name}" in the chat, and the chat showed each browser's typed message: ${JSON.stringify(chat)}.`,
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

  // Start another board from the main menu's New board item, as a person does: the page loads again on a new room's link.
  await page.getByTestId('main-menu-trigger').click();
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
      files: Object.values(window.chalkline?.api.getFiles() ?? {}).map(({ id, dataURL }) => ({ id, length: dataURL.length })),
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
