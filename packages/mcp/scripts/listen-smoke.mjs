// Runs the built `chalkline-mcp listen` as an agent client's background tool runs it: checks that
// `listen --help` prints its usage, then starts it on a new room's link with standard input closed,
// waits for its log line that says it listens, stops it with SIGTERM, and checks that it left with
// exit code 0 and printed nothing, since no one in the new room said anything. CI runs it after
// the build, with smoke.mjs.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const helper = fileURLToPath(new URL('../dist/chalkline-mcp.mjs', import.meta.url));

const usage = execFileSync(process.execPath, [helper, 'listen', '--help'], { encoding: 'utf8' });
assert.match(usage, /^Usage: chalkline-mcp listen <board link>/);

const room = randomBytes(8).toString('hex');
const key = randomBytes(16).toString('hex');
const link = `https://camshaft.github.io/chalkline/#room=${room}&key=${key}`;

const listener = spawn(process.execPath, [helper, 'listen', link], { stdio: ['ignore', 'pipe', 'pipe'] });
let stdout = '';
let stderr = '';
listener.stdout.setEncoding('utf8').on('data', (chunk) => {
  stdout += chunk;
});
const exited = new Promise((resolve) => listener.once('exit', (code, signal) => resolve({ code, signal })));
await new Promise((resolve, reject) => {
  listener.stderr.setEncoding('utf8').on('data', (chunk) => {
    stderr += chunk;
    if (stderr.includes(`listening in room ${room}`)) resolve();
  });
  exited.then(({ code, signal }) => reject(new Error(`the listener exited (${code ?? signal}) before it listened:\n${stderr}`)));
});

listener.kill('SIGTERM');
const { code, signal } = await exited;
assert.equal(signal, null, stderr);
assert.equal(code, 0, stderr);
assert.equal(stdout, '');
console.log('chalkline-mcp listen printed its usage, listened in a new room, and left on SIGTERM');
