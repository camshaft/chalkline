/** The query parameter of a board's address that names a WebSocket relay to find the other participants through. */
export const RELAY_PARAM = 'relay';

/** The WebSocket scheme of each scheme a relay may be written with. */
const WEBSOCKET_SCHEMES = new Map<string, string>([
  ['ws:', 'ws:'],
  ['wss:', 'wss:'],
  ['http:', 'ws:'],
  ['https:', 'wss:'],
]);

/**
 * The WebSocket relays that a board's address names, one for each `relay`
 * query parameter that isn't blank, in order. Each one is resolved against the
 * address, so the local-network mode's `?relay=/relay` names the relay on the
 * machine that served the page, and an http or https relay takes the matching
 * WebSocket scheme. An address without a relay names none, and the board then
 * finds its participants through the public Nostr relays.
 *
 * Throws where a relay isn't a WebSocket, http or https address.
 */
export function relaysFromAddress(address: string | URL): string[] {
  const base = new URL(address);
  const relays: string[] = [];
  for (const value of base.searchParams.getAll(RELAY_PARAM)) {
    const written = value.trim();
    if (written === '') continue;
    let relay: URL;
    try {
      relay = new URL(written, base);
    } catch {
      throw new Error(`The address names the relay ${JSON.stringify(value)}, which isn't a WebSocket address.`);
    }
    const scheme = WEBSOCKET_SCHEMES.get(relay.protocol);
    if (scheme === undefined) {
      throw new Error(`The address names the relay ${JSON.stringify(value)}, which isn't a WebSocket address.`);
    }
    relay.protocol = scheme;
    // A WebSocket address can't hold a fragment.
    relay.hash = '';
    relays.push(relay.href);
  }
  return relays;
}
