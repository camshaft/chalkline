import * as Y from 'yjs';
import { reachOf } from './reach';

/**
 * The messages the adapter sends: `state` asks a peer for the updates the
 * sender lacks, `diff` answers it, `update` carries each change, `awareness`
 * carries a participant's awareness state, `peers` lists the peers the sender
 * connects to, and `resync`, which a peer sends as one of its links ends, asks
 * for the updates the sender lacks and for the receiver's state.
 */
export type Channel = 'state' | 'diff' | 'update' | 'awareness' | 'peers' | 'resync';

/** What the adapter needs from the network, so that tests can run it in memory. */
export interface Transport {
  /** Sends to `target`, or to every connected peer where `target` is left out. */
  send(channel: Channel, data: Uint8Array, target?: string): void | Promise<unknown>;
  onMessage(handler: (channel: Channel, data: Uint8Array, from: string) => void): void;
  onPeerJoin(handler: (peerId: string) => void): void;
  /** Calls `handler` as each peer leaves, and returns a function that stops it. */
  onPeerLeave(handler: (peerId: string) => void): () => void;
}

/** The transaction origin of an update, and of an awareness change, that came from a peer, with that peer's id. */
export class FromPeer {
  constructor(readonly peerId: string) {}
}

export interface ConnectOptions {
  /** Called once a peer has answered this document's state with the updates it lacked. */
  onSynced?: (peerId: string) => void;
  /** Called where a send fails, such as on a channel that closed. */
  onSendError?: (error: unknown) => void;
}

/** Sends on `transport`, and passes each failed send to `onSendError`, whether the send throws or rejects. */
export function sender(
  transport: Transport,
  onSendError?: (error: unknown) => void,
): (channel: Channel, data: Uint8Array, target?: string) => void {
  return (channel, data, target) => {
    try {
      const sent = transport.send(channel, data, target);
      if (sent instanceof Promise) sent.catch((error: unknown) => onSendError?.(error));
    } catch (error) {
      onSendError?.(error);
    }
  };
}

/** The updates a document holds that it can't apply yet, as Yjs keeps them. */
interface Pending {
  structs: Uint8Array | null;
  deletes: Uint8Array | null;
}

function pendingOf(doc: Y.Doc): Pending {
  return { structs: doc.store.pendingStructs?.update ?? null, deletes: doc.store.pendingDs };
}

function sameBytes(a: Uint8Array | null, b: Uint8Array | null): boolean {
  if (a === null || b === null) return a === b;
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) if (a[index] !== b[index]) return false;
  return true;
}

/** Whether `after` holds pending updates that `before` didn't hold. */
function morePending(before: Pending, after: Pending): boolean {
  return (
    (after.structs !== null && !sameBytes(before.structs, after.structs)) ||
    (after.deletes !== null && !sameBytes(before.deletes, after.deletes))
  );
}

/** A digest of `bytes`, their 32-bit FNV-1a hash and their length, which tells one update from another. */
function digest(bytes: Uint8Array): string {
  let hash = 0x811c9dc5;
  for (const byte of bytes) hash = Math.imul(hash ^ byte, 0x01000193);
  return `${(hash >>> 0).toString(16)}:${bytes.length}`;
}

/**
 * Keeps `doc` in sync with every peer of `transport`, and through them with the
 * peers that it doesn't connect to. Each peer that joins, or comes back after
 * its link broke, is asked for the updates this document lacks, and each local
 * change goes to every connected peer. An update from a peer that changes this
 * document goes on to each connected peer that the sender's newest list of
 * peers leaves out; an update that leaves updates this document can't apply
 * yet goes on to every connected peer but the sender, since they may lack the
 * same earlier updates. A copy that holds an update already doesn't change on
 * it, so it doesn't send it on. As a link ends, or a peer's list drops a peer
 * that this participant connects to, this document asks each connected peer
 * again for the updates it lacks.
 *
 * Returns a function that stops sending local changes and carrying updates on.
 */
export function connectDoc(doc: Y.Doc, transport: Transport, options: ConnectOptions = {}): () => void {
  const reach = reachOf(transport, options.onSendError);
  const send = sender(transport, options.onSendError);
  let stopped = false;
  // The origin of the update this function applies now, and whether that update changed the document.
  const applying: { origin: FromPeer | null; changed: boolean } = { origin: null, changed: false };
  // The digests of the updates sent on to every peer since the document last had no pending updates.
  const flooded = new Set<string>();

  const resync = () => {
    if (stopped) return;
    const vector = Y.encodeStateVector(doc);
    for (const peerId of reach.connected()) send('resync', vector, peerId);
  };

  /** Applies `update` from the peer `from`, and sends it on to the connected peers that may lack it. */
  const apply = (update: Uint8Array, from: string) => {
    const before = pendingOf(doc);
    const origin = new FromPeer(from);
    applying.origin = origin;
    applying.changed = false;
    try {
      Y.applyUpdate(doc, update, origin);
    } finally {
      applying.origin = null;
    }
    if (stopped) return;
    const after = pendingOf(doc);
    if (after.structs === null && after.deletes === null) flooded.clear();
    const key = morePending(before, after) ? digest(update) : null;
    if (key !== null && !flooded.has(key)) {
      flooded.add(key);
      for (const peerId of reach.connected()) if (peerId !== from) send('update', update, peerId);
    } else if (applying.changed) {
      for (const peerId of reach.targets(from)) send('update', update, peerId);
    }
  };

  transport.onPeerJoin((peerId) => send('state', Y.encodeStateVector(doc), peerId));
  const stopLeaves = transport.onPeerLeave(() => resync());
  transport.onMessage((channel, data, from) => {
    // The awareness channel is connectAwareness's, and the peers channel is reach.ts's.
    switch (channel) {
      case 'state':
        send('diff', Y.encodeStateAsUpdate(doc, data), from);
        break;
      case 'resync':
        send('diff', Y.encodeStateAsUpdate(doc, data), from);
        send('state', Y.encodeStateVector(doc), from);
        break;
      case 'diff':
        apply(data, from);
        options.onSynced?.(from);
        break;
      case 'update':
        apply(data, from);
        break;
    }
  });

  const onUpdate = (update: Uint8Array, origin: unknown) => {
    if (origin instanceof FromPeer) {
      if (origin === applying.origin) applying.changed = true;
      return;
    }
    send('update', update);
  };
  doc.on('update', onUpdate);
  const stopResyncs = reach.onChange((dropped) => {
    if (dropped) resync();
  });

  return () => {
    stopped = true;
    stopLeaves();
    stopResyncs();
    doc.off('update', onUpdate);
  };
}
