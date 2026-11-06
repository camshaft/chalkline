import { parseArgs } from 'node:util';
import * as Y from 'yjs';
import { connectionReport } from '../src/report';
import { APP_ID, parseRoomFragment, type RoomSecrets } from '../src/room';
import { connectDoc } from '../src/sync';
import { trysteroTransport } from '../src/trystero';
import { labelledBox } from './skeleton';

const USAGE = `Usage: draw-box --link <board link> [options]
       draw-box --room <name> --key <password> [options]
       draw-box --print [--label <text>]

Joins a Chalkline board from Node and adds one labelled rectangle to it.

Options:
  --label <text>       the box's label (default: "Drawn by draw-box")
  --name <name>        the name this script goes by in the room's probe map (default: script)
  --wait-seen <names>  leave once each named participant marks the box seen, such as chromium,firefox;
                       without it, the script stays in the room until Ctrl-C
  --timeout <seconds>  how long --wait-seen waits before it fails (default: 600)
  --print              print the converted elements and exit, without joining a room
  --help               print this text`;

function roomFrom(values: { link?: string; room?: string; key?: string }): RoomSecrets {
  if (values.link !== undefined) {
    const secrets = parseRoomFragment(new URL(values.link).hash);
    if (secrets === null) throw new Error(`The link lacks the #room=<name>&key=<password> fragment.\n\n${USAGE}`);
    return secrets;
  }
  if (values.room !== undefined && values.key !== undefined) return { room: values.room, key: values.key };
  throw new Error(USAGE);
}

/** Resolves once the probe map holds `seen-<name>` for each of `names`. */
function seenBy(probe: Y.Map<unknown>, names: string[]): Promise<void> {
  return new Promise((resolve) => {
    const check = () => {
      if (names.every((name) => probe.has(`seen-${name}`))) {
        probe.unobserve(check);
        resolve();
      }
    };
    probe.observe(check);
    check();
  });
}

function interrupted(): Promise<void> {
  return new Promise((resolve) => {
    process.once('SIGINT', () => resolve());
    process.once('SIGTERM', () => resolve());
  });
}

async function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms / 1000} s waiting for ${what}`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      link: { type: 'string' },
      room: { type: 'string' },
      key: { type: 'string' },
      label: { type: 'string', default: 'Drawn by draw-box' },
      name: { type: 'string', default: 'script' },
      'wait-seen': { type: 'string' },
      timeout: { type: 'string', default: '600' },
      print: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
  });
  if (values.help) {
    console.log(USAGE);
    return;
  }

  const { elements, box } = await labelledBox(values.label);
  if (values.print) {
    console.log(JSON.stringify(elements, null, 2));
    return;
  }

  const secrets = roomFrom(values);
  const werift = await import('werift');
  const PeerConnection =
    werift.RTCPeerConnection ?? (werift as unknown as { default: typeof werift }).default.RTCPeerConnection;
  const { joinRoom, selfId } = await import('@trystero-p2p/nostr');
  const room = joinRoom(
    { appId: APP_ID, password: secrets.key, rtcPolyfill: PeerConnection as unknown as typeof RTCPeerConnection },
    secrets.room,
    { onJoinError: ({ peerId, error }) => console.error(`${peerId} couldn't connect: ${error}`) },
  );

  const doc = new Y.Doc();
  const transport = trysteroTransport(room);
  connectDoc(doc, transport, {
    onSynced: (peerId) => console.log(`synced with ${peerId}`),
    onSendError: (error) => console.warn('a send failed:', error),
  });
  transport.onPeerJoin((peerId) => console.log(`connected to ${peerId}`));
  transport.onPeerLeave((peerId) => console.log(`${peerId} left`));

  const probe = doc.getMap<unknown>('probe');
  const shared = doc.getMap<unknown>('elements');
  doc.transact(() => {
    for (const element of elements) shared.set(element.id, structuredClone(element));
    probe.set(`peer-${values.name}`, selfId);
    probe.set(`drawn-${values.name}`, box.id);
  });
  console.log(`joined room ${secrets.room} as ${selfId}, and added the box ${box.id} labelled "${values.label}"`);

  const names = (values['wait-seen'] ?? '')
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
  if (names.length > 0) {
    await withTimeout(seenBy(probe, names), Number(values.timeout) * 1000, `${names.join(' and ')} to see the box`);
    console.log(`seen by ${names.join(' and ')}: ${JSON.stringify(probe.toJSON())}`);
  } else {
    console.log('Press Ctrl-C to leave the room.');
    await interrupted();
  }

  for (const [peerId, connection] of Object.entries(room.getPeers())) {
    try {
      console.log(`connection to ${peerId}: ${JSON.stringify(await connectionReport(connection))}`);
    } catch (error) {
      console.log(`connection to ${peerId}: its stats couldn't be read (${error instanceof Error ? error.message : String(error)})`);
    }
  }
  await room.leave();
}

main().then(
  () => process.exit(0),
  (error: unknown) => {
    console.error(error instanceof Error ? (error.stack ?? error.message) : error);
    process.exit(1);
  },
);
