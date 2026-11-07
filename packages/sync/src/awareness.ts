import {
  applyAwarenessUpdate,
  encodeAwarenessUpdate,
  removeAwarenessStates,
  type Awareness,
} from 'y-protocols/awareness';
import { reachOf } from './reach';
import { FromPeer, sender, type Transport } from './sync';

/** The origin of the removal of the states that a peer that no connected peer reaches had sent. */
const UNREACHED = Symbol('chalkline.unreached');

/** The clients an awareness `update` event lists, by their ids. */
interface AwarenessChanges {
  added: number[];
  updated: number[];
  removed: number[];
}

/** One client's entry in an awareness message: its id, its clock, and its state as JSON text. */
interface Entry {
  client: number;
  clock: number;
  state: string;
  /** Whether the state is null, which removes the client's state. */
  removal: boolean;
}

/** The entries of an awareness message, as y-protocols encodes them, or null for a message that isn't one. */
function readEntries(data: Uint8Array): Entry[] | null {
  let position = 0;
  const readNumber = (): number => {
    let value = 0;
    let scale = 1;
    while (position < data.length) {
      const byte = data[position];
      position += 1;
      value += (byte & 0x7f) * scale;
      if (byte < 0x80) return value;
      scale *= 128;
      if (value > Number.MAX_SAFE_INTEGER) throw new RangeError('a number is out of range');
    }
    throw new RangeError('the message ends inside a number');
  };
  const decoder = new TextDecoder('utf-8', { fatal: true });
  try {
    const entries: Entry[] = [];
    const count = readNumber();
    for (let index = 0; index < count; index += 1) {
      const client = readNumber();
      const clock = readNumber();
      const length = readNumber();
      if (position + length > data.length) return null;
      const state = decoder.decode(data.subarray(position, position + length));
      position += length;
      entries.push({ client, clock, state, removal: JSON.parse(state) === null });
    }
    return entries;
  } catch {
    return null;
  }
}

/** An awareness message that holds `entries`, encoded as y-protocols encodes one. */
function writeEntries(entries: Entry[]): Uint8Array {
  const bytes: number[] = [];
  const writeNumber = (number: number) => {
    let rest = number;
    while (rest > 0x7f) {
      bytes.push(0x80 | (rest % 128));
      rest = Math.floor(rest / 128);
    }
    bytes.push(rest);
  };
  const encoder = new TextEncoder();
  writeNumber(entries.length);
  for (const { client, clock, state } of entries) {
    writeNumber(client);
    writeNumber(clock);
    const text = encoder.encode(state);
    writeNumber(text.length);
    for (const byte of text) bytes.push(byte);
  }
  return new Uint8Array(bytes);
}

export interface AwarenessOptions {
  /** Called where a send fails, such as on a channel that closed. */
  onSendError?: (error: unknown) => void;
}

/**
 * Carries `awareness`, each participant's cursor, name and selection, between
 * the peers of `transport`, outside the stored document, and through them to
 * the peers that it doesn't connect to. Each change of this participant's
 * state goes to every connected peer, and a peer that joins gets this
 * participant's state with each state that a connected peer sent. A change
 * from a peer goes on to each connected peer that the sender's newest list of
 * peers leaves out. As a peer leaves, the states that it sent are removed once
 * no connected peer's list holds it, and the removal goes to every connected
 * peer. A participant that is still connected through another peer answers the
 * removal of its state with a newer one, and a peer's states show again when it
 * comes back.
 *
 * Returns a function that stops carrying awareness.
 */
export function connectAwareness(
  awareness: Awareness,
  transport: Transport,
  options: AwarenessOptions = {},
): () => void {
  const reach = reachOf(transport, options.onSendError);
  const send = sender(transport, options.onSendError);
  const self = awareness.clientID;
  const own = () => encodeAwarenessUpdate(awareness, [self]);
  // The other clients whose states each connected peer sent and still holds.
  const clients = new Map<string, Set<number>>();
  // The clients that each peer whose link ended had sent, while a connected peer's list still holds that peer.
  const departed = new Map<string, Set<number>>();
  let stopped = false;

  /** Whether a connected peer other than `except` sent `client`'s state. */
  const heardFrom = (client: number, except?: string): boolean => {
    for (const [peerId, sent] of clients) if (peerId !== except && sent.has(client)) return true;
    return false;
  };

  /** Sends this participant's state, and each state that a connected peer sent, to `target`, or to every peer. */
  const sendStates = (target?: string) => {
    const held = [...awareness.getStates().keys()].filter((client) => client === self || heardFrom(client));
    if (held.length > 0) send('awareness', encodeAwarenessUpdate(awareness, held), target);
  };

  /** Raises this participant's clock, so that its state outranks a removal of it that a peer carries on at the old clock. */
  const renew = () => {
    const meta = awareness.meta.get(self);
    if (awareness.getLocalState() !== null && meta !== undefined) {
      awareness.meta.set(self, { clock: meta.clock + 1, lastUpdated: meta.lastUpdated });
    }
  };

  /**
   * Removes the states that a departed peer sent, once no connected peer's list
   * holds that peer, and sends the removal to every connected peer. A state that
   * another peer sent too may belong to a participant that is still connected,
   * which answers the removal with a newer state.
   */
  const forgetUnreached = () => {
    for (const [peerId, sent] of [...departed]) {
      if (reach.listed(peerId)) continue;
      departed.delete(peerId);
      const states = awareness.getStates();
      const gone = [...sent].filter((client) => states.has(client));
      if (gone.length === 0) continue;
      removeAwarenessStates(awareness, gone, UNREACHED);
      send('awareness', encodeAwarenessUpdate(awareness, gone));
      // y-protocols keeps a removed client's clock and ignores a later state at
      // that clock. Forget the clients, so that a state shows again when its
      // peer comes back without having changed.
      for (const client of gone) awareness.meta.delete(client);
    }
  };

  transport.onPeerJoin((peerId) => {
    if (stopped) return;
    departed.delete(peerId);
    renew();
    sendStates(peerId);
  });
  transport.onMessage((channel, data, from) => {
    if (stopped || channel !== 'awareness') return;
    const entries = readEntries(data);
    if (entries === null) return;
    const states = awareness.getStates();
    const sent = clients.get(from) ?? new Set<number>();
    // A removal of another client's state applies only where no other connected peer sent that state.
    const kept = entries.filter(({ client, removal }) => {
      if (client === self) return true;
      if (!removal) {
        sent.add(client);
        return true;
      }
      sent.delete(client);
      return states.has(client) && !heardFrom(client, from);
    });
    if (sent.size === 0) clients.delete(from);
    else clients.set(from, sent);
    if (kept.length === 0) return;
    applyAwarenessUpdate(awareness, kept.length === entries.length ? data : writeEntries(kept), new FromPeer(from));
  });
  const stopLeaves = transport.onPeerLeave((peerId) => {
    const sent = clients.get(peerId);
    clients.delete(peerId);
    if (sent !== undefined) departed.set(peerId, new Set([...(departed.get(peerId) ?? []), ...sent]));
    forgetUnreached();
    sendStates();
  });
  const stopChanges = reach.onChange((dropped) => {
    forgetUnreached();
    if (dropped) sendStates();
  });

  const onUpdate = ({ added, updated, removed }: AwarenessChanges, origin: unknown) => {
    for (const [peerId, sent] of clients) {
      for (const client of removed) sent.delete(client);
      if (sent.size === 0) clients.delete(peerId);
    }
    if (origin === UNREACHED) return;
    if (origin instanceof FromPeer) {
      const others = [...added, ...updated, ...removed].filter((client) => client !== self);
      if (others.length > 0) {
        const update = encodeAwarenessUpdate(awareness, others);
        for (const peerId of reach.targets(origin.peerId)) send('awareness', update, peerId);
      }
      // As after a peer leaves, forget a removed client's clock, so that its state shows again at that clock.
      for (const client of removed) if (client !== self) awareness.meta.delete(client);
      // y-protocols answers a peer's removal of this participant's state by raising its clock: send that state.
      if (removed.includes(self) && awareness.getLocalState() !== null) send('awareness', own());
      return;
    }
    if ([...added, ...updated, ...removed].includes(self)) send('awareness', own());
  };
  awareness.on('update', onUpdate);

  return () => {
    stopped = true;
    stopLeaves();
    stopChanges();
    awareness.off('update', onUpdate);
  };
}
