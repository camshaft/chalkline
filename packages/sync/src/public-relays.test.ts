import { defaultRelayUrls, joinRoom as joinNostrRoom } from '@trystero-p2p/nostr';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRelayPool, joinPublicRelayRoom, publicRelayOrder, TRYSTERO_RELAY_COUNT } from './public-relays';

/** A WebSocket that a test opens, closes and answers by hand. */
class FakeSocket extends EventTarget {
  static made: FakeSocket[] = [];

  readyState = 0;
  readonly sent: string[] = [];
  onopen: ((event: Event) => void) | null = null;
  onclose: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;

  constructor(readonly url: string) {
    super();
    FakeSocket.made.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.end();
  }

  /** Opens the socket, as a relay that answers does. */
  accept(): void {
    this.readyState = 1;
    this.fire(new Event('open'));
  }

  /** Closes the socket, as a relay that fails or drops the connection does. */
  end(): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.fire(new Event('close'));
  }

  /** Delivers a message of the relay's. */
  receive(message: unknown[]): void {
    this.fire(new MessageEvent('message', { data: JSON.stringify(message) }));
  }

  /** The messages of `type`, such as REQ or EVENT, that the page sent. */
  messages(type: string): unknown[][] {
    return this.sent.map((data) => JSON.parse(data) as unknown[]).filter((message) => message[0] === type);
  }

  private fire(event: Event): void {
    const handler = this[`on${event.type}` as 'onopen' | 'onclose' | 'onmessage'];
    handler?.(event as MessageEvent);
    this.dispatchEvent(event);
  }
}

/** `n` relay URLs of a test's own, so that the backoff Trystero keeps for each URL doesn't carry from one test to the next. */
function relays(name: string, n: number): string[] {
  return Array.from({ length: n }, (_, index) => `wss://${name}-${index}.test`);
}

function socketsOf(url: string): FakeSocket[] {
  return FakeSocket.made.filter((socket) => socket.url === url);
}

/** The newest socket of `url`. */
function socketOf(url: string): FakeSocket {
  const socket = socketsOf(url).at(-1);
  if (socket === undefined) throw new Error(`no socket of ${url}`);
  return socket;
}

beforeEach(() => {
  FakeSocket.made = [];
  vi.stubGlobal('WebSocket', FakeSocket);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('createRelayPool', () => {
  it('connects the first `count` relays of the order', () => {
    const urls = relays('first', 5);

    const pool = createRelayPool({ urls, count: 3, warn: null });

    expect(FakeSocket.made.map((socket) => socket.url)).toEqual(urls.slice(0, 3));
    expect(pool.held()).toEqual(urls.slice(0, 3));
    expect(pool.retired()).toEqual([]);
  });

  it('stops using a relay whose connection fails while another relay is open, and holds the next one', async () => {
    const urls = relays('fail', 4);
    const warn = vi.fn();
    const pool = createRelayPool({ urls, count: 2, warn });

    socketOf(urls[0]).accept();
    socketOf(urls[1]).end();

    expect(pool.retired()).toEqual([urls[1]]);
    expect(pool.held()).toEqual([urls[0], urls[2]]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(urls[1]));
    expect(socketsOf(urls[3])).toHaveLength(0);
    socketOf(urls[2]).accept();
    await expect(pool.relays[2].ready).resolves.toBe(pool.relays[2]);
    await expect(pool.relays[0].ready).resolves.toBe(pool.relays[0]);
  });

  it("doesn't judge a relay while no relay is open, and connects the next relay of the order", () => {
    vi.useFakeTimers();
    const urls = relays('offline', 4);
    const warn = vi.fn();
    const pool = createRelayPool({ urls, count: 2, warn });

    socketOf(urls[0]).end();
    expect(socketsOf(urls[2])).toHaveLength(0);
    socketOf(urls[1]).end();

    expect(pool.retired()).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
    expect(pool.held()).toEqual([urls[0], urls[1]]);
    expect(socketsOf(urls[2])).toHaveLength(1);
    expect(socketsOf(urls[3])).toHaveLength(0);
  });

  it('closes the next relay of the order once the relays it holds open again', () => {
    vi.useFakeTimers();
    const urls = relays('probe', 3);
    const pool = createRelayPool({ urls, count: 2, warn: null });
    socketOf(urls[0]).end();
    socketOf(urls[1]).end();
    const probe = socketOf(urls[2]);

    probe.accept();

    // The network works, so each relay the pool holds gets a new connection.
    expect(socketsOf(urls[0])).toHaveLength(2);
    expect(socketsOf(urls[1])).toHaveLength(2);
    socketOf(urls[0]).accept();
    expect(probe.readyState).toBe(1);
    socketOf(urls[1]).accept();
    expect(probe.readyState).toBe(3);
    expect(pool.held()).toEqual([urls[0], urls[1]]);
    expect(pool.retired()).toEqual([]);
  });

  it("holds the next relay of the order where a relay that the pool holds fails on its new connection", () => {
    vi.useFakeTimers();
    const urls = relays('fresh', 3);
    const pool = createRelayPool({ urls, count: 2, warn: null });
    socketOf(urls[0]).end();
    socketOf(urls[1]).end();
    socketOf(urls[2]).accept();

    socketOf(urls[0]).end();
    socketOf(urls[1]).accept();

    expect(pool.retired()).toEqual([urls[0]]);
    expect(pool.held()).toEqual([urls[1], urls[2]]);
    expect(socketOf(urls[2]).readyState).toBe(1);
  });

  it("stops using a relay that refuses one of the board's events, and not one that holds the event already", async () => {
    const urls = relays('refuse', 4);
    const warn = vi.fn();
    const pool = createRelayPool({ urls, count: 2, warn });
    socketOf(urls[0]).accept();
    socketOf(urls[1]).accept();

    socketOf(urls[0]).receive(['OK', 'event-a', false, 'duplicate: have this event']);
    expect(pool.retired()).toEqual([]);
    socketOf(urls[1]).receive(['OK', 'event-b', false, 'rate-limited: slow down']);

    expect(pool.retired()).toEqual([urls[1]]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('rate-limited: slow down'));
    expect(socketOf(urls[1]).readyState).toBe(3);
    expect(pool.held()).toEqual([urls[0], urls[2]]);
    await expect(pool.relays[1].publish('topic', { peerId: 'peer' }, true)).resolves.toEqual({ stopAnnouncing: true });
    await expect(pool.relays[0].publish('topic', { peerId: 'peer' }, true)).resolves.toBeUndefined();
  });

  it("stops using a relay that ends the board's subscription, and not one that ends another subscription", () => {
    const urls = relays('closed', 3);
    const warn = vi.fn();
    const pool = createRelayPool({ urls, count: 2, warn });
    socketOf(urls[0]).accept();
    socketOf(urls[1]).accept();
    pool.relays[1].subscribe('topic', vi.fn());
    const [[, subId]] = socketOf(urls[1]).messages('REQ');

    socketOf(urls[1]).receive(['CLOSED', 'someone-else', 'error: not ours']);
    expect(pool.retired()).toEqual([]);
    socketOf(urls[1]).receive(['CLOSED', subId, 'auth-required: sign in']);

    expect(pool.retired()).toEqual([urls[1]]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('auth-required: sign in'));
    expect(pool.held()).toEqual([urls[0], urls[2]]);
  });

  it("passes on the events of the board's subscription, and subscribes and announces again on a new connection", async () => {
    const urls = relays('events', 3);
    const pool = createRelayPool({ urls, count: 2, warn: null });
    const first = socketOf(urls[0]);
    first.accept();
    socketOf(urls[1]).accept();
    const relay = pool.relays[0];
    const onMessage = vi.fn();

    relay.subscribe('topic', onMessage);
    await relay.publish('topic', { peerId: 'peer' }, true);
    const [[, subId]] = first.messages('REQ');
    expect(first.messages('EVENT')).toHaveLength(1);
    first.receive(['EVENT', subId, { content: 'hello', tags: [['x', 'topic']] }]);
    first.receive(['EVENT', 'someone-else', { content: 'not ours', tags: [['x', 'topic']] }]);

    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(onMessage).toHaveBeenCalledWith('topic', 'hello');
    first.end();
    const second = socketOf(urls[0]);
    expect(second).not.toBe(first);
    second.accept();
    expect(second.messages('REQ')).toHaveLength(1);
    await vi.waitFor(() => expect(second.messages('EVENT')).toHaveLength(1), { timeout: 5000 });
    expect(pool.retired()).toEqual([]);
  });

  it("stops using a relay whose connection drops before it answered the board's subscription, and not one that answered", () => {
    vi.useFakeTimers();
    const urls = relays('answers', 4);
    const pool = createRelayPool({ urls, count: 3, warn: null });
    for (const url of urls.slice(0, 3)) socketOf(url).accept();
    for (const relay of pool.relays.slice(0, 3)) relay.subscribe('topic', vi.fn());
    const answering = socketOf(urls[0]);
    const [[, subId]] = answering.messages('REQ');

    answering.receive(['EOSE', subId]);
    socketOf(urls[1]).receive(['EOSE', 'someone-else']);
    answering.end();
    socketOf(urls[1]).end();

    expect(pool.retired()).toEqual([urls[1]]);
    expect(socketsOf(urls[0])).toHaveLength(2);
    expect(pool.held()).toEqual([urls[0], urls[2], urls[3]]);
  });

  it('stops reconnecting to a relay it stopped using', async () => {
    vi.useFakeTimers();
    const urls = relays('retired', 3);
    const pool = createRelayPool({ urls, count: 2, warn: null });
    socketOf(urls[0]).accept();
    socketOf(urls[1]).end();
    expect(pool.retired()).toEqual([urls[1]]);

    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);

    expect(socketsOf(urls[1])).toHaveLength(1);
  });

  it('holds the same relays on two pages that see the same relays fail', () => {
    const [a, b, c, d, e] = relays('pages', 5);
    const urls = [a, b, c, d, e];
    const pages = [createRelayPool({ urls, count: 3, warn: null }), createRelayPool({ urls, count: 3, warn: null })];

    // Each relay answers both pages the same way: a refuses the board's events, c closes each connection before it opens, and the rest answer.
    const served = new Set<FakeSocket>();
    for (let next = FakeSocket.made.at(0); next !== undefined; next = FakeSocket.made.find((socket) => !served.has(socket))) {
      served.add(next);
      if (next.url === c) next.end();
      else {
        next.accept();
        if (next.url === a) next.receive(['OK', 'event-id', false, 'rate-limited: too many events']);
      }
    }

    for (const page of pages) {
      expect(page.held()).toEqual([b, d, e]);
      expect(page.retired()).toEqual([a, c]);
    }
  });
});

describe('publicRelayOrder', () => {
  it("lists each of Trystero's default relays once, in the same order for the same app id", () => {
    const order = publicRelayOrder('chalkline');

    expect(order).toEqual(publicRelayOrder('chalkline'));
    expect(order).toHaveLength(defaultRelayUrls.length);
    expect(new Set(order)).toEqual(new Set(defaultRelayUrls));
  });
});

describe('joinPublicRelayRoom', () => {
  it("holds as many relays as Trystero's Nostr strategy joins, the first relays of the same order", async () => {
    const appId = 'chalkline-count-test';
    const room = joinNostrRoom({ appId }, 'room');
    try {
      await vi.waitFor(() => expect(FakeSocket.made).toHaveLength(TRYSTERO_RELAY_COUNT));
      const joined = FakeSocket.made.map((socket) => socket.url);

      expect(joined).toEqual(publicRelayOrder(appId).slice(0, TRYSTERO_RELAY_COUNT));
      FakeSocket.made = [];
      const pool = createRelayPool({ urls: publicRelayOrder(appId), count: TRYSTERO_RELAY_COUNT, warn: null });
      expect(pool.held()).toEqual(joined);
      expect(FakeSocket.made.map((socket) => socket.url)).toEqual(joined);
    } finally {
      await room.leave();
    }
  });

  it('joins a room on the relays the pool holds, and moves to the next relay when one refuses the board', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const appId = 'chalkline-strategy-test';
    const order = publicRelayOrder(appId);
    const room = joinPublicRelayRoom({ appId }, 'room');
    try {
      await vi.waitFor(() => expect(FakeSocket.made).toHaveLength(TRYSTERO_RELAY_COUNT));
      expect(FakeSocket.made.map((socket) => socket.url)).toEqual(order.slice(0, TRYSTERO_RELAY_COUNT));
      for (const socket of [...FakeSocket.made]) socket.accept();
      await vi.waitFor(
        () => {
          for (const socket of FakeSocket.made) {
            expect(socket.messages('REQ')).toHaveLength(2);
            expect(socket.messages('EVENT').length).toBeGreaterThan(0);
          }
        },
        { timeout: 5000 },
      );

      socketOf(order[0]).receive(['OK', 'event-id', false, 'rate-limited: too many events']);

      expect(warn.mock.calls.filter(([message]) => String(message).includes(order[0]))).toHaveLength(1);
      const next = socketOf(order[TRYSTERO_RELAY_COUNT]);
      next.accept();
      await vi.waitFor(
        () => {
          expect(next.messages('REQ')).toHaveLength(2);
          expect(next.messages('EVENT').length).toBeGreaterThan(0);
        },
        { timeout: 5000 },
      );
    } finally {
      await room.leave();
    }
  });
});
