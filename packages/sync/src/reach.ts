import type { Transport } from './sync';

/** A peer's list of the peers it connects to: a list with a higher `seq` replaces one with a lower `seq`. */
export interface PeerList {
  seq: number;
  peers: string[];
}

/** The list a `peers` message holds, or null for a message that isn't UTF-8 JSON of such a list. */
export function readPeerList(data: Uint8Array): PeerList | null {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data));
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null) return null;
  const { seq, peers } = value as { seq?: unknown; peers?: unknown };
  if (typeof seq !== 'number' || !Number.isFinite(seq)) return null;
  if (!Array.isArray(peers) || !peers.every((peer) => typeof peer === 'string')) return null;
  return { seq, peers };
}

/**
 * The peers this participant connects to through one transport, and the
 * newest list each of them sent of the peers it connects to. It sends its own
 * list to each connected peer as one of its links starts or ends, so that a
 * peer that carries a change on can leave out the peers that the change's
 * sender connects to.
 */
export class Reach {
  private readonly linked = new Set<string>();
  private readonly lists = new Map<string, PeerList>();
  private readonly changeHandlers = new Set<(dropped: boolean) => void>();
  private seq = 0;

  constructor(
    private readonly transport: Transport,
    private onSendError?: (error: unknown) => void,
  ) {
    transport.onPeerJoin((peerId) => {
      this.linked.add(peerId);
      this.announce();
    });
    transport.onPeerLeave((peerId) => {
      this.linked.delete(peerId);
      this.lists.delete(peerId);
      this.announce();
    });
    transport.onMessage((channel, data, from) => {
      if (channel === 'peers') this.received(data, from);
    });
  }

  /** Reports each failed send to `onSendError`, where no handler reports them yet. */
  reportTo(onSendError: (error: unknown) => void): void {
    this.onSendError ??= onSendError;
  }

  /** The peers this participant connects to. */
  connected(): string[] {
    return [...this.linked];
  }

  /**
   * The connected peers to carry a change from `from` on to: each one but
   * `from` that the newest list from `from` leaves out, or each one but `from`
   * while no list from `from` has arrived.
   */
  targets(from: string): string[] {
    const reached = this.lists.get(from)?.peers ?? [];
    return [...this.linked].filter((peerId) => peerId !== from && !reached.includes(peerId));
  }

  /** Whether the newest list of a connected peer holds `peerId`. */
  listed(peerId: string): boolean {
    for (const list of this.lists.values()) if (list.peers.includes(peerId)) return true;
    return false;
  }

  /**
   * Calls `handler` as a connected peer's newer list arrives, with whether that
   * list drops a peer that this participant connects to, and returns a function
   * that stops it.
   */
  onChange(handler: (dropped: boolean) => void): () => void {
    this.changeHandlers.add(handler);
    return () => {
      this.changeHandlers.delete(handler);
    };
  }

  private received(data: Uint8Array, from: string): void {
    if (!this.linked.has(from)) return;
    const list = readPeerList(data);
    if (list === null) return;
    const kept = this.lists.get(from);
    if (kept !== undefined && list.seq <= kept.seq) return;
    this.lists.set(from, list);
    const dropped =
      kept !== undefined && kept.peers.some((peerId) => this.linked.has(peerId) && !list.peers.includes(peerId));
    for (const handler of [...this.changeHandlers]) handler(dropped);
  }

  private announce(): void {
    this.seq += 1;
    const data = new TextEncoder().encode(JSON.stringify({ seq: this.seq, peers: [...this.linked] }));
    for (const peerId of this.linked) {
      try {
        const sent = this.transport.send('peers', data, peerId);
        if (sent instanceof Promise) sent.catch((error: unknown) => this.onSendError?.(error));
      } catch (error) {
        this.onSendError?.(error);
      }
    }
  }
}

const reaches = new WeakMap<Transport, Reach>();

/** The `Reach` of `transport`, which connectDoc and connectAwareness share: the first call makes it. */
export function reachOf(transport: Transport, onSendError?: (error: unknown) => void): Reach {
  const known = reaches.get(transport);
  if (known !== undefined) {
    if (onSendError !== undefined) known.reportTo(onSendError);
    return known;
  }
  const reach = new Reach(transport, onSendError);
  reaches.set(transport, reach);
  return reach;
}
