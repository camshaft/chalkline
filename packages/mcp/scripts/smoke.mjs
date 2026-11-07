// Runs the built chalkline-mcp as an agent client runs it: starts it over stdio on a new room's
// link and checks the tools it lists. It adds a labelled rectangle and an ellipse with add_shapes,
// connects them with a labelled arrow, moves the ellipse with update_shape, and asks for a Mermaid
// diagram with add_mermaid, which answers pending since no page is in the new room. It reads the
// request back with get_request, and the shapes, their creator and the pending request with
// get_board, then deletes the arrow with delete_shapes. CI runs it after the build.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const helper = fileURLToPath(new URL('../dist/chalkline-mcp.mjs', import.meta.url));
const room = randomBytes(8).toString('hex');
const key = randomBytes(16).toString('hex');
const link = `https://camshaft.github.io/chalkline/#room=${room}&key=${key}`;

const client = new Client({ name: 'chalkline-smoke', version: '0.0.0' });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [helper, link] }));

/** Calls a tool, checks that it didn't refuse the call, and returns its structured content. */
async function call(name, args) {
  const result = await client.callTool({ name, arguments: args });
  assert.notEqual(result.isError, true, `${name}: ${JSON.stringify(result.content)}`);
  return result.structuredContent;
}

const { tools } = await client.listTools();
assert.deepEqual(tools.map((tool) => tool.name).sort(), [
  'add_mermaid',
  'add_shapes',
  'connect',
  'delete_shapes',
  'get_board',
  'get_request',
  'update_shape',
]);

const added = await call('add_shapes', {
  shapes: [
    { type: 'rectangle', x: 0, y: 0, width: 240, height: 80, label: { text: 'Smoke test' } },
    { type: 'ellipse', x: 400, y: 0, width: 160, height: 80, label: { text: 'Next' } },
  ],
});
const [id, next] = added.ids;

const { id: arrow } = await call('connect', { start: id, end: next, label: { text: 'then' } });
const moved = await call('update_shape', { id: next, y: 200 });
assert.equal(moved.shape.y, 200);

const asked = await call('add_mermaid', { text: 'flowchart LR\n  A[Smoke] --> B[test]' });
assert.equal(asked.status, 'pending');
const request = await call('get_request', { id: asked.id });
assert.equal(request.status, 'pending');

const board = await call('get_board', {});
const byId = (shapes, wanted) => shapes.find((candidate) => candidate.id === wanted);
const shape = byId(board.shapes, id);
assert.equal(shape?.kind, 'rectangle');
assert.equal(shape?.label, 'Smoke test');
assert.deepEqual(shape?.creator, { kind: 'agent', name: 'chalkline-smoke' });
assert.equal(byId(board.shapes, next)?.y, 200);
const connected = byId(board.shapes, arrow);
assert.equal(connected?.kind, 'arrow');
assert.equal(connected?.start, id);
assert.equal(connected?.end, next);
assert.equal(connected?.label, 'then');
assert.deepEqual(board.pending, [{ id: asked.id, kind: 'mermaid' }]);

const deleted = await call('delete_shapes', { ids: [arrow] });
assert.deepEqual(deleted.ids, [arrow]);
const after = await call('get_board', {});
assert.equal(byId(after.shapes, arrow), undefined);
assert.equal(after.shapes.some((candidate) => candidate.label === 'then'), false);

await client.close();
console.log(
  `chalkline-mcp added ${id} labelled "Smoke test" and ${next}, connected them with ${arrow}, moved ${next}, deleted ${arrow}, wrote the Mermaid request ${asked.id}, and read each back`,
);
