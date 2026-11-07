import {
  createTopicStrategy,
  fromJson,
  genId,
  getRelays,
  makeSocket,
  toJson,
  type JoinRoom,
  type JoinRoomConfig,
  type SocketClient,
  type StrategyMessage,
} from '@trystero-p2p/core';
import { createEvent, defaultRelayUrls, subscribe as subscription } from '@trystero-p2p/nostr';

/**
 * How many public relays a page holds where its config doesn't set
 * `relayConfig.redundancy`: as many as Trystero's Nostr strategy joins, its
 * `defaultRedundancy` in `@trystero-p2p/nostr` 0.26.0, which the package
 * doesn't export. A test compares it with the sockets Trystero's `joinRoom`
 * opens, so that an update of Trystero that changes that count fails there.
 */
export const TRYSTERO_RELAY_COUNT = 5;

/**
 * Trystero's default Nostr relays, each once, in the order Trystero ranks them
 * for `appId`: Trystero's Nostr strategy joins the first of them. Every page of
 * a board reads the same order.
 */
export function publicRelayOrder(appId: string): string[] {
  const every = defaultRelayUrls.length;
  return getRelays({ appId, relayConfig: { redundancy: every } }, defaultRelayUrls, every, true);
}

/** Opens a relay's socket, and opens it again after it closes, as `makeSocket` of `@trystero-p2p/core` does. */
export type Connect = (url: string, onMessage: (data: string) => void, onReconnect: () => void) => SocketClient;

/** A relay of a pool, which the room's topic strategy subscribes and publishes through. */
export interface PoolRelay {
  readonly url: string;
  /** Resolves once the pool holds the relay and its socket opened; never, where the pool doesn't come to hold it. */
  readonly ready: Promise<PoolRelay>;
  /** Subscribes to `topic`, now and on each new connection, and returns the call that ends the subscription. */
  subscribe(topic: string, onMessage: (topic: string, content: string) => void): () => void;
  /**
   * Sends `msg` on `topic` where the socket is open. An announcement is sent
   * again on each new connection, and once the pool stops using the relay, the
   * answer tells Trystero to stop announcing there.
   */
  publish(topic: string, msg: StrategyMessage, isAnnouncement: boolean): Promise<{ stopAnnouncing: true } | undefined>;
  /** Stops sending the announcement of `topic` again. */
  unpublish(topic: string): void;
}

/** What `createRelayPool` reads. */
export interface RelayPoolOptions {
  /** The relays the pool may use, in the order every page of a board shares. */
  urls: readonly string[];
  /** How many relays the pool holds at once. */
  count: number;
  /** Opens a relay's socket: `makeSocket` of `@trystero-p2p/core` where it is left out. */
  connect?: Connect;
  /** Says that the pool stopped using a relay: `console.warn` where it is left out, and nothing where it is null. */
  warn?: ((message: string) => void) | null;
}

/** A page's public relays, as `createRelayPool` keeps them. */
export interface RelayPool {
  /** A relay for each of the options' `urls`, in their order. */
  readonly relays: readonly PoolRelay[];
  /** The relays the pool holds now, in order. */
  held(): string[];
  /** The relays the pool stopped using, in the order it stopped. */
  retired(): string[];
}

interface Subscription {
  subId: string;
  onMessage: (topic: string, content: string) => void;
}

interface Candidate extends PoolRelay {
  resolve: (relay: PoolRelay) => void;
  resolved: boolean;
  retired: boolean;
  client: SocketClient | undefined;
  /** The client's socket, while it is open. */
  openSocket: SocketClient['socket'] | undefined;
  /** Whether the client's first connection hasn't opened or closed yet. */
  opening: boolean;
  /** Whether the relay answered since its socket opened: an EOSE or an EVENT of the board's subscriptions, or an accepted event. */
  answered: boolean;
  /** The number of each request of the board's that the current connection carried, by its subscription's or its event's id. */
  readonly asked: Map<string, number>;
  /** How many announcements of each topic the current connection carried. */
  readonly announced: Map<string, number>;
  /** The number of the relay's `SILENT_AFTER_ANNOUNCEMENT`th announcement of a topic on the current connection. */
  silentAfter: number | undefined;
  /** The number of the newest request the relay answered on the current connection, or 0. */
  lastAnswered: number;
  readonly subscriptions: Map<string, Subscription>;
  readonly announcements: Map<string, string>;
}

const stopAnnouncing = { stopAnnouncing: true } as const;

/**
 * The announcement of a topic on a relay's connection that the relay's silence
 * counts from. Trystero's topic strategy sends a room's third announcement on a
 * relay 766 ms after its first, and the public relays that answered on
 * 2026-11-07 answered a subscription within 214 ms and an event within 429 ms.
 */
const SILENT_AFTER_ANNOUNCEMENT = 3;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The reason a relay stated, after a colon, where it stated one. */
function withReason(reason: unknown): string {
  return typeof reason === 'string' && reason !== '' ? `: ${reason}` : '';
}

/** The id of an event that `createEvent` wrote, an EVENT message. */
function eventId(event: string): string | undefined {
  const [, value] = JSON.parse(event) as unknown[];
  return isRecord(value) && typeof value.id === 'string' ? value.id : undefined;
}

/**
 * Keeps a page on public relays that answer: the first `count` relays of
 * `urls` that it hasn't stopped using. It judges a relay only while another
 * relay is open, and a relay that stays silent only once other relays answer,
 * so that a page whose network is down doesn't stop using any. It stops using
 * a relay
 *
 * - whose connection closes before it opens, while another relay is open;
 * - whose connection closes before the relay answered the board's
 *   subscription, while another relay is open;
 * - that refuses one of the board's events, with an `OK` false that isn't a
 *   duplicate's;
 * - that ends one of the board's subscriptions with `CLOSED`;
 * - whose connection stays open while the relay doesn't answer the board's
 *   subscription or its events, once each other open relay that answers
 *   answered a request the board sent after the relay's
 *   `SILENT_AFTER_ANNOUNCEMENT`th announcement of a topic on that connection.
 *
 * It closes that relay's socket, which doesn't open again, so the console
 * stops logging the relay, and the next relay of `urls` replaces it. A relay
 * whose connection fails, or drops, while no relay is open keeps the
 * reconnections of `connect`, and gets a new connection, which the pool
 * judges, once another relay opens. Where every relay it holds failed and none
 * is open, it also connects the next relay of `urls`, and closes that one
 * again once the relays it holds don't need it. Each step runs on a socket's
 * open, close or message event: the pool doesn't set a timer of its own.
 */
export function createRelayPool({
  urls,
  count,
  connect = makeSocket,
  warn = (message) => console.warn(message),
}: RelayPoolOptions): RelayPool {
  const retiredUrls: string[] = [];
  /** How many requests of the board's the pool sent, which numbers each one. */
  let sent = 0;

  const isOpen = (relay: Candidate) => relay.openSocket !== undefined;
  const anyOpen = () => candidates.some(isOpen);
  const usable = () => candidates.filter((relay) => !relay.retired);
  const isHeld = (relay: Candidate) => {
    const index = usable().indexOf(relay);
    return index !== -1 && index < count;
  };

  /** Sends `data` where the socket is open, and numbers it where it asks for an answer to the id `asks`; returns whether it sent it. */
  const send = (relay: Candidate, data: string, asks?: string): boolean => {
    if (!isOpen(relay)) return false;
    relay.client?.send(data);
    if (asks !== undefined) {
      sent += 1;
      relay.asked.set(asks, sent);
    }
    return true;
  };

  const sendEvent = async (relay: Candidate, topic: string, payload: string, isAnnouncement: boolean) => {
    if (!isOpen(relay)) return;
    // A new nonce in each announcement, as Trystero's Nostr strategy writes one, so that two announcements differ.
    const content = isAnnouncement ? toJson({ ...fromJson<Record<string, unknown>>(payload), nonce: genId(8) }) : payload;
    const event = await createEvent(topic, content);
    if (!send(relay, event, eventId(event)) || !isAnnouncement) return;
    const announced = (relay.announced.get(topic) ?? 0) + 1;
    relay.announced.set(topic, announced);
    if (announced === SILENT_AFTER_ANNOUNCEMENT && relay.silentAfter === undefined) relay.silentAfter = sent;
  };

  function disconnect(relay: Candidate): void {
    const client = relay.client;
    relay.client = undefined;
    relay.openSocket = undefined;
    relay.opening = false;
    client?.close?.();
  }

  function retire(relay: Candidate, reason: string): void {
    relay.retired = true;
    disconnect(relay);
    retiredUrls.push(relay.url);
    warn?.(`Chalkline: stopped using the relay ${relay.url}, which ${reason}`);
  }

  function connectFresh(relay: Candidate): void {
    disconnect(relay);
    relay.opening = true;
    const client: SocketClient = connect(
      relay.url,
      (data) => onMessage(relay, client, data),
      () => onOpen(relay, client),
    );
    relay.client = client;
    const first = client.socket;
    let opened = false;
    first.addEventListener('open', () => {
      opened = true;
      onOpen(relay, client);
    });
    first.addEventListener('close', () => {
      if (!opened) onFirstClose(relay, client);
    });
    // Where the first connection failed, the client's reconnection may open the socket later.
    void client.ready.then(() => onOpen(relay, client));
  }

  function onOpen(relay: Candidate, client: SocketClient): void {
    if (relay.client !== client || relay.retired) return;
    const socket = client.socket;
    if (relay.openSocket === socket) return;
    relay.openSocket = socket;
    relay.opening = false;
    relay.answered = false;
    relay.asked.clear();
    relay.announced.clear();
    relay.silentAfter = undefined;
    relay.lastAnswered = 0;
    socket.addEventListener('close', () => onClose(relay, client, socket));
    for (const [topic, { subId }] of relay.subscriptions) send(relay, subscription(subId, topic), subId);
    for (const [topic, payload] of relay.announcements) void sendEvent(relay, topic, payload, true);
    // The network works, so each relay whose connection failed while none was open gets a new one, which the pool judges.
    for (const other of candidates) {
      if (other.client !== undefined && !other.opening && !isOpen(other)) connectFresh(other);
    }
    settle();
  }

  function onFirstClose(relay: Candidate, client: SocketClient): void {
    if (relay.client !== client) return;
    relay.opening = false;
    if (anyOpen()) retire(relay, 'closed its connection before it opened, while another relay was open');
    settle();
  }

  function onClose(relay: Candidate, client: SocketClient, socket: SocketClient['socket']): void {
    if (relay.client !== client || relay.openSocket !== socket) return;
    relay.openSocket = undefined;
    // While no relay is open, and for a relay without a subscription, the client's reconnection opens the socket again.
    if (anyOpen()) {
      if (!isHeld(relay)) disconnect(relay);
      else if (relay.subscriptions.size > 0) {
        if (relay.answered) connectFresh(relay);
        else retire(relay, "closed its connection before it answered the board's subscription, while another relay was open");
      }
    }
    settle();
  }

  function onMessage(relay: Candidate, client: SocketClient, data: string): void {
    if (relay.client !== client) return;
    let message: unknown;
    try {
      message = JSON.parse(data);
    } catch {
      return;
    }
    if (!Array.isArray(message)) return;
    const [type, id, value, reason] = message as unknown[];
    const ours = [...relay.subscriptions.values()].some((sub) => sub.subId === id);
    if (type === 'EVENT') {
      if (ours && isRecord(value)) deliver(relay, id, value);
      return;
    }
    if (type === 'EOSE') {
      if (ours) answer(relay, id);
      return;
    }
    if (type === 'OK' && value === true) {
      answer(relay, id);
      if (typeof id === 'string') relay.asked.delete(id);
      return;
    }
    if (type === 'OK' && value === false) {
      if (typeof reason === 'string' && reason.startsWith('duplicate:')) return;
      retire(relay, `refused one of the board's events${withReason(reason)}`);
    } else if (type === 'CLOSED' && ours) {
      retire(relay, `ended the board's subscription${withReason(value)}`);
    } else return;
    settle();
  }

  function deliver(relay: Candidate, subId: unknown, event: Record<string, unknown>): void {
    const { content, tags } = event;
    if (typeof content !== 'string' || !Array.isArray(tags)) return;
    const tag: unknown = tags.find((entry: unknown) => Array.isArray(entry) && entry[0] === 'x');
    const topic = Array.isArray(tag) && typeof tag[1] === 'string' ? tag[1] : undefined;
    if (topic === undefined) return;
    const sub = relay.subscriptions.get(topic);
    if (sub === undefined || sub.subId !== subId) return;
    answer(relay, subId);
    sub.onMessage(topic, content);
  }

  /** Notes that `relay` answered the request of `id`, and stops using each relay that stays silent past that answer. */
  function answer(relay: Candidate, id: unknown): void {
    relay.answered = true;
    const asked = typeof id === 'string' ? relay.asked.get(id) : undefined;
    if (asked === undefined || asked <= relay.lastAnswered) return;
    relay.lastAnswered = asked;
    if (retireSilent()) settle();
  }

  /**
   * Stops using each open relay that hasn't answered since its connection
   * opened, where each other open relay that answers answered a request sent
   * after the relay's `silentAfter`. A page whose network is down doesn't get
   * an answer, so it doesn't judge any relay. Returns whether it stopped using
   * one.
   */
  function retireSilent(): boolean {
    const answering = candidates.filter((relay) => isOpen(relay) && relay.answered);
    if (answering.length === 0) return false;
    let stopped = false;
    for (const relay of candidates) {
      const after = relay.silentAfter;
      if (relay.retired || relay.answered || !isOpen(relay) || after === undefined) continue;
      if (!answering.every((other) => other.lastAnswered > after)) continue;
      retire(relay, "didn't answer the board's requests, while each other relay that answers answered a later one");
      stopped = true;
    }
    return stopped;
  }

  function settle(): void {
    const current = usable();
    const held = current.slice(0, count);
    const extra = current[count];
    for (const relay of held) {
      if (relay.client === undefined) connectFresh(relay);
      else if (isOpen(relay) && !relay.resolved) {
        relay.resolved = true;
        relay.resolve(relay);
      }
    }
    const heldOpening = held.some((relay) => relay.opening);
    if (extra !== undefined) {
      const needed = !anyOpen() && !heldOpening;
      if (needed && extra.client === undefined) connectFresh(extra);
      else if (!needed && extra.client !== undefined && !extra.opening && !heldOpening) disconnect(extra);
    }
    for (const relay of current.slice(count + 1)) {
      if (relay.client !== undefined && !relay.opening) disconnect(relay);
    }
  }

  function candidate(url: string): Candidate {
    let resolve: (relay: PoolRelay) => void = () => undefined;
    const ready = new Promise<PoolRelay>((done) => {
      resolve = done;
    });
    const relay: Candidate = {
      url,
      ready,
      resolve: (value) => resolve(value),
      resolved: false,
      retired: false,
      client: undefined,
      openSocket: undefined,
      opening: false,
      answered: false,
      asked: new Map(),
      announced: new Map(),
      silentAfter: undefined,
      lastAnswered: 0,
      subscriptions: new Map(),
      announcements: new Map(),
      subscribe(topic, onMessage) {
        const subId = genId(64);
        relay.subscriptions.set(topic, { subId, onMessage });
        send(relay, subscription(subId, topic), subId);
        return () => {
          if (relay.subscriptions.get(topic)?.subId !== subId) return;
          relay.subscriptions.delete(topic);
          relay.announcements.delete(topic);
          send(relay, toJson(['CLOSE', subId]));
        };
      },
      async publish(topic, msg, isAnnouncement) {
        if (relay.retired) return isAnnouncement ? stopAnnouncing : undefined;
        const payload = typeof msg === 'string' ? msg : toJson(msg);
        if (isAnnouncement) relay.announcements.set(topic, payload);
        await sendEvent(relay, topic, payload, isAnnouncement);
        return undefined;
      },
      unpublish(topic) {
        relay.announcements.delete(topic);
      },
    };
    return relay;
  }

  const candidates = urls.map(candidate);
  settle();
  return {
    relays: candidates,
    held: () => usable().slice(0, count).map((relay) => relay.url),
    retired: () => [...retiredUrls],
  };
}

/** One pool for each app id and count, which every room of the page shares, as Trystero keeps one socket for each relay. */
const pools = new Map<string, RelayPool>();

function poolFor(config: JoinRoomConfig): RelayPool {
  const count = config.relayConfig?.redundancy ?? TRYSTERO_RELAY_COUNT;
  const key = `${count} ${config.appId}`;
  let pool = pools.get(key);
  if (pool === undefined) {
    pool = createRelayPool({
      urls: publicRelayOrder(config.appId),
      count,
      warn: config.relayConfig?.warnOnRelayFailure === false ? null : undefined,
    });
    pools.set(key, pool);
  }
  return pool;
}

/**
 * Joins a board's room through public Nostr relays that answer, as
 * `createRelayPool` keeps them, in the order `publicRelayOrder` returns for the
 * config's app id. Trystero's topic strategy runs the room, with the events,
 * subscriptions and announcements of Trystero's Nostr strategy, so that a page
 * that joins through this finds a page that joins through Trystero's
 * `joinRoom` on each relay both use. It doesn't read `relayConfig.urls`:
 * `joinBoardRoom` joins a config that lists relays through Trystero's
 * `joinRoom`.
 */
export const joinPublicRelayRoom: JoinRoom = createTopicStrategy<PoolRelay>({
  init: (config) => poolFor(config).relays.map((relay) => relay.ready),
  subscribeTopic: (relay, topic, onMessage) => relay.subscribe(topic, (from, content) => void onMessage(from, content)),
  publishTopic: (relay, topic, msg, { kind }) => relay.publish(topic, msg, kind === 'announce'),
  unpublishTopic: (relay, topic) => relay.unpublish(topic),
});
