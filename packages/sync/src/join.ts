import { joinRoom as joinNostrRoom, type JoinRoomCallbacks, type JoinRoomConfig, type Room } from '@trystero-p2p/nostr';
import { joinRoom as joinRelayRoom } from '@trystero-p2p/ws-relay';

/**
 * Joins a board's Trystero room. Where `relays` lists WebSocket relays, as
 * `relaysFromAddress` reads them from the address of a page that the
 * local-network mode serves, the room's participants find each other through
 * those relays alone; where it lists none, they find each other through the
 * public Nostr relays. The rest of `config` passes on as it is, and `relays`,
 * where it lists any, takes the place of `config.relayConfig.urls`.
 *
 * This module isn't part of the package's index, so that importing the index
 * doesn't load a Trystero strategy.
 */
export function joinBoardRoom(
  config: JoinRoomConfig,
  roomId: string,
  relays: string[],
  callbacks?: JoinRoomCallbacks,
): Room {
  if (relays.length === 0) return joinNostrRoom(config, roomId, callbacks);
  return joinRelayRoom({ ...config, relayConfig: { ...config.relayConfig, urls: relays } }, roomId, callbacks);
}
