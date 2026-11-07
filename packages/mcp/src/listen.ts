import type { TranscriptEntry, Transport } from '@chalkline/sync';
import type { TranscriptLog } from './transcript';

/**
 * One line that `chalkline-mcp listen` prints: the words people on the board said with no pause of
 * the listener's length between them.
 */
export type Heard = {
  /** When the group's last words were said, as the speaker's browser recorded them (ISO 8601). */
  at: string;
  /** Each person who said the group's words, once, in the order they first spoke. */
  speakers: string[];
  /** The words of the group's entries, in the order the listener received them, joined by spaces. */
  text: string;
};

/** How long a pause ends a group where `--pause` doesn't set another length, in milliseconds. */
export const PAUSE_MS = 1500;

export interface ListenOptions {
  /**
   * When the listener started, in milliseconds since the epoch: an entry said at or before this
   * time is left out.
   */
  after: number;
  /** How long a pause after an entry ends its group, in milliseconds. */
  pauseMs: number;
  /** Called with each group once the pause after it has passed. */
  onHeard: (heard: Heard) => void;
}

export interface Listener {
  /** Passes on at once the group that waits for its pause, where one does. */
  flush(): void;
  /** Stops listening, and drops the group that waits for its pause. */
  stop(): void;
}

/** The line of a group: `entries` holds at least one entry, in the order the listener received them. */
function heardOf(entries: readonly TranscriptEntry[]): Heard {
  const speakers: string[] = [];
  for (const { speaker } of entries) if (!speakers.includes(speaker)) speakers.push(speaker);
  return { at: entries[entries.length - 1].at, speakers, text: entries.map(({ text }) => text).join(' ') };
}

/**
 * Listens to the board's transcript through `log`. Each entry said after `options.after` joins the
 * group that waits for its pause, and starts the pause again; once `options.pauseMs` passes without
 * another entry, the group goes to `options.onHeard`. An entry said at or before `options.after` is
 * left out, though the listener receives it later, as a peer's copy of the board brings the
 * transcript's earlier entries. The pause counts from the moment the listener receives each entry,
 * so the entries that arrive in one change, as when the listener joins the room again, make one
 * group.
 */
export function listen(log: TranscriptLog, options: ListenOptions): Listener {
  let cursor = 0;
  let group: TranscriptEntry[] = [];
  let pause: ReturnType<typeof setTimeout> | undefined;

  const flush = (): void => {
    clearTimeout(pause);
    pause = undefined;
    if (group.length === 0) return;
    const heard = heardOf(group);
    group = [];
    options.onHeard(heard);
  };

  const take = (): void => {
    const read = log.after(cursor);
    cursor = read.cursor;
    const said = read.entries.filter(({ at }) => Date.parse(at) > options.after);
    if (said.length === 0) return;
    group.push(...said);
    clearTimeout(pause);
    pause = setTimeout(flush, options.pauseMs);
  };

  const off = log.onAppend(take);
  take();
  return {
    flush,
    stop: () => {
      off();
      clearTimeout(pause);
      pause = undefined;
      group = [];
    },
  };
}

/** The line `watchRoom` logs as the listener's last peer leaves. */
export const LOST =
  'lost the room: no one on the board is connected, so the listener receives nothing until someone connects again';

/**
 * Logs, through `log`, each peer of `transport` that connects and leaves, where the listener loses
 * the room as its last peer leaves, and where it joins the room again as a peer connects after
 * that. What people said while the listener was away comes once a peer that holds it connects, as
 * that peer's copy of the board arrives.
 */
export function watchRoom(transport: Pick<Transport, 'onPeerJoin' | 'onPeerLeave'>, log: (line: string) => void): void {
  const peers = new Set<string>();
  let lost = false;
  transport.onPeerJoin((peerId) => {
    peers.add(peerId);
    if (lost) {
      lost = false;
      log(`joined the room again: connected to ${peerId}`);
    } else {
      log(`connected to ${peerId}`);
    }
  });
  transport.onPeerLeave((peerId) => {
    if (!peers.delete(peerId)) return;
    log(`${peerId} left`);
    if (peers.size > 0) return;
    lost = true;
    log(LOST);
  });
}
