import {
  applyAwarenessUpdate,
  encodeAwarenessUpdate,
  removeAwarenessStates,
  type Awareness,
} from 'y-protocols/awareness';
import { sender, type Transport } from './sync';

/** The origin of an awareness change that came from a peer. */
class FromPeer {
  constructor(readonly peerId: string) {}
}

/** The clients an awareness `update` event lists, by their ids. */
interface AwarenessChanges {
  added: number[];
  updated: number[];
  removed: number[];
}

export interface AwarenessOptions {
  /** Called where a send fails, such as on a channel that closed. */
  onSendError?: (error: unknown) => void;
}

/**
 * Carries `awareness`, each participant's cursor, name and selection, between
 * the peers of `transport`, outside the stored document. This participant
 * sends its own state alone: to each peer that joins, and to every peer as it
 * changes, since every peer connects to every other. A peer's states are
 * removed as it leaves, and show again when it comes back.
 *
 * Returns a function that stops carrying awareness.
 */
export function connectAwareness(
  awareness: Awareness,
  transport: Transport,
  options: AwarenessOptions = {},
): () => void {
  const send = sender(transport, options.onSendError);
  const own = () => encodeAwarenessUpdate(awareness, [awareness.clientID]);
  // The awareness clients whose states each peer sent.
  const clients = new Map<string, Set<number>>();
  let stopped = false;

  transport.onPeerJoin((peerId) => {
    if (!stopped && awareness.getLocalState() !== null) send('awareness', own(), peerId);
  });
  transport.onMessage((channel, data, from) => {
    if (!stopped && channel === 'awareness') applyAwarenessUpdate(awareness, data, new FromPeer(from));
  });
  const stopLeaves = transport.onPeerLeave((peerId) => {
    const gone = [...(clients.get(peerId) ?? [])];
    clients.delete(peerId);
    removeAwarenessStates(awareness, gone, new FromPeer(peerId));
    // y-protocols keeps a removed client's clock and ignores a later state at
    // that clock. Forget the peer's clients, so that its state shows again when
    // it comes back without having changed.
    for (const client of gone) awareness.meta.delete(client);
  });

  const onUpdate = ({ added, updated, removed }: AwarenessChanges, origin: unknown) => {
    if (origin instanceof FromPeer) {
      const sent = clients.get(origin.peerId) ?? new Set<number>();
      for (const client of [...added, ...updated]) sent.add(client);
      for (const client of removed) sent.delete(client);
      if (sent.size === 0) clients.delete(origin.peerId);
      else clients.set(origin.peerId, sent);
      return;
    }
    if ([...added, ...updated, ...removed].includes(awareness.clientID)) send('awareness', own());
  };
  awareness.on('update', onUpdate);

  return () => {
    stopped = true;
    stopLeaves();
    awareness.off('update', onUpdate);
  };
}
