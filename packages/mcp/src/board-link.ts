// The board that a helper's link opens: the room's name and password, the relays, and the TURN
// servers that the link's fragment carries, which chalkline-mcp and chalkline-mcp listen join
// the board's room with.
import {
  APP_ID,
  linkTurnServers,
  parseRoomFragment,
  relaysFromAddress,
  type RoomSecrets,
  type TurnServer,
} from '@chalkline/sync';

/** The board that a link opens. */
export interface BoardLink {
  /** The room's name and password, from the link's #room=<name>&key=<password> fragment. */
  room: RoomSecrets;
  /** The WebSocket relays the link's ?relay= parameters name, where the board's participants meet through a relay. */
  relays: string[];
  /** The servers the link's turn parameter carries, which the helper connects through beside Trystero's STUN servers. */
  turnServers: TurnServer[];
}

/**
 * Reads the board that `link` opens, or throws, with `usage` after the reason, where it isn't a
 * link, where its fragment lacks the room's name or its password, or where the helper can't read
 * its turn parameter. A page joins its board without a turn parameter it can't read, and says
 * so; a helper stops, since the person who started it can give it a fresh link.
 */
export function readBoardLink(link: string, usage: string): BoardLink {
  let address: URL;
  try {
    address = new URL(link);
  } catch {
    throw new Error(`${link} isn't a link.\n\n${usage}`);
  }
  const room = parseRoomFragment(address.hash);
  if (room === null) throw new Error(`The link lacks the #room=<name>&key=<password> fragment.\n\n${usage}`);
  const servers = linkTurnServers(address.hash);
  if ('error' in servers) {
    throw new Error(`${servers.error} Ask the person who shared the link to copy it again.\n\n${usage}`);
  }
  return { room, relays: relaysFromAddress(link), turnServers: servers.turnServers };
}

/** The config a helper joins its board's room with. */
export interface HelperJoinConfig {
  appId: string;
  password: string;
  /** The class Trystero makes each connection to a peer with: werift's, since Node.js has none of its own. */
  rtcPolyfill: typeof RTCPeerConnection;
  /** The link's servers, which Trystero sets as each connection's ICE servers, after its own STUN servers. */
  turnConfig?: TurnServer[];
}

/** The config the helper joins `board`'s room with, through connections of `rtcPolyfill`. */
export function joinConfig(board: BoardLink, rtcPolyfill: typeof RTCPeerConnection): HelperJoinConfig {
  const config: HelperJoinConfig = { appId: APP_ID, password: board.room.key, rtcPolyfill };
  if (board.turnServers.length > 0) {
    config.turnConfig = board.turnServers.map((server) => ({ ...server, urls: [...server.urls] }));
  }
  return config;
}

/** What the helper says it joins the room through: the relays, and the servers of the link's turn parameter where it carries any. */
export function routeText(board: BoardLink): string {
  const relays = board.relays.length > 0 ? board.relays.join(', ') : 'the public Nostr relays';
  const count = board.turnServers.length;
  if (count === 0) return relays;
  return `${relays}, with ${count === 1 ? 'the server' : `the ${count} servers`} of the link's turn parameter`;
}

const TURN_ADDRESS = /^turns?:/i;

/**
 * The line a helper logs where a peer couldn't connect: the peer and the reason, and, where the
 * link carries a TURN server, that its password may have expired.
 */
export function joinErrorLine(board: BoardLink, peerId: string, error: string): string {
  const line = `${peerId} couldn't connect: ${error}`;
  const linkTurn = board.turnServers.some((server) => server.urls.some((url) => TURN_ADDRESS.test(url)));
  return linkTurn
    ? `${line} (the passwords of the TURN servers the link carries may have expired: ask the person who shared the link for a fresh link)`
    : line;
}
