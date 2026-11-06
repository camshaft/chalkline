import * as Y from 'yjs';

/**
 * The messages the adapter sends: `state` asks a peer for the updates the
 * sender lacks, `diff` answers it, and `update` carries each local change.
 */
export type Channel = 'state' | 'diff' | 'update';

/** What the adapter needs from the network, so that tests can run it in memory. */
export interface Transport {
  /** Sends to `target`, or to every connected peer where `target` is left out. */
  send(channel: Channel, data: Uint8Array, target?: string): void | Promise<unknown>;
  onMessage(handler: (channel: Channel, data: Uint8Array, from: string) => void): void;
  onPeerJoin(handler: (peerId: string) => void): void;
}

/** The transaction origin of updates that came from another peer. */
export const REMOTE = Symbol('chalkline.remote');

export interface ConnectOptions {
  /** Called once a peer has answered this document's state with the updates it lacked. */
  onSynced?: (peerId: string) => void;
  /** Called where a send fails, such as on a channel that closed. */
  onSendError?: (error: unknown) => void;
}

/**
 * Keeps `doc` in sync with every peer of `transport`. Each peer that joins is
 * asked for the updates this document lacks, and each local change goes to
 * every connected peer. A change that came from a peer isn't sent on, since
 * every peer connects to every other.
 *
 * Returns a function that stops sending local changes.
 */
export function connectDoc(doc: Y.Doc, transport: Transport, options: ConnectOptions = {}): () => void {
  const send = (channel: Channel, data: Uint8Array, target?: string) => {
    try {
      const sent = transport.send(channel, data, target);
      if (sent instanceof Promise) sent.catch((error: unknown) => options.onSendError?.(error));
    } catch (error) {
      options.onSendError?.(error);
    }
  };

  transport.onPeerJoin((peerId) => send('state', Y.encodeStateVector(doc), peerId));
  transport.onMessage((channel, data, from) => {
    switch (channel) {
      case 'state':
        send('diff', Y.encodeStateAsUpdate(doc, data), from);
        break;
      case 'diff':
        Y.applyUpdate(doc, data, REMOTE);
        options.onSynced?.(from);
        break;
      case 'update':
        Y.applyUpdate(doc, data, REMOTE);
        break;
    }
  });

  const onUpdate = (update: Uint8Array, origin: unknown) => {
    if (origin !== REMOTE) send('update', update);
  };
  doc.on('update', onUpdate);
  return () => doc.off('update', onUpdate);
}
