import { joinRoom as joinNostrRoom } from '@trystero-p2p/nostr';
import { joinRoom as joinRelayRoom } from '@trystero-p2p/ws-relay';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { joinBoardRoom } from './join';
import { joinPublicRelayRoom } from './public-relays';

vi.mock('@trystero-p2p/nostr', () => ({ joinRoom: vi.fn(() => 'the Nostr room') }));
vi.mock('@trystero-p2p/ws-relay', () => ({ joinRoom: vi.fn(() => 'the relay room') }));
vi.mock('./public-relays', () => ({ joinPublicRelayRoom: vi.fn(() => 'the public relays room') }));

describe('joinBoardRoom', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("joins through the config's own Nostr relays where no WebSocket relay is listed", () => {
    const config = { appId: 'chalkline', password: 'key', relayConfig: { urls: ['wss://nostr.example'] } };
    const callbacks = { onJoinError: vi.fn() };

    expect(joinBoardRoom(config, 'room', [], callbacks)).toBe('the Nostr room');

    expect(joinNostrRoom).toHaveBeenCalledWith(config, 'room', callbacks);
    expect(joinPublicRelayRoom).not.toHaveBeenCalled();
    expect(joinRelayRoom).not.toHaveBeenCalled();
  });

  it("joins through the public relays where the config doesn't list a Nostr relay", () => {
    const config = { appId: 'chalkline', password: 'key' };
    const callbacks = { onJoinError: vi.fn() };

    expect(joinBoardRoom(config, 'room', [], callbacks)).toBe('the public relays room');

    expect(joinPublicRelayRoom).toHaveBeenCalledWith(config, 'room', callbacks);
    expect(joinNostrRoom).not.toHaveBeenCalled();
    expect(joinRelayRoom).not.toHaveBeenCalled();
  });

  it('joins through the public relays, with the rest of the config, where its list of Nostr relays is empty', () => {
    const config = { appId: 'chalkline', password: 'key', relayConfig: { urls: [], manualReconnection: true } };

    expect(joinBoardRoom(config, 'room', [])).toBe('the public relays room');

    expect(joinPublicRelayRoom).toHaveBeenCalledWith(config, 'room', undefined);
    expect(joinNostrRoom).not.toHaveBeenCalled();
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
    expect(joinPublicRelayRoom).not.toHaveBeenCalled();
  });
});
