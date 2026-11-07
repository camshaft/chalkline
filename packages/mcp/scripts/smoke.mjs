// Runs the built chalkline-mcp as an agent client runs it: starts it over stdio on a new room's
// link and checks the tools it lists. It adds a labelled rectangle and an ellipse with add_shapes,
// moves the ellipse to the back with reorder_shapes, connects them with a labelled arrow, moves the
// ellipse with update_shape, and asks for a Mermaid diagram with add_mermaid, which answers pending
// since no page is in the new room. It reads the request back with get_request, and the shapes,
// their order, their creator and the pending request with get_board, then deletes the arrow with
// delete_shapes, brings it back with undo_change, which then refuses the same change, deletes it
// again, adds a freehand stroke, and draws the board as a PNG with render_board, and checks
// that the helper's log doesn't hold the error of a stroke left out. It reads the board's changes from
// the start with read_changes, then reads the empty transcript as the resource
// chalkline://transcript, subscribes to it, and checks that read_transcript refuses a cursor past
// the transcript's end. It posts a message in the board's chat with post_message and reads it
// back with read_transcript. It reads the empty feedback resource chalkline://feedback,
// subscribes to it, and checks that get_board doesn't list a feedback and that answer_feedback refuses
// an id the board doesn't hold. Last, it saves a snapshot mark with save_snapshot and reads it back
// with list_snapshots. CI runs it after the build.
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
const transport = new StdioClientTransport({ command: process.execPath, args: [helper, link], stderr: 'pipe' });
// The helper's log, which the smoke test passes on to its own standard error, and reads.
let log = '';
transport.stderr?.on('data', (chunk) => {
  process.stderr.write(chunk);
  log += chunk;
});
await client.connect(transport);

/** Calls a tool, checks that it didn't refuse the call, and returns its structured content. */
async function call(name, args) {
  const result = await client.callTool({ name, arguments: args });
  assert.notEqual(result.isError, true, `${name}: ${JSON.stringify(result.content)}`);
  return result.structuredContent;
}

const { tools } = await client.listTools();
assert.deepEqual(tools.map((tool) => tool.name).sort(), [
  'add_image',
  'add_mermaid',
  'add_shapes',
  'answer_feedback',
  'connect',
  'delete_shapes',
  'flatten',
  'get_board',
  'get_request',
  'list_snapshots',
  'post_message',
  'read_changes',
  'read_feedback',
  'read_transcript',
  'render_board',
  'reorder_shapes',
  'save_snapshot',
  'scale_shapes',
  'undo_change',
  'update_shape',
]);

const added = await call('add_shapes', {
  shapes: [
    { type: 'rectangle', x: 0, y: 0, width: 240, height: 80, label: { text: 'Smoke test' } },
    { type: 'ellipse', x: 400, y: 0, width: 160, height: 80, label: { text: 'Next' } },
  ],
});
const [id, next] = added.ids;
const back = await call('reorder_shapes', { ids: [next], place: 'back' });
assert.deepEqual(back.ids, [next]);

const { id: arrow } = await call('connect', { start: id, end: next, label: { text: 'then' } });
const moved = await call('update_shape', { id: next, y: 200 });
assert.equal(moved.shape.y, 200);

const asked = await call('add_mermaid', { text: 'flowchart LR\n  A[Smoke] --> B[test]' });
assert.equal(asked.status, 'pending');
const request = await call('get_request', { id: asked.id });
assert.equal(request.status, 'pending');

const board = await call('get_board', {});
const byId = (shapes, wanted) => shapes.find((candidate) => candidate.id === wanted);
assert.deepEqual(board.shapes.map((candidate) => candidate.id), [next, id, arrow]);
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
assert.equal(typeof deleted.change, 'string');
// undo_change brings the arrow back, refuses the same change once someone undid it, and
// delete_shapes then deletes the arrow again.
const undone = await call('undo_change', { id: deleted.change });
assert.ok(undone.restored.includes(arrow), JSON.stringify(undone));
assert.equal(byId((await call('get_board', {})).shapes, arrow)?.kind, 'arrow');
const again = await client.callTool({ name: 'undo_change', arguments: { id: deleted.change } });
assert.equal(again.isError, true, JSON.stringify(again.content));
assert.deepEqual((await call('delete_shapes', { ids: [arrow] })).ids, [arrow]);
const after = await call('get_board', {});
assert.equal(byId(after.shapes, arrow), undefined);
assert.equal(after.shapes.some((candidate) => candidate.label === 'then'), false);

// A freehand stroke between the two shapes, which Excalidraw draws only with a Path2D.
const {
  ids: [stroke],
} = await call('add_shapes', {
  shapes: [{ type: 'freedraw', x: 300, y: 100, points: [[0, 0], [20, 10], [40, 0], [60, 10]] }],
});

// The rectangle and the moved ellipse span 0 to 560 across and 0 to 280 down, the stroke lies
// between them, and the picture of the whole board leaves a margin of 10 around them.
const drawn = await client.callTool({ name: 'render_board', arguments: {} });
assert.notEqual(drawn.isError, true, `render_board: ${JSON.stringify(drawn.content)}`);
const image = drawn.content.find((part) => part.type === 'image');
assert.equal(image?.mimeType, 'image/png');
assert.deepEqual([...Buffer.from(image.data, 'base64').subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
assert.deepEqual(drawn.structuredContent, {
  region: { x: -10, y: -10, width: 580, height: 300 },
  width: 1024,
  height: 530,
});
// Excalidraw logs each shape it leaves out of the picture with the error it met, which was a
// ReferenceError for each freehand stroke while jsdom didn't define Path2D.
assert.doesNotMatch(log, /ReferenceError/);

// From the start, read_changes lists the three shapes the board holds as added, in get_board's order,
// each with the agent as its creator, and leaves out the arrow, which was added and deleted since.
const changes = await call('read_changes', {});
assert.deepEqual(
  changes.changes.map((change) => [change.change, change.id, change.creator?.name]),
  [
    ['added', next, 'chalkline-smoke'],
    ['added', id, 'chalkline-smoke'],
    ['added', stroke, 'chalkline-smoke'],
  ],
);

const transcript = await client.readResource({ uri: 'chalkline://transcript' });
assert.deepEqual(JSON.parse(transcript.contents[0].text), { entries: [], cursor: 0 });
await client.subscribeResource({ uri: 'chalkline://transcript' });
const past = await client.callTool({ name: 'read_transcript', arguments: { cursor: 1 } });
assert.equal(past.isError, true, JSON.stringify(past.content));
const { entry: posted } = await call('post_message', { text: 'Smoke test message' });
assert.equal(posted.speaker, 'chalkline-smoke');
assert.equal(posted.text, 'Smoke test message');
assert.equal(posted.via, 'agent');
assert.deepEqual(await call('read_transcript', { cursor: 0 }), { entries: [posted], cursor: 1 });

const feedback = await client.readResource({ uri: 'chalkline://feedback' });
assert.deepEqual(JSON.parse(feedback.contents[0].text), { feedback: [], cursor: 0 });
await client.subscribeResource({ uri: 'chalkline://feedback' });
assert.deepEqual((await call('get_board', {})).feedback, []);
const unknown = await client.callTool({
  name: 'answer_feedback',
  arguments: { id: 'missing', text: 'Smoke test answer' },
});
assert.equal(unknown.isError, true, JSON.stringify(unknown.content));

// save_snapshot writes a mark with the agent's name, the label and the board's shape count, which
// list_snapshots reads back.
const { mark: saved } = await call('save_snapshot', { label: 'Smoke test snapshot' });
assert.equal(saved.by, 'chalkline-smoke');
assert.equal(saved.label, 'Smoke test snapshot');
assert.equal(saved.shapes, changes.changes.length);
assert.deepEqual((await call('list_snapshots', {})).marks, [saved]);

await client.close();
console.log(
  `chalkline-mcp added ${id} labelled "Smoke test" and ${next}, connected them with ${arrow}, moved ${next}, deleted ${arrow}, added the freehand stroke ${stroke}, drew the board as a PNG of ${drawn.structuredContent.width} by ${drawn.structuredContent.height} pixels, wrote the Mermaid request ${asked.id}, read each back, read the board's ${changes.changes.length} changes, read the empty transcript, and posted the message ${posted.id} in the chat and read it back, read the empty feedback, and saved the snapshot mark ${saved.id} and read it back`,
);
