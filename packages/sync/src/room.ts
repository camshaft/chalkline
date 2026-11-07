/** The Trystero app id that every Chalkline page and script joins rooms under. */
export const APP_ID = 'chalkline';

/** A room's name and password, which travel in the link's fragment. */
export interface RoomSecrets {
  room: string;
  key: string;
}

/**
 * A server that WebRTC connects through: a TURN server, which forwards the
 * encrypted traffic between two browsers that can't connect directly, with
 * the username and the password it asks for, or a STUN server, which tells a
 * browser the public address it reaches the internet from. Each of its `urls`
 * starts with turn:, turns:, stun: or stuns:.
 */
export interface TurnServer {
  urls: string[];
  username?: string;
  credential?: string;
}

/** The parameter of a board link's fragment that holds the TURN servers the link carries. */
export const TURN_PARAM = 'turn';

/** What the `turn` parameter of a link's fragment holds: its servers, or why they can't be read. */
export type LinkTurnServers = { turnServers: TurnServer[] } | { error: string };

function paramsOf(hash: string): URLSearchParams {
  return new URLSearchParams(hash.startsWith('#') ? hash.slice(1) : hash);
}

/**
 * Reads `#room=<name>&key=<password>` from a link's fragment, or returns null
 * where either part is missing. A browser doesn't send the fragment to the
 * static host, so the host never sees either part.
 */
export function parseRoomFragment(hash: string): RoomSecrets | null {
  const params = paramsOf(hash);
  const room = params.get('room');
  const key = params.get('key');
  return room && key ? { room, key } : null;
}

/**
 * The fragment that `parseRoomFragment` reads back, with the `turn` parameter
 * that `linkTurnServers` reads `turnServers` back from, where it lists any.
 */
export function roomFragment(secrets: RoomSecrets, turnServers: readonly TurnServer[] = []): string {
  const params = new URLSearchParams({ room: secrets.room, key: secrets.key });
  if (turnServers.length > 0) params.set(TURN_PARAM, encodeTurnServers(turnServers));
  return `#${params.toString()}`;
}

/**
 * The text of the `turn` parameter for `servers`: their list in JSON, as
 * `[{"urls", "username", "credential"}]`, in UTF-8, written in base64url
 * without padding, whose characters a link holds without escaping.
 */
export function encodeTurnServers(servers: readonly TurnServer[]): string {
  const json = JSON.stringify(servers.map(({ urls, username, credential }) => ({ urls, username, credential })));
  let binary = '';
  for (const byte of new TextEncoder().encode(json)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** The bytes that `text` holds in base64url or base64, with or without padding, or null where it isn't either. */
function base64Bytes(text: string): Uint8Array | null {
  // URLSearchParams reads a + as a space, so the + of base64 that a link doesn't escape comes back as a space.
  const base64 = text.replace(/ /g, '+').replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '');
  if (!/^[A-Za-z0-9+/]+$/.test(base64) || base64.length % 4 === 1) return null;
  try {
    const binary = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, '='));
    return Uint8Array.from(binary, (char) => char.charCodeAt(0));
  } catch {
    return null;
  }
}

const SERVER_ADDRESS = /^(stuns?|turns?):\S+$/i;
const TURN_ADDRESS = /^turns?:/i;

/** The server that entry `number` of the link's list holds, or why it doesn't hold one. */
function serverFrom(value: unknown, number: number): TurnServer | string {
  const where = `Server ${number} of the link's turn parameter`;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return `${where} isn't an object, as {"urls", "username", "credential"} is.`;
  }
  const entry = value as Record<string, unknown>;
  const urls: unknown = typeof entry.urls === 'string' ? [entry.urls] : entry.urls;
  if (!Array.isArray(urls) || urls.length === 0) return `${where} has no address in urls.`;
  const server: TurnServer = { urls: [] };
  for (const url of urls) {
    if (typeof url !== 'string') return `${where} has an address in urls that isn't text.`;
    if (!SERVER_ADDRESS.test(url)) return `${where}: "${url}" doesn't start with turn:, turns:, stun: or stuns:.`;
    server.urls.push(url);
  }
  for (const field of ['username', 'credential'] as const) {
    const text = entry[field];
    if (text === undefined || text === null || text === '') continue;
    if (typeof text !== 'string') return `${where} has a ${field} that isn't text.`;
    server[field] = text;
  }
  // A browser refuses a TURN server without both, and then joins the room with none of the servers.
  if (server.urls.some((url) => TURN_ADDRESS.test(url)) && (server.username === undefined || server.credential === undefined)) {
    return `${where} has a turn: or turns: address but lacks its username or its credential.`;
  }
  return server;
}

/**
 * Reads the TURN servers that the `turn` parameter of a link's fragment holds,
 * as `roomFragment` writes them: a list in JSON, in base64url, of
 * `{"urls", "username", "credential"}`, each `urls` one address or a list of
 * them, as the `iceServers` that Cloudflare's TURN service answers are. A
 * fragment without the parameter, or with it empty, holds none. A value it
 * can't read answers why, so that a page or a script says so and connects
 * without the link's servers.
 */
export function linkTurnServers(hash: string): LinkTurnServers {
  const text = paramsOf(hash).get(TURN_PARAM)?.trim() ?? '';
  if (text === '') return { turnServers: [] };
  const bytes = base64Bytes(text);
  if (bytes === null) return { error: "The link's turn parameter isn't base64url text." };
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return { error: "The link's turn parameter doesn't hold JSON text in base64url." };
  }
  if (!Array.isArray(value)) {
    return { error: `The link's turn parameter doesn't hold a list of servers, as [{"urls", "username", "credential"}] is.` };
  }
  const turnServers: TurnServer[] = [];
  for (const [index, entry] of value.entries()) {
    const server = serverFrom(entry, index + 1);
    if (typeof server === 'string') return { error: server };
    turnServers.push(server);
  }
  return { turnServers };
}

/** A new room: a random name of 16 hex digits and a random password of 32. */
export function newRoomSecrets(): RoomSecrets {
  return { room: randomHex(8), key: randomHex(16) };
}

function randomHex(bytes: number): string {
  const data = crypto.getRandomValues(new Uint8Array(bytes));
  return Array.from(data, (byte) => byte.toString(16).padStart(2, '0')).join('');
}
