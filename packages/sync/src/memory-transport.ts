import type { Channel, Transport } from './sync';

/** One message a peer sent to a connected peer. */
export interface SentMessage {
  from: string;
  to: string;
  channel: Channel;
}

/** The faults the in-memory network injects. */
export interface NetworkOptions {
  /** The seed of the network's choices: the same seed and the same sends make the same run. */
  seed?: number;
  /**
   * The chance, from 0 to 1, that a message is lost. A lost message breaks its
   * link, as a failed WebRTC connection loses what it carried: both peers see
   * the other leave, the link's other messages that haven't arrived are lost too, and
   * the link comes back later, when both peers see the other join again.
   */
  drop?: number;
  /**
   * The most steps a message, or a broken link's return, waits: each waits a
   * random number of steps from 1 to `delay`, so that messages arrive out of
   * the order they were sent in. With 0, the default, each event runs in the
   * order it was queued.
   */
  delay?: number;
}

/** Returns a function that returns numbers from 0 up to 1, the same series for the same seed (mulberry32). */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = Math.imul(state ^ (state >>> 15), state | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

/** A join, a leave or a message, which runs at its step. */
interface Event {
  due: number;
  order: number;
  run: () => void;
}

/** The connection between two peers. */
interface Link {
  up: boolean;
  /** Counts the link's breaks, so that a message sent before a break isn't delivered after it. */
  breaks: number;
}

function linkKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

function earlier(event: Event, than: Event): boolean {
  return event.due < than.due || (event.due === than.due && event.order < than.order);
}

/**
 * An in-memory network for tests: every peer that joins connects to every
 * other. Each join, leave and message waits in a queue until the test calls
 * `step`, `run` or `flush`, and the options make the network lose, delay and
 * reorder messages.
 */
export class MemoryNetwork {
  /** Each message a peer sent to a connected peer, the lost ones among them. */
  readonly sent: SentMessage[] = [];
  /** How many messages were lost: each one the network dropped, and each one that hadn't arrived when its link broke. */
  dropped = 0;
  /** How many messages arrived after a message sent later on the same link in the same direction. */
  reordered = 0;
  /** The chance that a message is lost; a test sets it to 0 to let the network heal. */
  drop: number;
  /** The most steps a message waits. */
  delay: number;
  private readonly random: () => number;
  private readonly peers = new Map<string, MemoryPeer>();
  private readonly links = new Map<string, Link>();
  /** The newest message that arrived in each direction of each link, by its place in `sent`. */
  private readonly newest = new Map<string, number>();
  private readonly queue: Event[] = [];
  private now = 0;
  private order = 0;

  constructor(options: NetworkOptions = {}) {
    this.random = seededRandom(options.seed ?? 0);
    this.drop = options.drop ?? 0;
    this.delay = options.delay ?? 0;
  }

  join(id: string): MemoryPeer {
    if (this.peers.has(id)) throw new Error(`${id} is on the network already`);
    const peer = new MemoryPeer(id, this);
    for (const other of this.peers.values()) {
      this.links.set(linkKey(id, other.id), { up: true, breaks: 0 });
      this.schedule(0, () => other.joined(id));
      this.schedule(0, () => peer.joined(other.id));
    }
    this.peers.set(id, peer);
    return peer;
  }

  /** Takes `id` off the network for good: each other peer sees it leave, and its messages that haven't arrived are lost. */
  leave(id: string): void {
    if (!this.peers.delete(id)) return;
    for (const other of this.peers.values()) {
      const key = linkKey(id, other.id);
      const link = this.links.get(key);
      this.links.delete(key);
      if (link === undefined) continue;
      // A link that broke already has shown the leave, and doesn't come back.
      if (link.up) this.schedule(0, () => other.left(id));
      link.up = false;
      link.breaks += 1;
    }
  }

  /** Breaks the link between `a` and `b`, as a lost message does. */
  disconnect(a: string, b: string): void {
    const link = this.links.get(linkKey(a, b));
    if (link?.up) this.cut(a, b, link);
  }

  /** Queues `data` for `target`, or for every other connected peer where `target` is left out. */
  deliver(from: string, channel: Channel, data: Uint8Array, target?: string): void {
    for (const peer of this.peers.values()) {
      if (peer.id === from || (target !== undefined && peer.id !== target)) continue;
      // A peer sends only to the peers it is connected to.
      const link = this.links.get(linkKey(from, peer.id));
      if (link === undefined || !link.up) continue;
      const sequence = this.sent.push({ from, to: peer.id, channel }) - 1;
      if (this.drop > 0 && this.random() < this.drop) {
        this.dropped += 1;
        this.cut(from, peer.id, link);
        continue;
      }
      const copy = data.slice();
      const breaks = link.breaks;
      const direction = `${from}>${peer.id}`;
      this.schedule(this.wait(), () => {
        if (!link.up || link.breaks !== breaks) {
          this.dropped += 1;
          return;
        }
        const newest = this.newest.get(direction);
        if (newest !== undefined && sequence < newest) this.reordered += 1;
        else this.newest.set(direction, sequence);
        peer.received(channel, copy, from);
      });
    }
  }

  /** Runs the next queued event, and returns whether there was one. */
  step(): boolean {
    if (this.queue.length === 0) return false;
    let next = 0;
    for (let index = 1; index < this.queue.length; index += 1) {
      if (earlier(this.queue[index], this.queue[next])) next = index;
    }
    const [event] = this.queue.splice(next, 1);
    this.now = event.due;
    event.run();
    return true;
  }

  /** Runs up to `count` queued events. */
  run(count: number): void {
    for (let ran = 0; ran < count; ran += 1) if (!this.step()) return;
  }

  /** Runs every queued event, and each one they queue in turn. */
  flush(): void {
    let more = this.step();
    while (more) more = this.step();
  }

  private wait(): number {
    return this.delay > 0 ? 1 + Math.floor(this.random() * this.delay) : 0;
  }

  private schedule(wait: number, run: () => void): void {
    this.queue.push({ due: this.now + wait, order: this.order, run });
    this.order += 1;
  }

  /** Breaks a link: both peers see the other leave, and the link comes back after a wait. */
  private cut(a: string, b: string, link: Link): void {
    link.up = false;
    link.breaks += 1;
    const breaks = link.breaks;
    const first = this.peers.get(a);
    const second = this.peers.get(b);
    if (first === undefined || second === undefined) return;
    this.schedule(0, () => first.left(b));
    this.schedule(0, () => second.left(a));
    this.schedule(this.wait(), () => {
      if (link.breaks !== breaks) return;
      link.up = true;
      first.joined(b);
      second.joined(a);
    });
  }
}

/** One peer's end of a `MemoryNetwork`. */
export class MemoryPeer implements Transport {
  private readonly joinHandlers: Array<(peerId: string) => void> = [];
  private readonly leaveHandlers = new Set<(peerId: string) => void>();
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

  onPeerLeave(handler: (peerId: string) => void): () => void {
    this.leaveHandlers.add(handler);
    return () => {
      this.leaveHandlers.delete(handler);
    };
  }

  joined(peerId: string): void {
    for (const handler of this.joinHandlers) handler(peerId);
  }

  left(peerId: string): void {
    for (const handler of this.leaveHandlers) handler(peerId);
  }

  received(channel: Channel, data: Uint8Array, from: string): void {
    for (const handler of this.messageHandlers) handler(channel, data, from);
  }
}
