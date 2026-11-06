import type { Channel, Transport } from './sync';

/** One message the in-memory network carried. */
export interface SentMessage {
  from: string;
  to: string;
  channel: Channel;
}

/**
 * An in-memory network for tests: every peer that joins connects to every
 * other, and each join and message is delivered when the test calls `flush`.
 */
export class MemoryNetwork {
  readonly sent: SentMessage[] = [];
  private readonly peers = new Map<string, MemoryPeer>();
  private readonly queue: Array<() => void> = [];

  join(id: string): MemoryPeer {
    const peer = new MemoryPeer(id, this);
    for (const other of this.peers.values()) {
      this.queue.push(() => other.joined(id));
      this.queue.push(() => peer.joined(other.id));
    }
    this.peers.set(id, peer);
    return peer;
  }

  /** Queues `data` for `target`, or for every other peer where `target` is left out. */
  deliver(from: string, channel: Channel, data: Uint8Array, target?: string): void {
    for (const peer of this.peers.values()) {
      if (peer.id === from || (target !== undefined && peer.id !== target)) continue;
      this.sent.push({ from, to: peer.id, channel });
      const copy = data.slice();
      this.queue.push(() => peer.received(channel, copy, from));
    }
  }

  /** Delivers every queued join and message, and each one they queue in turn. */
  flush(): void {
    for (let next = this.queue.shift(); next !== undefined; next = this.queue.shift()) next();
  }
}

/** One peer's end of a `MemoryNetwork`. */
export class MemoryPeer implements Transport {
  private readonly joinHandlers: Array<(peerId: string) => void> = [];
  private readonly messageHandlers: Array<(channel: Channel, data: Uint8Array, from: string) => void> = [];

  constructor(
    readonly id: string,
    private readonly network: MemoryNetwork,
  ) {}

  send(channel: Channel, data: Uint8Array, target?: string): void {
    this.network.deliver(this.id, channel, data, target);
  }

  onMessage(handler: (channel: Channel, data: Uint8Array, from: string) => void): void {
    this.messageHandlers.push(handler);
  }

  onPeerJoin(handler: (peerId: string) => void): void {
    this.joinHandlers.push(handler);
  }

  joined(peerId: string): void {
    for (const handler of this.joinHandlers) handler(peerId);
  }

  received(channel: Channel, data: Uint8Array, from: string): void {
    for (const handler of this.messageHandlers) handler(channel, data, from);
  }
}
