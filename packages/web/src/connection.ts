import type { JoinRoomConfig, TurnServerConfig } from '@trystero-p2p/nostr';
import { APP_ID, type RoomSecrets, type TurnServer } from './room';

/** A TURN server, or a STUN server that a board's link carries, as `@chalkline/sync` reads them. */
export type { TurnServer } from './room';

/**
 * The connection settings a person keeps in their browser, for every board it
 * opens. Both are unset by default, and a setting left unset leaves the
 * defaults in use: Trystero's STUN servers, and the public Nostr relays that
 * `joinBoardRoom` in `@chalkline/sync/join` holds: Trystero's default relays,
 * without each one that fails or refuses the board.
 */
export interface ConnectionSettings {
  /**
   * TURN servers, which forward the encrypted traffic between two browsers
   * that can't connect directly. WebRTC uses them beside Trystero's STUN servers.
   */
  turnServers: TurnServer[];
  /**
   * The person's own Nostr relays, which carry the first connection details
   * in place of the public relays. Empty for the public relays.
   */
  relays: string[];
}

/** The `localStorage` key that holds the settings. */
export const SETTINGS_KEY = 'chalkline.connection';

/** The part of `Storage` that the settings read and write. */
export type SettingsStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/** The settings of a browser that hasn't saved any: each setting unset, so that the defaults apply. */
export function defaultSettings(): ConnectionSettings {
  return { turnServers: [], relays: [] };
}

/** Why `url` isn't a TURN server's address, or null where it is one. */
export function turnUrlError(url: string): string | null {
  return /^turns?:\S+$/i.test(url) ? null : `"${url}" doesn't start with turn: or turns:, as turn:turn.example.com:3478 does.`;
}

/** Why `url` isn't a Nostr relay's address, or null where it is one. */
export function relayUrlError(url: string): string | null {
  const error = `"${url}" isn't a secure WebSocket address, such as wss://relay.example.com.`;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'wss:' && parsed.hostname !== '' ? null : error;
  } catch {
    return error;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function turnServerFrom(value: unknown): TurnServer[] {
  if (!isRecord(value) || !Array.isArray(value.urls)) return [];
  const urls = value.urls.filter((url): url is string => typeof url === 'string' && turnUrlError(url) === null);
  if (urls.length === 0) return [];
  const server: TurnServer = { urls };
  if (typeof value.username === 'string' && value.username !== '') server.username = value.username;
  if (typeof value.credential === 'string' && value.credential !== '') server.credential = value.credential;
  return [server];
}

/**
 * Reads the settings that `saveSettings` wrote. Where the text isn't
 * settings, or an entry isn't a TURN server or a relay, the defaults stand
 * in for what it can't read.
 */
export function parseSettings(text: string | null): ConnectionSettings {
  if (text === null) return defaultSettings();
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return defaultSettings();
  }
  if (!isRecord(value)) return defaultSettings();
  return {
    turnServers: Array.isArray(value.turnServers) ? value.turnServers.flatMap(turnServerFrom) : [],
    relays: Array.isArray(value.relays)
      ? value.relays.filter((url): url is string => typeof url === 'string' && relayUrlError(url) === null)
      : [],
  };
}

/** The settings `storage` keeps, or the defaults where it is null, holds none, or throws as it is read. */
export function loadSettings(storage: SettingsStorage | null): ConnectionSettings {
  if (storage === null) return defaultSettings();
  try {
    return parseSettings(storage.getItem(SETTINGS_KEY));
  } catch {
    return defaultSettings();
  }
}

/** Keeps `settings` in `storage`, and removes the key once every setting is unset. Throws where the browser refuses. */
export function saveSettings(storage: SettingsStorage, settings: ConnectionSettings): void {
  if (settings.turnServers.length === 0 && settings.relays.length === 0) {
    storage.removeItem(SETTINGS_KEY);
    return;
  }
  storage.setItem(SETTINGS_KEY, JSON.stringify({ turnServers: settings.turnServers, relays: settings.relays }));
}

/**
 * The config a page joins the room with: the room's password, each connection
 * setting that is set, and `linkServers`, the servers of the board's link that
 * the settings don't hold, which the page uses beside the settings' TURN
 * servers for that board alone.
 */
export function roomOptions(
  secrets: RoomSecrets,
  settings: ConnectionSettings,
  linkServers: readonly TurnServer[] = [],
): JoinRoomConfig {
  const config: JoinRoomConfig = { appId: APP_ID, password: secrets.key };
  const turnServers = [...settings.turnServers, ...linkServers];
  if (turnServers.length > 0) {
    config.turnConfig = turnServers.map((server): TurnServerConfig => ({ ...server, urls: [...server.urls] }));
  }
  if (settings.relays.length > 0) config.relayConfig = { urls: [...settings.relays] };
  return config;
}

/** One TURN server's row of the settings panel, as a person typed it. */
export interface TurnRow {
  /** One address or more, separated by spaces or commas. */
  urls: string;
  username: string;
  credential: string;
}

function splitList(text: string): string[] {
  return text.split(/[\s,]+/).filter((part) => part !== '');
}

/**
 * The settings a person typed in the panel, or each reason they can't be
 * kept. A row left blank is skipped, and a relay listed twice is kept once.
 */
export function settingsFromForm(
  rows: TurnRow[],
  relaysText: string,
): { settings: ConnectionSettings } | { errors: string[] } {
  const errors: string[] = [];
  const turnServers: TurnServer[] = [];
  rows.forEach((row, index) => {
    const urls = splitList(row.urls);
    const username = row.username.trim();
    if (urls.length === 0) {
      if (username !== '' || row.credential !== '') {
        errors.push(`TURN server ${index + 1} has a username or a password but no address.`);
      }
      return;
    }
    for (const url of urls) {
      const error = turnUrlError(url);
      if (error !== null) errors.push(`TURN server ${index + 1}: ${error}`);
    }
    const server: TurnServer = { urls };
    if (username !== '') server.username = username;
    if (row.credential !== '') server.credential = row.credential;
    turnServers.push(server);
  });
  const relays = [...new Set(splitList(relaysText))];
  for (const url of relays) {
    const error = relayUrlError(url);
    if (error !== null) errors.push(`Relay: ${error}`);
  }
  return errors.length > 0 ? { errors } : { settings: { turnServers, relays } };
}

/**
 * The status line for a peer that couldn't connect, which says what the
 * person can do about it. Trystero's error is text, so the line depends on
 * the settings and on `fromLink` alone, whether the page uses TURN servers
 * that its board's link carries, and the page logs the error itself to the
 * console.
 */
export function joinErrorText(settings: ConnectionSettings, fromLink = false): string {
  if (fromLink) {
    return "A peer couldn't connect through the TURN servers in use. The passwords of the servers this board's link carries may have expired: ask the person who shared the link for a fresh link.";
  }
  return settings.turnServers.length === 0
    ? "A peer couldn't connect. Where this keeps happening with the same people, a network between you may block direct connections: add a TURN server in Connection settings."
    : "A peer couldn't connect with this browser's TURN servers in use. Check their addresses, usernames and passwords in Connection settings.";
}

/** The servers of a board's link that a page uses, and why it can't read the link's `turn` parameter, where it can't. */
export interface FromLink {
  /** The link's servers that the browser's settings don't hold already. */
  servers: TurnServer[];
  /** Why the page doesn't use the link's servers, or null where it reads them. */
  error: string | null;
}

/** Whether `a` and `b` are one server: the same addresses, in order, with the same username and password. */
export function sameTurnServer(a: TurnServer, b: TurnServer): boolean {
  return (
    a.username === b.username &&
    a.credential === b.credential &&
    a.urls.length === b.urls.length &&
    a.urls.every((url, index) => url === b.urls[index])
  );
}

/**
 * The part of `server` that the settings keep: its turn: and turns:
 * addresses, with its username and password, or null where it has none, as a
 * STUN server, which a browser uses without a setting, has none.
 */
export function turnPartOf(server: TurnServer): TurnServer | null {
  const urls = server.urls.filter((url) => turnUrlError(url) === null);
  if (urls.length === 0) return null;
  const part: TurnServer = { urls };
  if (server.username !== undefined) part.username = server.username;
  if (server.credential !== undefined) part.credential = server.credential;
  return part;
}

/** The servers of a board's link, `link`, that `settings` doesn't hold: each one whose TURN part the settings don't keep already. */
export function linkOnlyServers(settings: ConnectionSettings, link: readonly TurnServer[]): TurnServer[] {
  return link.filter((server) => {
    const part = turnPartOf(server);
    return part === null || !settings.turnServers.some((kept) => sameTurnServer(kept, part));
  });
}

/** The TURN servers a page uses for its board: the browser's own, then `linkServers`, the link's that the browser doesn't hold. */
export function boardTurnServers(settings: ConnectionSettings, linkServers: readonly TurnServer[]): TurnServer[] {
  return [...settings.turnServers, ...linkServers];
}

/** What the page says where it can't read the TURN servers of its link: `error`, and what it does then. */
export function linkErrorText(error: string): string {
  return `${error} The page joins the board without the link's TURN servers: ask the person who shared the link to copy it again.`;
}
