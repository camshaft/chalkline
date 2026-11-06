import { joinRoom as joinNostrRoom } from '@trystero-p2p/nostr';
import { joinRoom as joinRelayRoom } from '@trystero-p2p/ws-relay';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { joinBoardRoom } from './join';

vi.mock('@trystero-p2p/nostr', () => ({ joinRoom: vi.fn(() => 'the Nostr room') }));
vi.mock('@trystero-p2p/ws-relay', () => ({ joinRoom: vi.fn(() => 'the relay room') }));

describe('joinBoardRoom', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('joins through the public Nostr relays where no relay is listed', () => {
    const config = { appId: 'chalkline', password: 'key', relayConfig: { urls: ['wss://nostr.example'] } };
    const callbacks = { onJoinError: vi.fn() };

    expect(joinBoardRoom(config, 'room', [], callbacks)).toBe('the Nostr room');

    expect(joinNostrRoom).toHaveBeenCalledWith(config, 'room', callbacks);
    expect(joinRelayRoom).not.toHaveBeenCalled();
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
