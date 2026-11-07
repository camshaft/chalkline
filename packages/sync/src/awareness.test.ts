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

/** An awareness message that sets `client`'s entry to `state` at `clock`, or removes it where `state` is null. */
function awarenessMessage(client: number, clock: number, state: Record<string, unknown> | null): Uint8Array {
  const writer = new Awareness(new Y.Doc());
  made.push(writer);
  writer.meta.set(client, { clock, lastUpdated: 0 });
  const states = new Map<number, Record<string, unknown>>();
  if (state !== null) states.set(client, state);
  return encodeAwarenessUpdate(writer, [client], states);
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

  it("sends a peer that joins every state it holds, the state of a departed peer that another peer's list still holds among them", () => {
    const network = new MemoryNetwork();
    const a = participant(network, 'a');
    network.flush();
    const b = participant(network, 'b');
    network.flush();
    const c = participant(network, 'c');
    network.flush();
    a.awareness.setLocalStateField('cursor', { x: 1, y: 2 });
    network.flush();
    const aId = a.awareness.clientID;
    // b and c hold a's state at the same clock, so a copy of it that c sends to b doesn't change b's copy.
    expect(b.awareness.meta.get(aId)?.clock).toBe(c.awareness.meta.get(aId)?.clock);

    network.keepApart('a', 'b');
    network.run(2);
    // b's link to a has ended, and b keeps a's state, since c's list still holds a.
    expect(others(b.awareness)).toEqual(['a', 'c']);
    network.keepApart('e', 'a');
    network.keepApart('e', 'c');
    const e = participant(network, 'e');
    network.flush();

    expect(e.awareness.getStates().get(aId)).toEqual({ name: 'a', cursor: { x: 1, y: 2 } });
    expect(others(e.awareness)).toEqual(['a', 'b', 'c']);
  });

  it('removes the state of a peer that leaves from each peer that holds it, a peer that a second relay sent it to among them', () => {
    const network = new MemoryNetwork();
    network.keepApart('a', 'c');
    network.keepApart('a', 'd');
    const [, b, c, d] = ['a', 'b', 'c', 'd'].map((id) => {
      const joined = participant(network, id);
      network.flush();
      return joined;
    });
    // a connects only to b, and b, c and d each hold a's state.
    for (const peer of [b, c, d]) expect(others(peer.awareness)).toContain('a');

    network.leave('a');
    network.flush();

    expect(others(b.awareness)).toEqual(['c', 'd']);
    expect(others(c.awareness)).toEqual(['b', 'd']);
    expect(others(d.awareness)).toEqual(['b', 'c']);
  });

  it('removes the state of a peer that leaves from two relays that each sent the other that state', () => {
    const network = new MemoryNetwork();
    network.keepApart('a', 'c');
    network.keepApart('a', 'd');
    const a = participant(network, 'a');
    network.flush();
    const b = participant(network, 'b');
    network.flush();
    const aId = a.awareness.clientID;
    // Each message with a's state in it that one relay sent the other, as `from->to`.
    const relayed: string[] = [];
    /** Joins the relay `id`, which records each message from the relay `other` that holds a's state. */
    const relay = (id: string, other: string): Awareness => {
      const transport = network.join(id);
      transport.onMessage((channel, data, from) => {
        if (channel !== 'awareness' || from !== other) return;
        const reader = new Awareness(new Y.Doc());
        made.push(reader);
        applyAwarenessUpdate(reader, data, 'test');
        if (reader.getStates().has(aId)) relayed.push(`${from}->${id}`);
      });
      const awareness = new Awareness(new Y.Doc());
      made.push(awareness);
      awareness.setLocalState({ name: id });
      connectAwareness(awareness, transport);
      network.flush();
      return awareness;
    };
    const c = relay('c', 'd');
    const d = relay('d', 'c');
    relayed.splice(0);

    // The link of c and d breaks and comes back, and each sends the other every state it holds, a's among them.
    network.disconnect('c', 'd');
    network.flush();
    expect(relayed).toContain('c->d');
    expect(relayed).toContain('d->c');
    for (const peer of [b.awareness, c, d]) expect(others(peer)).toContain('a');

    network.leave('a');
    network.flush();

    expect(others(b.awareness)).toEqual(['c', 'd']);
    expect(others(c)).toEqual(['b', 'd']);
    expect(others(d)).toEqual(['b', 'c']);
  });

  it("shows each participant's latest state at every peer of a line once its middle link breaks and comes back, with messages out of order", () => {
    let reordered = 0;
    for (let seed = 1; seed <= 200; seed += 1) {
      const network = new MemoryNetwork({ seed });
      network.keepApart('a', 'c');
      network.keepApart('a', 'd');
      network.keepApart('b', 'd');
      const line = ['a', 'b', 'c', 'd'].map((id) => participant(network, id));
      network.flush();
      // Before the break, each peer shows the other three.
      for (const viewer of line) expect(others(viewer.awareness), `seed ${seed}`).toHaveLength(3);

      network.delay = 10;
      network.disconnect('b', 'c');
      network.flush();
      reordered += network.reordered;

      for (const viewer of line) {
        for (const shown of line) {
          if (viewer === shown) continue;
          expect(viewer.awareness.getStates().get(shown.awareness.clientID), `seed ${seed}`).toEqual(
            shown.awareness.getLocalState(),
          );
        }
      }
    }
    expect(reordered).toBeGreaterThan(0);
  });

  it('shows a peer that joins again on a new connection, whose messages are numbered again from the first', () => {
    const network = new MemoryNetwork();
    const a = participant(network, 'a');
    const b = participant(network, 'b');
    network.flush();
    for (let x = 1; x <= 3; x += 1) {
      a.awareness.setLocalStateField('cursor', { x, y: 0 });
      network.flush();
    }
    a.stop();
    network.leave('a');
    network.flush();
    expect(others(b.awareness)).toEqual([]);

    connectAwareness(a.awareness, network.join('a'));
    network.flush();

    expect(b.awareness.getStates().get(a.awareness.clientID)).toEqual({ name: 'a', cursor: { x: 3, y: 0 } });
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

  it('sends a removal on once, applies it where it arrives again, and sends it on again once the state shows again', () => {
    const network = new MemoryNetwork();
    const b = participant(network, 'b');
    const x = network.join('x');
    const y = network.join('y');
    network.flush();
    const client = 99;
    /** x and y each send b the state of `client`, a participant that isn't on the network. */
    const show = () => {
      y.send('awareness', awarenessMessage(client, 1, { name: 'z' }), 'b');
      x.send('awareness', awarenessMessage(client, 1, { name: 'z' }), 'b');
      network.flush();
    };
    /** x sends b the removal of that state; returns each message sent after it. */
    const remove = (): string[] => {
      x.send('awareness', awarenessMessage(client, 2, null), 'b');
      const before = network.sent.length;
      network.flush();
      return sentSince(network, before);
    };

    // b holds the state from y too, so the removal goes on to y and doesn't apply.
    show();
    expect(remove()).toEqual(['b->y awareness']);
    expect(b.awareness.getStates().has(client)).toBe(true);
    // The same removal arrives again, as among peers that each sent the next one the state: it applies.
    expect(remove()).toEqual(['b->y awareness']);
    expect(b.awareness.getStates().has(client)).toBe(false);

    // Once the state shows again, the next removal goes on to y again.
    show();
    expect(b.awareness.getStates().has(client)).toBe(true);
    expect(remove()).toEqual(['b->y awareness']);
    expect(b.awareness.getStates().has(client)).toBe(true);
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
