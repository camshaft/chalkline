import { joinRoom as joinNostrRoom } from '@trystero-p2p/nostr';
import { joinRoom as joinRelayRoom } from '@trystero-p2p/ws-relay';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { joinBoardRoom, PUBLIC_RELAYS } from './join';

vi.mock('@trystero-p2p/nostr', () => ({ joinRoom: vi.fn(() => 'the Nostr room') }));
vi.mock('@trystero-p2p/ws-relay', () => ({ joinRoom: vi.fn(() => 'the relay room') }));

describe('joinBoardRoom', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("joins through the config's own Nostr relays where no WebSocket relay is listed", () => {
    const config = { appId: 'chalkline', password: 'key', relayConfig: { urls: ['wss://nostr.example'] } };
    const callbacks = { onJoinError: vi.fn() };

    expect(joinBoardRoom(config, 'room', [], callbacks)).toBe('the Nostr room');

    expect(joinNostrRoom).toHaveBeenCalledWith(config, 'room', callbacks);
    expect(joinRelayRoom).not.toHaveBeenCalled();
  });

  it("joins through the public relays where the config doesn't list a Nostr relay", () => {
    const callbacks = { onJoinError: vi.fn() };

    expect(joinBoardRoom({ appId: 'chalkline', password: 'key' }, 'room', [], callbacks)).toBe('the Nostr room');

    expect(joinNostrRoom).toHaveBeenCalledWith(
      { appId: 'chalkline', password: 'key', relayConfig: { urls: [...PUBLIC_RELAYS] } },
      'room',
      callbacks,
    );
    expect(joinRelayRoom).not.toHaveBeenCalled();
  });

  it("keeps the rest of the config's relay settings where its list of Nostr relays is empty", () => {
    const config = { appId: 'chalkline', password: 'key', relayConfig: { urls: [], manualReconnection: true } };

    joinBoardRoom(config, 'room', []);

    expect(joinNostrRoom).toHaveBeenCalledWith(
      { appId: 'chalkline', password: 'key', relayConfig: { urls: [...PUBLIC_RELAYS], manualReconnection: true } },
      'room',
      undefined,
    );
  });

  it('names five of the relays Trystero lists as its defaults, each once', async () => {
    const { defaultRelayUrls } = await vi.importActual<typeof import('@trystero-p2p/nostr')>('@trystero-p2p/nostr');

    expect(PUBLIC_RELAYS).toHaveLength(5);
    expect(new Set(PUBLIC_RELAYS).size).toBe(PUBLIC_RELAYS.length);
    for (const url of PUBLIC_RELAYS) expect(defaultRelayUrls).toContain(url);
  });

  it('joins through the listed WebSocket relays alone, with the rest of the configuration', () => {
    const turnConfig = [{ urls: 'turn:turn.example' }];
    const config = {
      appId: 'chalkline',
      password: 'key',
      relayConfig: { urls: ['wss://nostr.example'], manualReconnection: true },
      turnConfig,
    };

    expect(joinBoardRoom(config, 'room', ['ws://10.0.0.2:8080/relay'])).toBe('the relay room');

    expect(joinRelayRoom).toHaveBeenCalledWith(
      {
        appId: 'chalkline',
        password: 'key',
        relayConfig: { urls: ['ws://10.0.0.2:8080/relay'], manualReconnection: true },
        turnConfig,
      },
      'room',
      undefined,
    );
    expect(joinNostrRoom).not.toHaveBeenCalled();
  });
});
