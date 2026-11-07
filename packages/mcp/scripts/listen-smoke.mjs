// Runs the built `chalkline-mcp listen` as an agent client's background tool runs it. It checks
// that `listen --help` prints its usage, with the feedback line. Then it bundles and starts
// test/feedback-peer.ts, a second participant that serves a relay on 127.0.0.1 and prints a new
// board's link through it, starts the listener on that link with standard input closed, and waits
// for its log line that says it listens. As the listener connects, the participant writes a
// feedback, and the script waits for the listener's line for it and checks the line's fields.
// Last, it stops the listener with SIGTERM, and checks that it left with exit code 0 and printed
// that line alone. CI runs it after the build, with smoke.mjs.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const mcp = fileURLToPath(new URL('..', import.meta.url));
const helper = fileURLToPath(new URL('../dist/chalkline-mcp.mjs', import.meta.url));
const peerFile = fileURLToPath(new URL('../dist/test/feedback-peer.mjs', import.meta.url));
/** How long the script waits for each line, in milliseconds: a join through the relay takes some seconds. */
const WAIT_MS = 60_000;

const usage = execFileSync(process.execPath, [helper, 'listen', '--help'], { encoding: 'utf8' });
assert.match(usage, /^Usage: chalkline-mcp listen <board link>/);
assert.ok(usage.includes('{"at", "kind": "feedback", "id", "by", "text", "shapes"}'), usage);

// The participant runs in a process of its own, as the listener does, since Trystero keeps one
// peer id for each process.
await build({
  absWorkingDir: mcp,
  entryPoints: ['test/feedback-peer.ts'],
  outfile: 'dist/test/feedback-peer.mjs',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  external: ['werift', '@trystero-p2p/*'],
  // Bundled CommonJS code calls `require`, which an ES module lacks.
  banner: {
    js: "import { createRequire as chalklineCreateRequire } from 'node:module'; const require = chalklineCreateRequire(import.meta.url);",
  },
  logLevel: 'warning',
});

/** Starts `file` with `args` and standard input closed, and keeps what it prints. */
function start(name, file, args) {
  const child = spawn(process.execPath, [file, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  const started = { name, child, stdout: '', stderr: '', changed: new Set() };
  for (const stream of ['stdout', 'stderr']) {
    child[stream].setEncoding('utf8').on('data', (chunk) => {
      started[stream] += chunk;
      for (const check of [...started.changed]) check();
    });
  }
  started.exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
  return started;
}

/** The JSON objects of the whole lines of `text` that hold one. */
function objects(text) {
  return text
    .split('\n')
    .slice(0, -1)
    .flatMap((line) => {
      try {
        const value = JSON.parse(line);
        return typeof value === 'object' && value !== null ? [value] : [];
      } catch {
        return [];
      }
    });
}

/**
 * Resolves with what `find` reads from the output of `started` once it reads a value, and rejects
 * where `started` exits first or WAIT_MS passes.
 */
function until(started, what, find) {
  return new Promise((resolve, reject) => {
    const done = () => {
      clearTimeout(timer);
      started.changed.delete(check);
    };
    const check = () => {
      const found = find(started);
      if (found === undefined) return;
      done();
      resolve(found);
    };
    const timer = setTimeout(() => {
      done();
      reject(new Error(`${what} didn't come within ${WAIT_MS / 1000} s`));
    }, WAIT_MS);
    started.changed.add(check);
    started.exited.then(({ code, signal }) => {
      done();
      reject(new Error(`${started.name} exited (${code ?? signal}) before ${what}`));
    });
    check();
  });
}

const peer = start('the participant', peerFile, []);
let listener;
try {
  const { link } = await until(peer, "the participant's link", ({ stdout }) =>
    objects(stdout).find((value) => typeof value.link === 'string'),
  );
  const room = new URLSearchParams(new URL(link).hash.slice(1)).get('room');
  listener = start('the listener', helper, ['listen', link]);
  await until(listener, 'the log line that says it listens', ({ stderr }) =>
    stderr.includes(`listening in room ${room}`) ? true : undefined,
  );
  const { feedback } = await until(peer, 'the feedback', ({ stdout }) =>
    objects(stdout).find((value) => value.feedback !== undefined),
  );
  const line = await until(listener, "the feedback's line", ({ stdout }) =>
    objects(stdout).find((value) => value.kind === 'feedback'),
  );
  assert.deepEqual(line, {
    at: feedback.at,
    kind: 'feedback',
    id: feedback.id,
    by: feedback.by,
    text: feedback.text,
    shapes: feedback.shapes,
  });

  listener.child.kill('SIGTERM');
  const { code, signal } = await listener.exited;
  assert.equal(signal, null, listener.stderr);
  assert.equal(code, 0, listener.stderr);
  assert.equal(listener.stdout, `${JSON.stringify(line)}\n`);
} catch (error) {
  console.error(`the participant's output:\n${peer.stdout}${peer.stderr}`);
  if (listener !== undefined) console.error(`the listener's output:\n${listener.stdout}${listener.stderr}`);
  throw error;
} finally {
  if (listener !== undefined && listener.child.exitCode === null && listener.child.signalCode === null) {
    listener.child.kill('SIGTERM');
  }
  peer.child.kill('SIGTERM');
  const forced = setTimeout(() => peer.child.kill('SIGKILL'), WAIT_MS);
  await peer.exited;
  clearTimeout(forced);
}
console.log(
  'chalkline-mcp listen printed its usage, listened in a new room, printed the line of a feedback written there, and left on SIGTERM',
);
