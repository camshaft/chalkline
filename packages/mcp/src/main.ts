// chalkline-mcp: joins the Chalkline board that its link opens, and serves the agent's tools on it
// as a local MCP server over standard input and output.
import './log';
import { parseArgs } from 'node:util';
import {
  APP_ID,
  Awareness,
  connectAwareness,
  connectDoc,
  parseRoomFragment,
  relaysFromAddress,
  trysteroTransport,
  type RoomSecrets,
} from '@chalkline/sync';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import * as Y from 'yjs';
import { createServer } from './server';
import { loadExcalidraw } from './skeleton';

const USAGE = `Usage: chalkline-mcp <board link>

Joins the Chalkline board that the link opens, and serves the agent's tools on it as a local MCP
server over standard input and output: get_board reads the board, add_shapes draws on it,
connect draws an arrow between two of its shapes, update_shape changes a shape, delete_shapes
deletes shapes, add_mermaid asks a page of the board to draw a Mermaid diagram, whose request
get_request reads, and read_transcript reads what the people on the board said.
The link is the board's address, with its #room=<name>&key=<password> fragment, and with its
?relay= parameters where the board's participants meet through a relay. Each line the helper
logs goes to standard error.

Options:
  --help  print this text`;

function roomOf(link: string): RoomSecrets {
  let address: URL;
  try {
    address = new URL(link);
  } catch {
    throw new Error(`${link} isn't a link.\n\n${USAGE}`);
  }
  const secrets = parseRoomFragment(address.hash);
  if (secrets === null) throw new Error(`The link lacks the #room=<name>&key=<password> fragment.\n\n${USAGE}`);
  return secrets;
}

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
  const secrets = roomOf(link);
  const relays = relaysFromAddress(link);

  // The server answers the client at once, and its tools work on the helper's copy of the board
  // while the helper joins the room.
  const doc = new Y.Doc();
  // The helper doesn't show in the room's presence: it reads the pages' awareness states to learn
  // whether a page is in the room to convert a Mermaid request.
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
    { appId: APP_ID, password: secrets.key, rtcPolyfill: PeerConnection as unknown as typeof RTCPeerConnection },
    secrets.room,
    relays,
    { onJoinError: ({ peerId, error }) => console.error(`${peerId} couldn't connect: ${error}`) },
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
    `joined room ${secrets.room} through ${relays.length > 0 ? relays.join(', ') : 'the public Nostr relays'}`,
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
