import { describe, expect, it } from 'vitest';
import {
  boardTurnServers,
  joinErrorText,
  linkErrorText,
  linkOnlyServers,
  loadSettings,
  defaultSettings,
  parseSettings,
  relayUrlError,
  roomOptions,
  sameTurnServer,
  saveSettings,
  SETTINGS_KEY,
  settingsFromForm,
  turnPartOf,
  turnUrlError,
  type ConnectionSettings,
  type SettingsStorage,
  type TurnServer,
} from './connection';
import { APP_ID } from './room';

class MemoryStorage implements SettingsStorage {
  readonly items = new Map<string, string>();
  getItem(key: string): string | null {
    return this.items.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.items.set(key, value);
  }
  removeItem(key: string): void {
    this.items.delete(key);
  }
}

const secrets = { room: 'room-1', key: 'password-1' };

const saved: ConnectionSettings = {
  turnServers: [
    { urls: ['turn:turn.example.com:3478', 'turns:turn.example.com:5349'], username: 'alice', credential: 'secret' },
    { urls: ['turn:open.example.com:80'] },
  ],
  relays: ['wss://relay.one.example', 'wss://relay.two.example'],
};

describe('the connection settings', () => {
  it("leave TURN and the relays unset by default, so the room joins with Trystero's own", () => {
    const settings = loadSettings(new MemoryStorage());
    expect(settings).toStrictEqual({ turnServers: [], relays: [] });
    expect(loadSettings(null)).toStrictEqual(defaultSettings());
    expect(roomOptions(secrets, settings)).toStrictEqual({ appId: APP_ID, password: 'password-1' });
  });

  it('pass each TURN server and relay to the room', () => {
    expect(roomOptions(secrets, saved)).toStrictEqual({
      appId: APP_ID,
      password: 'password-1',
      turnConfig: [
        { urls: ['turn:turn.example.com:3478', 'turns:turn.example.com:5349'], username: 'alice', credential: 'secret' },
        { urls: ['turn:open.example.com:80'] },
      ],
      relayConfig: { urls: ['wss://relay.one.example', 'wss://relay.two.example'] },
    });
    expect(roomOptions(secrets, { ...saved, relays: [] })).not.toHaveProperty('relayConfig');
    expect(roomOptions(secrets, { ...saved, turnServers: [] })).not.toHaveProperty('turnConfig');
  });

  it('keep what a person saves, and read it back', () => {
    const storage = new MemoryStorage();
    saveSettings(storage, saved);
    expect(JSON.parse(storage.getItem(SETTINGS_KEY) ?? 'null')).toStrictEqual(saved);
    expect(loadSettings(storage)).toStrictEqual(saved);
  });

  it('remove their key once a person clears every setting', () => {
    const storage = new MemoryStorage();
    saveSettings(storage, saved);
    saveSettings(storage, defaultSettings());
    expect(storage.items.has(SETTINGS_KEY)).toBe(false);
    expect(loadSettings(storage)).toStrictEqual(defaultSettings());
  });

  it("keep only the entries they can read", () => {
    expect(parseSettings('not json')).toStrictEqual(defaultSettings());
    expect(parseSettings('[]')).toStrictEqual(defaultSettings());
    expect(parseSettings('null')).toStrictEqual(defaultSettings());
    const text = JSON.stringify({
      turnServers: [
        { urls: ['stun:stun.example.com'] },
        { urls: 'turn:a-string.example.com' },
        'turn:not-an-object.example.com',
        { urls: ['turn:kept.example.com:3478', 'https://dropped.example.com'], username: 7, credential: 'secret' },
      ],
      relays: ['https://relay.example.com', 'wss://kept.example.com', 3],
    });
    expect(parseSettings(text)).toStrictEqual({
      turnServers: [{ urls: ['turn:kept.example.com:3478'], credential: 'secret' }],
      relays: ['wss://kept.example.com'],
    });
  });

  it("fall back to the defaults where the browser's storage throws", () => {
    const refusing: SettingsStorage = {
      getItem: () => {
        throw new Error('the page may not use storage');
      },
      setItem: () => {},
      removeItem: () => {},
    };
    expect(loadSettings(refusing)).toStrictEqual(defaultSettings());
  });

  it('accept turn: and turns: addresses for TURN servers, and wss:// addresses for relays', () => {
    expect(turnUrlError('turn:turn.example.com:3478')).toBeNull();
    expect(turnUrlError('turns:turn.example.com:5349?transport=tcp')).toBeNull();
    expect(turnUrlError('TURN:upper.example.com')).toBeNull();
    for (const url of ['stun:stun.example.com', 'turn:', 'https://turn.example.com', 'turn.example.com']) {
      expect(turnUrlError(url)).toContain(url);
    }
    expect(relayUrlError('wss://relay.example.com')).toBeNull();
    expect(relayUrlError('wss://relay.example.com:4443/nostr')).toBeNull();
    for (const url of ['ws://relay.example.com', 'https://relay.example.com', 'relay.example.com', 'wss://']) {
      expect(relayUrlError(url)).toContain(url);
    }
  });

  it('read what a person typed in the panel', () => {
    const result = settingsFromForm(
      [
        { urls: ' turn:turn.example.com:3478, turns:turn.example.com:5349 ', username: ' alice ', credential: 'secret' },
        { urls: '', username: '', credential: '' },
        { urls: 'turn:open.example.com:80', username: '', credential: '' },
      ],
      'wss://relay.one.example\n\n  wss://relay.two.example \nwss://relay.one.example',
    );
    expect(result).toStrictEqual({ settings: saved });
  });

  it('list each reason that what a person typed is not kept', () => {
    const result = settingsFromForm(
      [
        { urls: 'stun:stun.example.com', username: '', credential: '' },
        { urls: '', username: 'bob', credential: '' },
        { urls: '', username: '', credential: 'secret' },
      ],
      'https://relay.example.com',
    );
    expect(result).toStrictEqual({
      errors: [
        `TURN server 1: ${turnUrlError('stun:stun.example.com')}`,
        'TURN server 2 has a username or a password but no address.',
        'TURN server 3 has a username or a password but no address.',
        `Relay: ${relayUrlError('https://relay.example.com')}`,
      ],
    });
  });

  it('point a person who meets a failed connection to the TURN settings', () => {
    expect(joinErrorText(defaultSettings())).toContain('add a TURN server in Connection settings');
    expect(joinErrorText(saved)).toContain('Check their addresses, usernames and passwords in Connection settings');
  });
});

/** The servers a board's link carries: Cloudflare's STUN server, and a TURN server of three addresses. */
const link: TurnServer[] = [
  { urls: ['stun:stun.cloudflare.com:3478'] },
  {
    urls: ['turn:turn.cloudflare.com:3478?transport=udp', 'turns:turn.cloudflare.com:5349?transport=tcp'],
    username: 'link-user',
    credential: 'link-pass',
  },
];

describe("the TURN servers of a board's link", () => {
  it("go into the ICE servers the page joins the board with, after the browser's own", () => {
    const linkServers = linkOnlyServers(saved, link);
    expect(linkServers).toStrictEqual(link);
    const options = roomOptions(secrets, saved, linkServers);
    expect(options.turnConfig).toStrictEqual([...saved.turnServers, ...link]);
    expect(options.turnConfig?.[3]).not.toBe(link[1]);
    expect(roomOptions(secrets, defaultSettings(), link)).toStrictEqual({
      appId: APP_ID,
      password: 'password-1',
      turnConfig: link,
    });
  });

  it("stay out of the browser's settings, so that another board joins without them", () => {
    const storage = new MemoryStorage();
    saveSettings(storage, saved);
    const kept = storage.getItem(SETTINGS_KEY);
    const settings = loadSettings(storage);
    expect(roomOptions(secrets, settings, linkOnlyServers(settings, link)).turnConfig).toHaveLength(4);
    expect(storage.getItem(SETTINGS_KEY)).toBe(kept);
    expect(loadSettings(storage)).toStrictEqual(saved);
    // The link of another board carries none, so the page joins it with the browser's own servers alone.
    const other = { room: 'room-2', key: 'password-2' };
    expect(roomOptions(other, loadSettings(storage), linkOnlyServers(settings, [])).turnConfig).toStrictEqual(saved.turnServers);
    expect(roomOptions(other, loadSettings(new MemoryStorage()))).not.toHaveProperty('turnConfig');
  });

  it('leave out each server whose TURN part the browser keeps already', () => {
    const part = turnPartOf(link[1]);
    expect(part).toStrictEqual({
      urls: ['turn:turn.cloudflare.com:3478?transport=udp', 'turns:turn.cloudflare.com:5349?transport=tcp'],
      username: 'link-user',
      credential: 'link-pass',
    });
    const settings = { turnServers: part === null ? [] : [part], relays: [] };
    expect(linkOnlyServers(settings, link)).toStrictEqual([link[0]]);
    expect(boardTurnServers(settings, linkOnlyServers(settings, link))).toStrictEqual([...settings.turnServers, link[0]]);
  });

  it("keep a server's turn: and turns: addresses alone, with its username and password", () => {
    expect(turnPartOf(link[0])).toBeNull();
    expect(
      turnPartOf({ urls: ['stun:stun.example.com', 'turn:turn.example.com:3478'], username: 'alice', credential: 'secret' }),
    ).toStrictEqual({ urls: ['turn:turn.example.com:3478'], username: 'alice', credential: 'secret' });
    expect(turnPartOf({ urls: ['turn:open.example.com:80'] })).toStrictEqual({ urls: ['turn:open.example.com:80'] });
  });

  it('tell one server from another by its addresses, in order, its username and its password', () => {
    const server = { urls: ['turn:a.example.com', 'turn:b.example.com'], username: 'alice', credential: 'secret' };
    expect(sameTurnServer(server, { ...server, urls: ['turn:a.example.com', 'turn:b.example.com'] })).toBe(true);
    expect(sameTurnServer(server, { ...server, urls: ['turn:b.example.com', 'turn:a.example.com'] })).toBe(false);
    expect(sameTurnServer(server, { ...server, urls: ['turn:a.example.com'] })).toBe(false);
    expect(sameTurnServer(server, { ...server, username: 'bob' })).toBe(false);
    expect(sameTurnServer(server, { ...server, credential: 'other' })).toBe(false);
  });

  it('list the servers a page shares: the browser\'s own, then the link\'s', () => {
    expect(boardTurnServers(saved, link)).toStrictEqual([...saved.turnServers, ...link]);
    expect(boardTurnServers(defaultSettings(), [])).toStrictEqual([]);
  });

  it('point a person whose link carries TURN servers to the person who shared it, and say why a link is refused', () => {
    expect(joinErrorText(defaultSettings(), true)).toContain('may have expired: ask the person who shared the link for a fresh link');
    expect(joinErrorText(saved, true)).toBe(joinErrorText(defaultSettings(), true));
    expect(linkErrorText("The link's turn parameter isn't base64url text.")).toBe(
      "The link's turn parameter isn't base64url text. The page joins the board without the link's TURN servers: ask the person who shared the link to copy it again.",
    );
  });
});
