// `chalkline-mcp listen`: joins the Chalkline board that its link opens, and prints on standard
// output one JSON line for each group of words people on the board say between two pauses, each
// text they write, each sketch they draw and each feedback they open, for an agent client that
// turns each line a command prints into a message to its agent, such as Claude Code's Monitor tool.
import { parseArgs } from 'node:util';
import {
  connectDoc,
  trysteroTransport,
  type RoomSecrets,
  type TurnServer,
} from '@chalkline/sync';
import * as Y from 'yjs';
import { joinConfig, joinErrorLine, readBoardLink, routeText } from './board-link';
import { BOARD_PAUSE_MS, listenToBoard, PAUSE_MS, watchRoom } from './listen';

export const LISTEN_USAGE = `Usage: chalkline-mcp listen <board link> [options]

Joins the Chalkline board that the link opens, and prints on standard output one JSON line for
what people on the board say, write and draw, and for each feedback they open:

  {"at", "speakers", "text"}  for each group of words people say or type in the chat with no
      pause of --pause's length between them: "text" holds the group's words, "speakers" who
      said or typed them, and "at" when its last words came;
  {"at", "kind": "text", "text"}  for each text a person writes or changes, a shape's label
      among them, once it stays unchanged for --board-pause's length: "text" holds its words,
      and "at" when the person last changed it;
  {"at", "kind": "sketch", "ids", "box"}  for the freehand strokes a person draws, once they
      stay unchanged for --board-pause's length: "ids" holds the strokes' ids, "box" the part of
      the board they cover, as {"x", "y", "width", "height"}, and "at" when the person last
      changed one;
  {"at", "kind": "feedback", "id", "by", "text", "shapes"}  at once for each feedback that
      becomes open, a new one or one a person reopens after an agent's answer: "id" holds its
      id, as read_feedback lists it, to pass to answer_feedback, "by" its writer, "text" what
      they wrote, "shapes" the ids of the shapes under its area, and "at" when the person wrote
      it, or, for a reopened feedback, when the person reopened it, and where the page that
      reopened it doesn't record that time, when the listener received the reopening.

What was said, written or drawn before the listener started is left out, and so is each change
that an agent's helper makes, which it marks on each element it adds or changes, each freehand
stroke an agent drew, and each message an agent posted in the chat. A person's later change of
an agent's text makes a line. A feedback that became open before the listener started is left
out too, and so is each other change of a feedback, such as an agent's answer. Each line it
logs goes to standard error, such as where it loses the room and where it joins it again. It
listens until Ctrl-C or SIGTERM stops it, and then prints the lines that wait for their pause
before it leaves the room.

Where the link's fragment holds a turn parameter, as the page's Copy link with TURN servers
writes it, the listener connects to the board's peers through the TURN servers it lists.

Options:
  --pause <seconds>        how long a pause ends a group of words (default: 1)
  --board-pause <seconds>  how long a text or a sketch stays unchanged before its line
                           (default: 3)
  --after <time>           leave out what was said, written or drawn, and each feedback that
                           became open, at or before this ISO 8601 time, in place of the time
                           the listener starts, such as the "at" of the last line an earlier
                           listener printed. A text or a freehand stroke whose copy doesn't
                           record when its words, or its place and points, last changed, as
                           one written before Chalkline's pages recorded it, is left out where
                           its last change came before the listener started. A feedback
                           reopened on a page that doesn't record when, which the listener
                           first receives open, is left out where the agent's answer came at
                           or before this time, since the person may have reopened it before
                           then too
  --help                   print this text`;

/** What the arguments after `chalkline-mcp listen` ask for. */
export type ListenArgs =
  | { help: true }
  | {
      help: false;
      room: RoomSecrets;
      relays: string[];
      /** The servers the link's turn parameter carries, which the listener connects through. */
      turnServers: TurnServer[];
      pauseMs: number;
      boardPauseMs: number;
      after: number;
      start: number;
    };

/** The pause that the option `--<name>` sets in seconds, or `fallback` where it is left out, in milliseconds. */
function pauseOf(name: string, text: string | undefined, fallback: number): number {
  if (text === undefined) return fallback;
  const seconds = Number(text);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new Error(
      `--${name} is ${JSON.stringify(text)}: give the pause's length in seconds, above 0, such as 0.5.\n\n${LISTEN_USAGE}`,
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
      'board-pause': { type: 'string' },
      after: { type: 'string' },
      help: { type: 'boolean', default: false },
    },
  });
  if (values.help) return { help: true };
  if (positionals.length !== 1) throw new Error(LISTEN_USAGE);
  const [link] = positionals;
  const board = readBoardLink(link, LISTEN_USAGE);
  return {
    help: false,
    room: board.room,
    relays: board.relays,
    turnServers: board.turnServers,
    pauseMs: pauseOf('pause', values.pause, PAUSE_MS),
    boardPauseMs: pauseOf('board-pause', values['board-pause'], BOARD_PAUSE_MS),
    after: afterOf(values.after, now),
    start: now,
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
  const { room: secrets, relays, turnServers, pauseMs, boardPauseMs, after, start } = parsed;
  const board = { room: secrets, relays, turnServers };

  const doc = new Y.Doc();
  const listener = listenToBoard(doc, {
    after,
    start,
    pauseMs,
    boardPauseMs,
    print: (line) => {
      process.stdout.write(`${JSON.stringify(line)}\n`);
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
    joinConfig(board, PeerConnection as unknown as typeof RTCPeerConnection),
    secrets.room,
    relays,
    { onJoinError: ({ peerId, error }) => console.error(joinErrorLine(board, peerId, String(error))) },
  );
  const transport = trysteroTransport(room);
  connectDoc(doc, transport, {
    onSynced: (peerId) => console.error(`synced with ${peerId}`),
    onSendError: (error) => console.error('a send failed:', error),
  });
  watchRoom(transport, (line) => console.error(line));
  console.error(
    `listening in room ${secrets.room} through ${routeText(board)}, for what is said, written or drawn, and each feedback that becomes open, after ${new Date(after).toISOString()}`,
  );

  await done;
  listener.flush();
  listener.stop();
  await room.leave();
  // Standard output to a pipe is written asynchronously on some systems, so wait for the last line.
  await new Promise<void>((resolve) => process.stdout.write('', () => resolve()));
}
