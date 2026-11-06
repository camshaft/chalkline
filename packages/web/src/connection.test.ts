import { describe, expect, it } from 'vitest';
import {
  joinErrorText,
  loadSettings,
  defaultSettings,
  parseSettings,
  relayUrlError,
  roomOptions,
  saveSettings,
  SETTINGS_KEY,
  settingsFromForm,
  turnUrlError,
  type ConnectionSettings,
  type SettingsStorage,
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
