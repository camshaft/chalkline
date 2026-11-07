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

/** An awareness message: its entries, as y-protocols encodes them, and the number its sender wrote after them. */
interface Message {
  entries: Entry[];
  /** The sender's number of the message, which rises with each message it sends, or undefined where it doesn't end with one. */
  sequence: number | undefined;
}

/** The entries of an awareness message and the number after them, or null for a message that isn't one. */
function readMessage(data: Uint8Array): Message | null {
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
    // y-protocols reads the entries alone, so it ignores the number after them.
    const sequence = position < data.length ? readNumber() : undefined;
    return { entries, sequence };
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

/** `update` with `sequence` written after its entries, as y-protocols writes a number. */
function withSequence(update: Uint8Array, sequence: number): Uint8Array {
  const bytes = [...update];
  let rest = sequence;
  while (rest > 0x7f) {
    bytes.push(0x80 | (rest % 128));
    rest = Math.trunc(rest / 128);
  }
  bytes.push(rest);
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
 * state goes to every connected peer, and a peer that joins gets every state
 * this participant holds. A change from a peer goes on to each connected peer
 * that the sender's newest list of peers leaves out, and a removal from a peer
 * goes on to every connected peer but the sender; where another connected peer
 * sent the removed state too, the removal doesn't apply, and goes on to that
 * peer instead, so that two peers that each sent the other the state don't
 * keep it. As a peer leaves, the states
 * that it sent are removed once no connected peer's list holds it, and the
 * removal goes to every connected peer. A participant that is still connected
 * through another peer answers the removal of its state with a newer one, and
 * a peer's states show again when it comes back. Each message ends with a
 * number that rises with each message its sender sends, so that an entry that
 * arrives after a newer one from the same peer doesn't undo it.
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
  // The number of the last awareness message this participant sent.
  let lastNumber = 0;
  /** Sends `update` to `target`, or to every peer, with the next number after its entries. */
  const sendUpdate = (update: Uint8Array, target?: string) => {
    lastNumber += 1;
    send('awareness', withSequence(update, lastNumber), target);
  };
  // The other clients whose states each connected peer sent and still holds.
  const clients = new Map<string, Set<number>>();
  // The clients that each peer whose link ended had sent, while a connected peer's list still holds that peer.
  const departed = new Map<string, Set<number>>();
  // The number of the newest message from each connected peer that held each client's entry.
  const newest = new Map<string, Map<number, number>>();
  let stopped = false;

  /** Whether a connected peer other than `except` sent `client`'s state. */
  const heardFrom = (client: number, except?: string): boolean => {
    for (const [peerId, sent] of clients) if (peerId !== except && sent.has(client)) return true;
    return false;
  };

  /**
   * Sends every state this participant holds to `target`, a peer that joins;
   * or, with `target` left out, this participant's state and each state that a
   * connected peer sent, to every peer.
   */
  const sendStates = (target?: string) => {
    const held = [...awareness.getStates().keys()].filter(
      (client) => target !== undefined || client === self || heardFrom(client),
    );
    if (held.length > 0) sendUpdate(encodeAwarenessUpdate(awareness, held), target);
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
      sendUpdate(encodeAwarenessUpdate(awareness, gone));
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
    const message = readMessage(data);
    if (message === null) return;
    const { entries, sequence } = message;
    // An entry from an older message than the newest one from the same peer that held its client arrived late.
    const heard = newest.get(from) ?? new Map<number, number>();
    newest.set(from, heard);
    const fresh = entries.filter(({ client }) => {
      if (sequence === undefined) return true;
      if ((heard.get(client) ?? 0) >= sequence) return false;
      heard.set(client, sequence);
      return true;
    });
    const states = awareness.getStates();
    const sent = clients.get(from) ?? new Set<number>();
    // A removal of another client's state applies only where no other connected peer sent that state. Where one
    // did, the removal goes on to that peer instead, which then doesn't count this peer as a sender of the state,
    // so that two peers that each sent the other the state don't both keep it.
    const held: Entry[] = [];
    const kept = fresh.filter((entry) => {
      const { client, removal } = entry;
      if (client === self) return true;
      if (!removal) {
        sent.add(client);
        return true;
      }
      sent.delete(client);
      if (!states.has(client)) return false;
      if (!heardFrom(client, from)) return true;
      held.push(entry);
      return false;
    });
    if (sent.size === 0) clients.delete(from);
    else clients.set(from, sent);
    if (held.length > 0) {
      for (const [peerId, sources] of [...clients]) {
        if (peerId === from) continue;
        const removals = held.filter(({ client }) => sources.has(client));
        if (removals.length > 0) sendUpdate(writeEntries(removals), peerId);
      }
    }
    if (kept.length === 0) return;
    applyAwarenessUpdate(awareness, kept.length === entries.length ? data : writeEntries(kept), new FromPeer(from));
  });
  const stopLeaves = transport.onPeerLeave((peerId) => {
    const sent = clients.get(peerId);
    clients.delete(peerId);
    newest.delete(peerId);
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
      const from = origin.peerId;
      const changed = [...added, ...updated].filter((client) => client !== self);
      if (changed.length > 0) {
        const update = encodeAwarenessUpdate(awareness, changed);
        for (const peerId of reach.targets(from)) sendUpdate(update, peerId);
      }
      // A removal goes on to every connected peer but the sender, since a peer
      // in the sender's list may hold the removed state from this participant.
      const gone = removed.filter((client) => client !== self);
      if (gone.length > 0) {
        const update = encodeAwarenessUpdate(awareness, gone);
        for (const peerId of reach.connected()) if (peerId !== from) sendUpdate(update, peerId);
      }
      // As after a peer leaves, forget a removed client's clock, so that its state shows again at that clock.
      for (const client of removed) if (client !== self) awareness.meta.delete(client);
      // y-protocols answers a peer's removal of this participant's state by raising its clock: send that state.
      if (removed.includes(self) && awareness.getLocalState() !== null) sendUpdate(own());
      return;
    }
    if ([...added, ...updated, ...removed].includes(self)) sendUpdate(own());
  };
  awareness.on('update', onUpdate);

  return () => {
    stopped = true;
    stopLeaves();
    stopChanges();
    awareness.off('update', onUpdate);
  };
}
