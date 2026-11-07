// Runs the setup guide of README.md as a person follows it in a new checkout: the steps of its
// sections "Open a board", "Run the local mode" and "Connect an agent". It reads each command from
// README.md and runs it with bash from the repository's root, so a change to a step's commands
// changes what this script runs. CI's README steps job runs it with
// `node packages/lan/e2e/readme-steps.mjs`, with Claude Code's command line installed. Only Node's
// own modules load before the guide's `npm ci` has installed the others.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { watch } from 'node:fs';
import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The repository's root, where each of the guide's commands runs. */
const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
/** The script each browser loads before the page's own, which waits for the helper's shapes. */
const PAGE_SCRIPT = fileURLToPath(new URL('./page.js', import.meta.url));
/** Where each browser's screenshot goes, which CI keeps as an artifact. */
const SCREENSHOTS = fileURLToPath(new URL('..', import.meta.url));
/** The text the guide writes where a board's link goes. */
const LINK = '<the board link>';
/** The name this script's MCP client connects with, which the helper records as each shape's creator. */
const CLIENT = 'chalkline-readme';
/** How long the script waits for each server, page, shape and line it waits for. */
const WAIT_MS = 120_000;

/** The text of each `## ` section of `markdown`, by its heading. */
function sectionsOf(markdown) {
  const sections = new Map();
  let lines;
  for (const line of markdown.split('\n')) {
    const heading = /^## (.+)$/.exec(line);
    if (heading !== null) {
      lines = [];
      sections.set(heading[1].trim(), lines);
    } else if (lines !== undefined) {
      lines.push(line);
    }
  }
  return new Map([...sections].map(([heading, text]) => [heading, text.join('\n')]));
}

const guide = sectionsOf(await readFile(join(ROOT, 'README.md'), 'utf8'));

/** The text of the guide's section `heading`. */
function section(heading) {
  const text = guide.get(heading);
  assert.ok(text !== undefined, `README.md doesn't have the section "## ${heading}"`);
  return text;
}

/** The commands of each sh block of `text`, a line each, in order. */
function shellBlocks(text) {
  return [...text.matchAll(/^```sh\n([\s\S]*?)^```$/gm)].map((block) =>
    block[1].split('\n').filter((line) => line.trim() !== ''),
  );
}

/** Settles as `promise` does, or rejects once WAIT_MS passes first. */
function within(promise, what) {
  let timer;
  const late = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${WAIT_MS} ms waiting for ${what}`)), WAIT_MS);
  });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

/** The commands that ran to their end, so that a command the guide repeats runs once in this checkout. */
const ran = new Set();

/** Runs `command` with bash from the repository's root, and checks that it succeeded. */
function run(command) {
  console.log(`$ ${command}`);
  const result = spawnSync('bash', ['-c', command], { cwd: ROOT, stdio: ['ignore', 'inherit', 'inherit'] });
  assert.equal(result.status, 0, `\`${command}\` exited with ${result.status ?? result.signal}`);
  ran.add(command);
}

/** Runs `command` as `run` does, and returns what it printed on its standard output. */
function output(command) {
  console.log(`$ ${command}`);
  const result = spawnSync('bash', ['-c', command], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  process.stdout.write(result.stdout ?? '');
  assert.equal(result.status, 0, `\`${command}\` exited with ${result.status ?? result.signal}`);
  return result.stdout;
}

/**
 * Starts `command` with bash from the repository's root in a process group of its own, as a
 * command a person leaves running, and reads its standard output.
 */
function start(command) {
  console.log(`$ ${command} &`);
  const child = spawn('bash', ['-c', command], { cwd: ROOT, stdio: ['ignore', 'pipe', 'inherit'], detached: true });
  const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
  return {
    command,
    child,
    exited,
    /** Sends `signal` to the command's process group, as Ctrl-C sends SIGINT, and resolves once bash exits. */
    stop(signal) {
      try {
        process.kill(-child.pid, signal);
      } catch {
        // The process group has exited already.
      }
      return exited;
    },
  };
}

/** Calls `onLine` with each line of `stream`, and copies the stream to this script's standard output. */
function eachLine(stream, onLine) {
  let rest = '';
  stream.setEncoding('utf8').on('data', (chunk) => {
    process.stdout.write(chunk);
    rest += chunk;
    for (let end = rest.indexOf('\n'); end !== -1; end = rest.indexOf('\n')) {
      onLine(rest.slice(0, end));
      rest = rest.slice(end + 1);
    }
  });
}

/**
 * Resolves once the file at `path` holds `text`, read again on each change the file system reports,
 * and rejects where `started` exits first.
 */
function fileHolds(path, text, started) {
  return new Promise((resolve, reject) => {
    const watcher = watch(path);
    const finish = (error, value) => {
      watcher.close();
      if (error === null) resolve(value);
      else reject(error);
    };
    const check = () =>
      readFile(path, 'utf8').then(
        (content) => {
          if (content.includes(text)) finish(null, content);
        },
        (error) => finish(error),
      );
    watcher.on('change', check);
    watcher.on('error', (error) => finish(error));
    started.exited.then(({ code, signal }) =>
      finish(new Error(`\`${started.command}\` exited (${code ?? signal}) before ${path} held "${text}"`)),
    );
    check();
  });
}

/** The room's name in the fragment of a board's link. */
function roomOf(link) {
  return new URLSearchParams(link.hash.slice(1)).get('room');
}

const steps = [];
let lan;
let listener;
let browser;
let client;
try {
  // Run the local mode: each command of its block runs to its end, but the last, which serves until Ctrl-C.
  const [localMode] = shellBlocks(section('Run the local mode'));
  assert.ok(localMode !== undefined && localMode.length > 0, "Run the local mode doesn't hold an sh block");
  for (const command of localMode.slice(0, -1)) run(command);
  // The browser this script drives, which the guide leaves to the person: the version package-lock.json pins.
  const installed = spawnSync('npx', ['playwright', 'install', 'chromium'], {
    cwd: join(ROOT, 'packages/lan'),
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  assert.equal(installed.status, 0, "Playwright didn't install Chromium");
  lan = start(localMode[localMode.length - 1]);
  const served = lan;
  const local = await within(
    new Promise((resolve, reject) => {
      const printed = [];
      eachLine(served.child.stdout, (line) => {
        const address = /^\s+(http:\/\/\S+)$/.exec(line);
        if (address === null) return;
        printed.push(address[1]);
        if (address[1].startsWith('http://localhost:')) resolve({ address: address[1], printed });
      });
      served.exited.then(({ code, signal }) =>
        reject(new Error(`\`${served.command}\` exited (${code ?? signal}) before it printed a localhost address`)),
      );
    }),
    'the local mode to print its addresses',
  );

  const { chromium } = await import('playwright');
  const chrome = await chromium.launch();
  browser = chrome;

  /** Opens a page in a new context of the browser, with page.js loaded before the page's own scripts. */
  const newPage = async (name) => {
    const context = await chrome.newContext({ viewport: { width: 1200, height: 800 } });
    await context.addInitScript({ path: PAGE_SCRIPT });
    const page = await context.newPage();
    page.on('console', (message) => console.log(`[${name} console.${message.type()}] ${message.text()}`));
    page.on('pageerror', (error) => console.log(`[${name} page error] ${error.message}`));
    return page;
  };
  /** Resolves with the room that the page in `page` joined, once its board has started. */
  const joined = (page) => page.evaluate(async () => (await window.chalklineReady).room);
  /** Opens `address`, presses New board on its join screen, and resolves with the board's link from the address bar. */
  const newBoard = async (page, address) => {
    await page.goto(address);
    await page.locator('.join-screen').waitFor({ timeout: WAIT_MS });
    await page.getByRole('button', { name: 'New board', exact: true }).click();
    const room = await joined(page);
    const link = new URL(page.url());
    assert.equal(roomOf(link), room, `the address bar's link ${link.href} doesn't name the room the page joined`);
    assert.ok((new URLSearchParams(link.hash.slice(1)).get('key') ?? '') !== '', `${link.href} doesn't hold a password`);
    return link;
  };
  /** Waits until `page` shows each of `expected`, as page.js reads the scene, and keeps a screenshot either way. */
  const shownIn = async (page, name, expected) => {
    try {
      return await page.evaluate(
        (arg) => window.chalklineE2e.shown(arg.expected, arg.creator, arg.waitMs),
        { expected, creator: CLIENT, waitMs: WAIT_MS },
      );
    } finally {
      await page.screenshot({ path: join(SCREENSHOTS, `readme-${name}.png`) }).catch(() => undefined);
    }
  };

  const first = await newPage('first');
  const link = await within(newBoard(first, local.address), `${local.address} to start a new board`);
  assert.equal(link.searchParams.get('relay'), '/relay', `${link.href} doesn't name the machine's relay`);
  assert.ok(!link.href.includes("'"), `${link.href} holds a quote, which the guide's commands put it between`);
  const second = await newPage('second');
  await second.goto(link.href);
  assert.equal(await within(joined(second), 'the second browser to join the board'), roomOf(link));
  steps.push(
    `Run the local mode: \`${localMode.join('` and `')}\` served the board at ${local.printed.join(', ')}; ` +
      `New board at ${local.address} opened ${link.href}, which a second browser context joined.`,
  );

  // Open a board: the address of the guide's first step, which serves the main branch's build.
  const publicAddress = /Open (https:\/\/\S+) and press New board/.exec(section('Open a board'))?.[1];
  assert.ok(publicAddress !== undefined, "Open a board doesn't say to open an address and press New board");
  const visitor = await newPage('public');
  const publicLink = await within(newBoard(visitor, publicAddress), `${publicAddress} to start a new board`);
  await visitor.screenshot({ path: join(SCREENSHOTS, 'readme-public.png') }).catch(() => undefined);
  await visitor.context().close();
  steps.push(`Open a board: New board at ${publicAddress} joined room ${roomOf(publicLink)}.`);

  // Connect an agent: each command of its block, with the local board's link where the guide writes one.
  const agent = section('Connect an agent');
  const [setup] = shellBlocks(agent);
  assert.ok(setup !== undefined && setup.length > 0, "Connect an agent doesn't hold an sh block");
  const commands = setup.map((line) => line.replaceAll(LINK, link.href));
  for (const command of commands) {
    if (ran.has(command)) console.log(`(\`${command}\` ran already in this checkout)`);
    else run(command);
  }
  const added = commands
    .map((command) => /^claude mcp add\b.*?\s(\S+)\s--\s(.+)$/.exec(command))
    .find((match) => match !== null);
  assert.ok(added !== undefined, "Connect an agent doesn't run `claude mcp add <name> -- <command>`");
  const [, server, serverCommand] = added;
  // The words bash passes to `claude mcp add` after its --, which Claude Code starts the server with.
  const words = spawnSync('bash', ['-c', `printf '%s\\0' ${serverCommand}`], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(words.status, 0, `bash didn't read the words of ${serverCommand}`);
  const [command, ...args] = words.stdout.split('\0').slice(0, -1);
  assert.ok(command !== undefined && args.length > 0, `${serverCommand} doesn't hold a command and its arguments`);
  const listed = output(`claude mcp get ${server}`);
  assert.ok(listed.includes(args[0]), `\`claude mcp get ${server}\` doesn't list ${args[0]}`);

  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
  const agentClient = new Client({ name: CLIENT, version: '0.0.0' });
  client = agentClient;
  await within(agentClient.connect(new StdioClientTransport({ command, args, cwd: ROOT })), 'the helper to start');
  const label = 'Added by the agent';
  const answer = await within(
    agentClient.callTool({
      name: 'add_shapes',
      arguments: { shapes: [{ type: 'rectangle', x: 100, y: 100, width: 260, height: 80, label: { text: label } }] },
    }),
    'add_shapes to answer',
  );
  assert.notEqual(answer.isError, true, `add_shapes: ${JSON.stringify(answer.content)}`);
  const [id] = answer.structuredContent?.ids ?? [];
  assert.equal(typeof id, 'string', `add_shapes answered ${JSON.stringify(answer.structuredContent)}`);
  const expected = [{ id, type: 'rectangle', label }];
  const wanted = [{ id, type: 'rectangle', label, creator: { kind: 'agent', name: CLIENT }, start: null, end: null }];
  for (const [name, page] of [
    ['first', first],
    ['second', second],
  ]) {
    assert.deepEqual(await shownIn(page, name, expected), wanted, `the ${name} browser`);
  }
  steps.push(
    `Connect an agent: \`claude mcp get ${server}\` listed the server, and the helper that \`${command} ${args.join(' ')}\` ` +
      `starts added rectangle ${id}, labelled "${label}", which both browsers showed as the agent's.`,
  );

  // The listener, which the guide asks Claude Code's Monitor tool to run: its command, from the section's code span.
  const listenCommand = /`(node [^`]*\slisten\s[^`]*)`/.exec(agent)?.[1];
  assert.ok(listenCommand !== undefined, "Connect an agent doesn't hold the listener's command");
  const listening = listenCommand.replaceAll(LINK, link.href);
  const logName = /2>>\s*(\S+)$/.exec(listening)?.[1];
  assert.ok(logName !== undefined, `${listening} doesn't add its log to a file`);
  const logPath = join(ROOT, logName);
  // The command adds its log to the file, so an empty file is there to watch before it starts.
  await writeFile(logPath, '');
  listener = start(listening);
  const heard = listener;
  await within(fileHolds(logPath, `listening in room ${roomOf(link)}`, heard), 'the listener to start listening');
  const said = {
    id: `readme-${randomBytes(6).toString('hex')}`,
    speaker: 'Ada',
    at: new Date().toISOString(),
    text: 'draw a smiley face in blue',
  };
  const printedLine = within(
    new Promise((resolve, reject) => {
      eachLine(heard.child.stdout, (printed) => {
        try {
          resolve(JSON.parse(printed));
        } catch {
          reject(new Error(`the listener printed a line that isn't JSON: ${printed}`));
        }
      });
      heard.exited.then(({ code, signal }) => reject(new Error(`the listener exited (${code ?? signal}) before it printed a line`)));
    }),
    'the listener to print what was said',
  );
  // A person's speech reaches the board's transcript this way, from their page.
  await first.evaluate(async (entry) => {
    (await window.chalklineReady).transcript.push([entry]);
  }, said);
  assert.deepEqual(await printedLine, { at: said.at, speakers: [said.speaker], text: said.text });
  steps.push(`The listener: \`${listenCommand}\` printed "${said.text}" from ${said.speaker} after the first browser added it to the transcript.`);

  console.log(`The README's steps ran:\n${steps.map((step) => `- ${step}`).join('\n')}`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    await appendFile(process.env.GITHUB_STEP_SUMMARY, `## The README's steps\n\n${steps.map((step) => `- ${step}`).join('\n')}\n`);
  }
} catch (error) {
  process.exitCode = 1;
  console.error(`The README's steps failed: ${error instanceof Error ? error.stack : error}`);
  if (steps.length > 0) console.error(`The steps that ran before it:\n${steps.map((step) => `- ${step}`).join('\n')}`);
} finally {
  await client?.close().catch(() => undefined);
  await listener?.stop('SIGTERM');
  await browser?.close().catch(() => undefined);
  if (lan !== undefined) await within(lan.stop('SIGINT'), 'the local mode to stop').catch((error) => console.error(error.message));
}
// The file watcher and the browser's pipes may hold the event loop, so the script ends here.
process.exit(process.exitCode ?? 0);
