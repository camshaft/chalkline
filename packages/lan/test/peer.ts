// The second participant of src/local-mode.test.ts, which bundles this file and runs it in a process
// of its own, since Trystero keeps one peer id for each process. It joins the board its first argument
// links to, through the relay the link names, with the app id of its second argument, marks the
// board with drawn-by-peer, and stays in the room until it is stopped.
import { connectDoc, trysteroTransport } from '@chalkline/sync';
import { joinBoardRoom } from '@chalkline/sync/join';
import { relaysFromAddress } from '@chalkline/sync/relay';
import * as Y from 'yjs';

function stopped(): Promise<void> {
  return new Promise((resolve) => {
    process.once('SIGINT', () => resolve());
    process.once('SIGTERM', () => resolve());
  });
}

async function main(): Promise<void> {
  const [link, appId] = process.argv.slice(2);
  if (link === undefined || appId === undefined) throw new Error('Usage: peer <board link> <app id>');
  const fragment = new URLSearchParams(new URL(link).hash.slice(1));
  const roomId = fragment.get('room');
  const key = fragment.get('key');
  if (roomId === null || key === null) throw new Error(`The link ${link} doesn't hold a room and a key.`);

  const werift = await import('werift');
  const PeerConnection =
    werift.RTCPeerConnection ?? (werift as unknown as { default: typeof werift }).default.RTCPeerConnection;
  const room = joinBoardRoom(
    {
      appId,
      password: key,
      rtcPolyfill: PeerConnection as unknown as typeof RTCPeerConnection,
      rtcConfig: { iceServers: [] },
    },
    roomId,
    relaysFromAddress(link),
    { onJoinError: ({ peerId, error }) => console.error(`peer: ${peerId} couldn't connect: ${error}`) },
  );
  const doc = new Y.Doc();
  connectDoc(doc, trysteroTransport(room), { onSendError: (error) => console.error('peer: a send failed', error) });
  doc.getMap<boolean>('probe').set('drawn-by-peer', true);
  console.log('peer: joined');
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
