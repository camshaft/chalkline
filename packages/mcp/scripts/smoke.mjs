// Runs the built chalkline-mcp as an agent client runs it: starts it over stdio on a new room's
// link, checks the tools it lists, adds a labelled rectangle with add_shapes, and reads it back
// with get_board. CI runs it after the build.
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

const { tools } = await client.listTools();
assert.deepEqual(tools.map((tool) => tool.name).sort(), ['add_shapes', 'get_board']);

const added = await client.callTool({
  name: 'add_shapes',
  arguments: { shapes: [{ type: 'rectangle', x: 0, y: 0, width: 240, height: 80, label: { text: 'Smoke test' } }] },
});
assert.notEqual(added.isError, true, JSON.stringify(added.content));
const [id] = added.structuredContent.ids;

const board = await client.callTool({ name: 'get_board', arguments: {} });
assert.notEqual(board.isError, true, JSON.stringify(board.content));
const shape = board.structuredContent.shapes.find((candidate) => candidate.id === id);
assert.equal(shape?.kind, 'rectangle');
assert.equal(shape?.label, 'Smoke test');

await client.close();
console.log(`chalkline-mcp added the rectangle ${id} labelled "Smoke test" and read it back with get_board`);
