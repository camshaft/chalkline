import type { Room } from '@trystero-p2p/nostr';
import { describe, expect, it, vi } from 'vitest';
import type { Channel } from './sync';
import { ACTIONS, toBytes, trysteroTransport } from './trystero';

interface FakeAction {
  send: ReturnType<typeof vi.fn>;
  onMessage: ((data: unknown, context: { peerId: string }) => void) | null;
}

function fakeRoom() {
  const actions = new Map<string, FakeAction>();
  const room = {
    onPeerJoin: null as ((peerId: string) => void) | null,
    onPeerLeave: null as ((peerId: string) => void) | null,
    makeAction: (namespace: string) => {
      const action: FakeAction = { send: vi.fn(async () => {}), onMessage: null };
      actions.set(namespace, action);
      return action;
    },
    getPeers: () => ({ p1: {}, p2: {} }),
  };
  const transport = trysteroTransport(room as unknown as Room);
  return { room, actions, transport };
}

describe('trysteroTransport', () => {
  it('sends each channel on its own action, to the peer given or to every peer', async () => {
    const { actions, transport } = fakeRoom();
    const bytes = new Uint8Array([1, 2, 3]);

    await transport.send('state', bytes, 'p1');
    await transport.send('update', bytes);
    await transport.send('awareness', bytes, 'p2');
    await transport.send('peers', bytes, 'p1');
    await transport.send('resync', bytes, 'p2');

    expect(actions.get('y-state')?.send).toHaveBeenCalledWith(bytes, { target: 'p1' });
    expect(actions.get('y-update')?.send).toHaveBeenCalledWith(bytes, undefined);
    expect(actions.get('y-awareness')?.send).toHaveBeenCalledWith(bytes, { target: 'p2' });
    expect(actions.get('y-peers')?.send).toHaveBeenCalledWith(bytes, { target: 'p1' });
    expect(actions.get('y-resync')?.send).toHaveBeenCalledWith(bytes, { target: 'p2' });
    expect(actions.get('y-diff')?.send).not.toHaveBeenCalled();
  });

  it('names each action in at most the 12 bytes Trystero takes', () => {
    for (const name of Object.values(ACTIONS)) expect(new TextEncoder().encode(name).length).toBeLessThanOrEqual(12);
  });

  it('passes each binary message on with its channel and sender, and drops any other', () => {
    const { actions, transport } = fakeRoom();
    const got: Array<[Channel, number[], string]> = [];
    transport.onMessage((channel, data, from) => got.push([channel, [...data], from]));

    actions.get('y-diff')?.onMessage?.(new Uint8Array([4, 5]).buffer, { peerId: 'p2' });
    actions.get('y-awareness')?.onMessage?.(new Uint8Array([6]), { peerId: 'p1' });
    actions.get('y-update')?.onMessage?.('not binary', { peerId: 'p2' });

    expect(got).toEqual([
      ['diff', [4, 5], 'p2'],
      ['awareness', [6], 'p1'],
    ]);
  });

  it('passes joins and leaves to every handler, until a leave handler stops', () => {
    const { room, transport } = fakeRoom();
    const events: string[] = [];
    transport.onPeerJoin((peerId) => events.push(`first saw ${peerId} join`));
    transport.onPeerJoin((peerId) => events.push(`second saw ${peerId} join`));
    const stop = transport.onPeerLeave((peerId) => events.push(`saw ${peerId} leave`));

    room.onPeerJoin?.('p1');
    room.onPeerLeave?.('p1');
    stop();
    room.onPeerLeave?.('p2');

    expect(events).toEqual(['first saw p1 join', 'second saw p1 join', 'saw p1 leave']);
  });

  it("lists the room's peers", () => {
    expect(fakeRoom().transport.peers()).toEqual(['p1', 'p2']);
  });
});

describe('toBytes', () => {
  it('keeps only the bytes a view covers', () => {
    const buffer = new Uint8Array([9, 1, 2, 9]).buffer;
    expect([...(toBytes(new DataView(buffer, 1, 2)) ?? [])]).toEqual([1, 2]);
  });
});
