// chalkline-mcp: joins the Chalkline board that its link opens, and serves the agent's tools on it
// as a local MCP server over standard input and output.
import './log';
import { parseArgs } from 'node:util';
import {
  Awareness,
  connectAwareness,
  connectDoc,
  trysteroTransport,
} from '@chalkline/sync';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import * as Y from 'yjs';
import { joinConfig, joinErrorLine, readBoardLink, routeText } from './board-link';
import { runListen } from './listen-cli';
import { createServer } from './server';
import { loadExcalidraw } from './skeleton';

const USAGE = `Usage: chalkline-mcp <board link>

Joins the Chalkline board that the link opens, and serves the agent's tools on it as a local MCP
server over standard input and output: get_board reads the board, render_board draws it as a
picture, add_shapes draws on it, connect draws an arrow between two of its shapes, update_shape
changes a shape, delete_shapes deletes shapes, reorder_shapes moves shapes forward or back,
scale_shapes makes shapes smaller or larger, add_mermaid asks a page of the board to draw a
Mermaid diagram, whose request get_request reads, read_changes reads the shapes added, changed
and deleted on the board, read_transcript reads what the people on the board said and typed,
post_message posts a message in the board's chat, read_feedback reads the feedback people
write on areas of the board, and answer_feedback answers one.
The link is the board's address, with its #room=<name>&key=<password> fragment, and with its
?relay= parameters where the board's participants meet through a relay. Where its fragment
holds a turn parameter, as the page's Copy link with TURN servers writes it, the helper
connects to the board's peers through the TURN servers it lists. Each line the helper logs
goes to standard error.

Options:
  --help  print this text

chalkline-mcp listen <board link> joins the board too, and prints on standard output one JSON
line for each group of words people on the board say, each text they write and each sketch they
draw, for an agent client that turns each line a command prints into a message to its agent,
such as Claude Code's Monitor tool: chalkline-mcp listen --help says more.`;

/** Resolves once the client closes the helper's standard input, or the helper is stopped. */
function ended(): Promise<void> {
  return new Promise((resolve) => {
    process.stdin.once('end', () => resolve());
    process.stdin.once('close', () => resolve());
    process.once('SIGINT', () => resolve());
    process.once('SIGTERM', () => resolve());
  });
}

async function main(): Promise<void> {
  // `chalkline-mcp listen` prints what people on the board say, in place of serving the tools.
  if (process.argv[2] === 'listen') return runListen(process.argv.slice(3));
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { help: { type: 'boolean', default: false } },
  });
  if (values.help) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  if (positionals.length !== 1) throw new Error(USAGE);
  const [link] = positionals;
  const board = readBoardLink(link, USAGE);

  // The server answers the client at once, and its tools work on the helper's copy of the board
  // while the helper joins the room.
  const doc = new Y.Doc();
  // The helper shows nothing in the room's presence until its client initializes, and then its client's
  // name, its status and a pointer at the shapes it last drew (presence.ts). It reads the pages'
  // awareness states too, to learn whether a page is in the room to convert a Mermaid request.
  const awareness = new Awareness(doc);
  awareness.setLocalState(null);
  const server = createServer(doc, awareness);
  const closed = ended();
  await server.connect(new StdioServerTransport());

  // Excalidraw loads with jsdom, and Trystero after it, as draw-box loads them.
  await loadExcalidraw();
  const werift = await import('werift');
  const PeerConnection =
    werift.RTCPeerConnection ?? (werift as unknown as { default: typeof werift }).default.RTCPeerConnection;
  const { joinBoardRoom } = await import('@chalkline/sync/join');
  const room = joinBoardRoom(
    joinConfig(board, PeerConnection as unknown as typeof RTCPeerConnection),
    board.room.room,
    board.relays,
    { onJoinError: ({ peerId, error }) => console.error(joinErrorLine(board, peerId, String(error))) },
  );
  const transport = trysteroTransport(room);
  connectDoc(doc, transport, {
    onSynced: (peerId) => console.error(`synced with ${peerId}`),
    onSendError: (error) => console.error('a send failed:', error),
  });
  connectAwareness(awareness, transport, {
    onSendError: (error) => console.error('an awareness send failed:', error),
  });
  transport.onPeerJoin((peerId) => console.error(`connected to ${peerId}`));
  transport.onPeerLeave((peerId) => console.error(`${peerId} left`));
  console.error(
    `joined room ${board.room.room} through ${routeText(board)}`,
  );

  await closed;
  await server.close();
  await room.leave();
  awareness.destroy();
}

main().then(
  () => process.exit(0),
  (error: unknown) => {
    console.error(error instanceof Error ? (error.stack ?? error.message) : error);
    process.exit(1);
  },
);
