// The second participant of scripts/listen-smoke.mjs, which bundles this file and runs it in a
// process of its own. It serves a WebSocket relay on a free port of 127.0.0.1, as the local-network
// mode does, prints on standard output a new board's link through that relay as the JSON line
// {"link"}, and joins that board. As the first other participant connects, such as the listener
// the script starts on the link, it writes a feedback on the board and prints its record as the
// JSON line {"feedback"}. It stays in the room until it is stopped.
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { APP_ID, connectDoc, feedbackOf, trysteroTransport, writeFeedback, type Feedback } from '@chalkline/sync';
import { joinBoardRoom } from '@chalkline/sync/join';
import { RELAY_PARAM, relaysFromAddress } from '@chalkline/sync/relay';
import { createWsRelayServer } from '@trystero-p2p/ws-relay/server';
import * as Y from 'yjs';

/** The relay's path, as the local-network mode serves it. */
const RELAY_PATH = '/relay';

function stopped(): Promise<void> {
  return new Promise((resolve) => {
    process.once('SIGINT', () => resolve());
    process.once('SIGTERM', () => resolve());
  });
}

async function main(): Promise<void> {
  const server = createServer((_request, response) => {
    response.writeHead(404);
    response.end();
  });
  await new Promise<void>((listening, failed) => {
    server.once('error', failed);
    server.listen({ port: 0, host: '127.0.0.1' }, () => {
      server.off('error', failed);
      listening();
    });
  });
  const relay = createWsRelayServer({
    server,
    path: RELAY_PATH,
    onError: (error) => console.error('peer: the relay failed', error),
  });
  await relay.ready;

  const roomId = `listen-smoke-${randomUUID()}`;
  const key = randomUUID();
  const link = new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}/`);
  link.searchParams.set(RELAY_PARAM, RELAY_PATH);
  link.hash = `room=${roomId}&key=${key}`;

  const werift = await import('werift');
  const PeerConnection =
    werift.RTCPeerConnection ?? (werift as unknown as { default: typeof werift }).default.RTCPeerConnection;
  const room = joinBoardRoom(
    {
      appId: APP_ID,
      password: key,
      rtcPolyfill: PeerConnection as unknown as typeof RTCPeerConnection,
      // Host candidates alone, as on a local network without the internet.
      rtcConfig: { iceServers: [] },
    },
    roomId,
    relaysFromAddress(link),
    { onJoinError: ({ peerId, error }) => console.error(`peer: ${peerId} couldn't connect: ${error}`) },
  );
  const doc = new Y.Doc();
  const transport = trysteroTransport(room);
  connectDoc(doc, transport, { onSendError: (error) => console.error('peer: a send failed', error) });
  let written = false;
  transport.onPeerJoin(() => {
    if (written) return;
    written = true;
    const record: Feedback = {
      id: randomUUID(),
      by: 'Ada',
      at: new Date().toISOString(),
      text: 'can we move this up a bit?',
      region: { x: 0, y: 0, width: 100, height: 50 },
      shapes: ['box'],
      status: 'open',
      answer: null,
    };
    writeFeedback(feedbackOf(doc), record);
    console.log(JSON.stringify({ feedback: record }));
  });
  console.log(JSON.stringify({ link: link.href }));
  await stopped();
  await room.leave();
}

main().then(
  () => process.exit(0),
  (error: unknown) => {
    console.error(error instanceof Error ? (error.stack ?? error.message) : error);
    process.exit(1);
  },
);
