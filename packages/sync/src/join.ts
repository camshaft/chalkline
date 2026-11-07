import { joinRoom as joinNostrRoom, type JoinRoomCallbacks, type JoinRoomConfig, type Room } from '@trystero-p2p/nostr';
import { joinRoom as joinRelayRoom } from '@trystero-p2p/ws-relay';

/**
 * The public Nostr relays that a board's participants find each other
 * through, where the config doesn't list relays of its own, as Connection
 * settings lists a person's. Each is one of the relays Trystero lists as its
 * defaults, in the order Trystero ranks them for Chalkline's app id.
 *
 * Without a list, Trystero joins the first five relays of that order. On
 * 2026-11-07 wss://0x-nostr-relay.fly.dev's host name didn't resolve,
 * wss://nostr.red5d.dev closed each connection before it opened, and
 * wss://relay.layer.systems refused Trystero's announcements as rate-limited,
 * since it takes 2 events every 3 minutes from an address and Trystero
 * announces once a minute. This list holds the first five relays of the order
 * that answered and accepted the announcements. It keeps
 * wss://relay.piazza.today and wss://testr.nymble.world, which a page loaded
 * before the list joins too, so that the two pages still find each other.
 */
export const PUBLIC_RELAYS: readonly string[] = [
  'wss://relay.piazza.today',
  'wss://testr.nymble.world',
  'wss://nos.lol',
  'wss://relay.aarpia.com',
  'wss://relay.routstr.com',
];

/** `config`, with `PUBLIC_RELAYS` as its Nostr relays where it doesn't list any. */
function withPublicRelays(config: JoinRoomConfig): JoinRoomConfig {
  const urls = config.relayConfig?.urls;
  if (urls !== undefined && urls.length > 0) return config;
  return { ...config, relayConfig: { ...config.relayConfig, urls: [...PUBLIC_RELAYS] } };
}

/**
 * Joins a board's Trystero room. Where `relays` lists WebSocket relays, as
 * `relaysFromAddress` reads them from the address of a page that the
 * local-network mode serves, the room's participants find each other through
 * those relays alone; where it lists none, they find each other through the
 * Nostr relays `config.relayConfig.urls` lists, or through `PUBLIC_RELAYS`
 * where it lists none. The rest of `config` passes on as it is, and `relays`,
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
  if (relays.length === 0) return joinNostrRoom(withPublicRelays(config), roomId, callbacks);
  return joinRelayRoom({ ...config, relayConfig: { ...config.relayConfig, urls: relays } }, roomId, callbacks);
}
