// `chalkline-mcp listen`: joins the Chalkline board that its link opens, and prints on standard
// output one JSON line for each group of words people on the board say between two pauses, for an
// agent client that turns each line a command prints into a message to its agent, such as Claude
// Code's Monitor tool.
import { parseArgs } from 'node:util';
import {
  APP_ID,
  connectDoc,
  parseRoomFragment,
  relaysFromAddress,
  trysteroTransport,
  type RoomSecrets,
} from '@chalkline/sync';
import * as Y from 'yjs';
import { listen, PAUSE_MS, watchRoom } from './listen';
import { TranscriptLog } from './transcript';

export const LISTEN_USAGE = `Usage: chalkline-mcp listen <board link> [options]

Joins the Chalkline board that the link opens, and prints on standard output one JSON line,
{"at", "speakers", "text"}, for each group of words people on the board say with no pause of
--pause's length between them: "text" holds the group's words, "speakers" who said them, and
"at" when its last words were said. What was said before the listener started is left out.
Each line it logs goes to standard error, such as where it loses the room and where it joins it
again. It listens until Ctrl-C or SIGTERM stops it, and then prints the words that wait for their
pause before it leaves the room.

Options:
  --pause <seconds>  how long a pause ends a group (default: 1.5)
  --after <time>     leave out what was said at or before this ISO 8601 time, in place of the
                     time the listener starts, such as the "at" of the last line an earlier
                     listener printed
  --help             print this text`;

/** What the arguments after `chalkline-mcp listen` ask for. */
export type ListenArgs =
  | { help: true }
  | { help: false; room: RoomSecrets; relays: string[]; pauseMs: number; after: number };

function roomOf(link: string): RoomSecrets {
  let address: URL;
  try {
    address = new URL(link);
  } catch {
    throw new Error(`${link} isn't a link.\n\n${LISTEN_USAGE}`);
  }
  const secrets = parseRoomFragment(address.hash);
  if (secrets === null) throw new Error(`The link lacks the #room=<name>&key=<password> fragment.\n\n${LISTEN_USAGE}`);
  return secrets;
}

/** The pause that `--pause` sets in seconds, in milliseconds. */
function pauseOf(text: string | undefined): number {
  if (text === undefined) return PAUSE_MS;
  const seconds = Number(text);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new Error(
      `--pause is ${JSON.stringify(text)}: give the pause's length in seconds, above 0, such as 1.5.\n\n${LISTEN_USAGE}`,
    );
  }
  return seconds * 1000;
}

/** The time that `--after` sets, or `now` where it is left out, in milliseconds since the epoch. */
function afterOf(text: string | undefined, now: number): number {
  if (text === undefined) return now;
  const time = Date.parse(text);
  if (Number.isNaN(time)) {
    throw new Error(
      `--after is ${JSON.stringify(text)}: give an ISO 8601 time, such as the "at" of a line an earlier listener printed.\n\n${LISTEN_USAGE}`,
    );
  }
  return time;
}

/** Reads the arguments after `listen`, for a listener that starts at `now`, in milliseconds since the epoch. */
export function parseListenArgs(args: string[], now: number): ListenArgs {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      pause: { type: 'string' },
      after: { type: 'string' },
      help: { type: 'boolean', default: false },
    },
  });
  if (values.help) return { help: true };
  if (positionals.length !== 1) throw new Error(LISTEN_USAGE);
  const [link] = positionals;
  return {
    help: false,
    room: roomOf(link),
    relays: relaysFromAddress(link),
    pauseMs: pauseOf(values.pause),
    after: afterOf(values.after, now),
  };
}

/**
 * Resolves once Ctrl-C or SIGTERM stops the listener. It doesn't wait for standard input to close,
 * as the MCP server does, since a tool that runs a command in the background may close it at once.
 */
function stopped(): Promise<void> {
  return new Promise((resolve) => {
    process.once('SIGINT', () => resolve());
    process.once('SIGTERM', () => resolve());
  });
}

/** Runs `chalkline-mcp listen` with the arguments after `listen`. */
export async function runListen(args: string[]): Promise<void> {
  const parsed = parseListenArgs(args, Date.now());
  if (parsed.help) {
    await new Promise<void>((resolve) => process.stdout.write(`${LISTEN_USAGE}\n`, () => resolve()));
    return;
  }
  const { room: secrets, relays, pauseMs, after } = parsed;

  const doc = new Y.Doc();
  const listener = listen(new TranscriptLog(doc), {
    after,
    pauseMs,
    onHeard: (heard) => {
      process.stdout.write(`${JSON.stringify(heard)}\n`);
    },
  });
  const done = stopped();

  // The listener joins the room as the MCP server does, without Excalidraw and jsdom, since it
  // draws nothing.
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
  watchRoom(transport, (line) => console.error(line));
  console.error(
    `listening in room ${secrets.room} through ${relays.length > 0 ? relays.join(', ') : 'the public Nostr relays'}, for what is said after ${new Date(after).toISOString()}`,
  );

  await done;
  listener.flush();
  listener.stop();
  await room.leave();
  // Standard output to a pipe is written asynchronously on some systems, so wait for the last line.
  await new Promise<void>((resolve) => process.stdout.write('', () => resolve()));
}
