import { afterEach, describe, expect, it } from 'vitest';
import { applyAwarenessUpdate, Awareness, encodeAwarenessUpdate } from 'y-protocols/awareness';
import * as Y from 'yjs';
import { connectAwareness } from './awareness';
import { MemoryNetwork } from './memory-transport';
import type { Transport } from './sync';

const made: Awareness[] = [];
afterEach(() => {
  for (const awareness of made.splice(0)) awareness.destroy();
});

function participant(network: MemoryNetwork, id: string) {
  const awareness = new Awareness(new Y.Doc());
  made.push(awareness);
  awareness.setLocalState({ name: id });
  const stop = connectAwareness(awareness, network.join(id));
  return { awareness, stop };
}

/** The names of the other participants whose states `awareness` holds. */
function others(awareness: Awareness): string[] {
  return [...awareness.getStates()]
    .filter(([client]) => client !== awareness.clientID)
    .map(([, state]) => String(state.name))
    .sort();
}

/** Each message sent since the `before`th, as `from->to channel`, sorted. */
function sentSince(network: MemoryNetwork, before: number): string[] {
  return network.sent
    .slice(before)
    .map(({ from, to, channel }) => `${from}->${to} ${channel}`)
    .sort();
}

/** An awareness message that removes `client`'s state, at a clock one past the clock `awareness` holds for it. */
function removal(awareness: Awareness, client: number): Uint8Array {
  const writer = new Awareness(new Y.Doc());
  made.push(writer);
  writer.meta.set(client, { clock: (awareness.meta.get(client)?.clock ?? 0) + 1, lastUpdated: 0 });
  return encodeAwarenessUpdate(writer, [client], new Map());
}

describe('connectAwareness', () => {
  it("shows each participant the others' states, a participant that joins later among them", () => {
    const network = new MemoryNetwork();
    const a = participant(network, 'a');
    const b = participant(network, 'b');
    network.flush();
    const c = participant(network, 'c');
    network.flush();

    expect(others(a.awareness)).toEqual(['b', 'c']);
    expect(others(b.awareness)).toEqual(['a', 'c']);
    expect(others(c.awareness)).toEqual(['a', 'b']);
  });

  it("sends each change of its own state to every peer, and doesn't send a peer's on to a peer that the sender reaches", () => {
    const network = new MemoryNetwork();
    const [a, b, c] = ['a', 'b', 'c'].map((id) => participant(network, id));
    network.flush();
    const before = network.sent.length;

    a.awareness.setLocalStateField('cursor', { x: 1, y: 2 });
    network.flush();

    for (const peer of [b, c]) {
      expect(peer.awareness.getStates().get(a.awareness.clientID)).toEqual({ name: 'a', cursor: { x: 1, y: 2 } });
    }
    expect(sentSince(network, before)).toEqual(['a->b awareness', 'a->c awareness']);
  });

  it("carries a peer's state on to a peer that the sender doesn't connect to", () => {
    const network = new MemoryNetwork();
    network.keepApart('a', 'c');
    const [a, , c] = ['a', 'b', 'c'].map((id) => participant(network, id));
    network.flush();

    expect(others(c.awareness)).toEqual(['a', 'b']);
    expect(others(a.awareness)).toEqual(['b', 'c']);
    const before = network.sent.length;
    a.awareness.setLocalStateField('cursor', { x: 1, y: 2 });
    network.flush();

    expect(c.awareness.getStates().get(a.awareness.clientID)).toEqual({ name: 'a', cursor: { x: 1, y: 2 } });
    expect(sentSince(network, before)).toEqual(['a->b awareness', 'b->c awareness']);
  });

  it("removes a peer's states as it leaves", () => {
    const network = new MemoryNetwork();
    const [, b, c] = ['a', 'b', 'c'].map((id) => participant(network, id));
    network.flush();

    network.leave('a');
    network.flush();

    expect(others(b.awareness)).toEqual(['c']);
    expect(others(c.awareness)).toEqual(['b']);
  });

  it('removes the states of a peer that leaves at the far end of a line', () => {
    const network = new MemoryNetwork();
    network.keepApart('a', 'c');
    const [, b, c] = ['a', 'b', 'c'].map((id) => participant(network, id));
    network.flush();

    network.leave('a');
    network.flush();

    expect(others(b.awareness)).toEqual(['c']);
    expect(others(c.awareness)).toEqual(['b']);
  });

  it('shows a peer again when its link comes back, though its state stayed the same', () => {
    const network = new MemoryNetwork();
    const a = participant(network, 'a');
    const b = participant(network, 'b');
    network.flush();
    const changes: string[] = [];
    b.awareness.on('change', ({ added, removed }: { added: number[]; removed: number[] }) => {
      if (removed.includes(a.awareness.clientID)) changes.push('a removed');
      if (added.includes(a.awareness.clientID)) changes.push('a added');
    });

    network.disconnect('a', 'b');
    network.flush();

    expect(changes).toEqual(['a removed', 'a added']);
    expect(others(b.awareness)).toEqual(['a']);
    expect(others(a.awareness)).toEqual(['b']);
  });

  it("keeps a participant's state that a peer removes while the participant's own peer is still connected", () => {
    const network = new MemoryNetwork();
    const a = participant(network, 'a');
    const b = participant(network, 'b');
    const x = network.join('x');
    network.flush();

    x.send('awareness', removal(b.awareness, a.awareness.clientID), 'b');
    network.flush();

    expect(others(b.awareness)).toEqual(['a']);
  });

  it('answers a removal of its own state with that state at a later clock, once', () => {
    const network = new MemoryNetwork();
    const a = participant(network, 'a');
    const x = network.join('x');
    const answers: Uint8Array[] = [];
    x.onMessage((channel, data) => {
      if (channel === 'awareness') answers.push(data);
    });
    network.flush();
    answers.splice(0);

    const removed = removal(a.awareness, a.awareness.clientID);
    x.send('awareness', removed, 'a');
    network.flush();

    expect(answers).toHaveLength(1);
    const reader = new Awareness(new Y.Doc());
    made.push(reader);
    applyAwarenessUpdate(reader, removed, 'test');
    applyAwarenessUpdate(reader, answers[0], 'test');
    expect(reader.getStates().get(a.awareness.clientID)).toEqual({ name: 'a' });
  });

  it('stops carrying awareness once stopped', () => {
    const network = new MemoryNetwork();
    const a = participant(network, 'a');
    const b = participant(network, 'b');
    network.flush();
    const before = network.sent.length;

    a.stop();
    a.awareness.setLocalStateField('cursor', { x: 3, y: 4 });
    b.awareness.setLocalStateField('cursor', { x: 5, y: 6 });
    network.flush();

    expect(network.sent.slice(before).map(({ from }) => from)).toEqual(['b']);
    expect(b.awareness.getStates().get(a.awareness.clientID)).toEqual({ name: 'a' });
    expect(a.awareness.getStates().get(b.awareness.clientID)).toEqual({ name: 'b' });
  });

  it('reports a send that fails', () => {
    const errors: unknown[] = [];
    const failing: Transport = {
      send: (channel) => {
        throw new Error(`${channel}: the peer is gone`);
      },
      onMessage: () => {},
      onPeerJoin: (handler) => handler('gone'),
      onPeerLeave: () => () => {},
    };
    const awareness = new Awareness(new Y.Doc());
    made.push(awareness);

    connectAwareness(awareness, failing, { onSendError: (error) => errors.push(error) });

    expect(errors.map((error) => (error as Error).message).sort()).toEqual([
      'awareness: the peer is gone',
      'peers: the peer is gone',
    ]);
  });
});
