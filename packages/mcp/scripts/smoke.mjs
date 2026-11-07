// Runs the built chalkline-mcp as an agent client runs it: starts it over stdio on a new room's
// link, checks the tools it lists, adds a labelled rectangle with add_shapes, and asks for a
// Mermaid diagram with add_mermaid, which answers pending since no page is in the new room. It reads
// the request back with get_request, and the rectangle and the pending request with get_board. It
// then reads the empty transcript as the resource chalkline://transcript, subscribes to it, and
// checks that read_transcript refuses a cursor past the transcript's end. CI runs it after the
// build.
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
assert.deepEqual(tools.map((tool) => tool.name).sort(), ['add_mermaid', 'add_shapes', 'get_board', 'get_request', 'read_transcript']);

const added = await client.callTool({
  name: 'add_shapes',
  arguments: { shapes: [{ type: 'rectangle', x: 0, y: 0, width: 240, height: 80, label: { text: 'Smoke test' } }] },
});
assert.notEqual(added.isError, true, JSON.stringify(added.content));
const [id] = added.structuredContent.ids;

const asked = await client.callTool({ name: 'add_mermaid', arguments: { text: 'flowchart LR\n  A[Smoke] --> B[test]' } });
assert.notEqual(asked.isError, true, JSON.stringify(asked.content));
assert.equal(asked.structuredContent.status, 'pending');
const request = await client.callTool({ name: 'get_request', arguments: { id: asked.structuredContent.id } });
assert.notEqual(request.isError, true, JSON.stringify(request.content));
assert.equal(request.structuredContent.status, 'pending');

const board = await client.callTool({ name: 'get_board', arguments: {} });
assert.notEqual(board.isError, true, JSON.stringify(board.content));
const shape = board.structuredContent.shapes.find((candidate) => candidate.id === id);
assert.equal(shape?.kind, 'rectangle');
assert.equal(shape?.label, 'Smoke test');
assert.deepEqual(board.structuredContent.pending, [{ id: asked.structuredContent.id, kind: 'mermaid' }]);

const transcript = await client.readResource({ uri: 'chalkline://transcript' });
assert.deepEqual(JSON.parse(transcript.contents[0].text), { entries: [], cursor: 0 });
await client.subscribeResource({ uri: 'chalkline://transcript' });
const past = await client.callTool({ name: 'read_transcript', arguments: { cursor: 1 } });
assert.equal(past.isError, true, JSON.stringify(past.content));

await client.close();
console.log(
  `chalkline-mcp added the rectangle ${id} labelled "Smoke test", wrote the Mermaid request ${asked.structuredContent.id}, read both back, and read the empty transcript`,
);
