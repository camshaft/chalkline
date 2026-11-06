import type { MessageAction, Room } from '@trystero-p2p/nostr';
import type { Channel, Transport } from './sync';

/** The Trystero action that carries each channel. Trystero takes an action name of at most 12 bytes. */
export const ACTIONS: Record<Channel, string> = {
  state: 'y-state',
  diff: 'y-diff',
  update: 'y-update',
  awareness: 'y-awareness',
};

/** A `Transport` over a Trystero room, with the room's peers. */
export interface RoomTransport extends Transport {
  peers(): string[];
}

/** The bytes of a binary message, or null for a message that isn't binary. */
export function toBytes(data: unknown): Uint8Array | null {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return null;
}

/**
 * Carries the Yjs adapter's messages as Trystero actions. The room has one
 * handler of each kind, so this transport takes them over and passes each
 * join, leave and message on to every handler registered here.
 */
export function trysteroTransport(room: Room): RoomTransport {
  const joined = new Set<(peerId: string) => void>();
  const left = new Set<(peerId: string) => void>();
  const received = new Set<(channel: Channel, data: Uint8Array, from: string) => void>();
  room.onPeerJoin = (peerId) => {
    for (const handler of joined) handler(peerId);
  };
  room.onPeerLeave = (peerId) => {
    for (const handler of left) handler(peerId);
  };

  const actions = {} as Record<Channel, MessageAction<Uint8Array>>;
  for (const channel of Object.keys(ACTIONS) as Channel[]) {
    const action = room.makeAction<Uint8Array>(ACTIONS[channel]);
    action.onMessage = (data, { peerId }) => {
      const bytes = toBytes(data);
      if (bytes === null) return;
      for (const handler of received) handler(channel, bytes, peerId);
    };
    actions[channel] = action;
  }

  return {
    send: (channel, data, target) => actions[channel].send(data, target === undefined ? undefined : { target }),
    onMessage: (handler) => {
      received.add(handler);
    },
    onPeerJoin: (handler) => {
      joined.add(handler);
    },
    onPeerLeave: (handler) => {
      left.add(handler);
      return () => {
        left.delete(handler);
      };
    },
    peers: () => Object.keys(room.getPeers()),
  };
}
