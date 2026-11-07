import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { MemoryNetwork } from './memory-transport';
import { connectDoc, type Transport } from './sync';

function join(network: MemoryNetwork, id: string, synced: string[] = [], doc = new Y.Doc()): Y.Doc {
  connectDoc(doc, network.join(id), { onSynced: (peerId) => synced.push(peerId) });
  return doc;
}

const shapes = (doc: Y.Doc) => doc.getMap<string>('shapes');

/** Each message sent since the `before`th, as `from->to channel`, sorted. */
function sentSince(network: MemoryNetwork, before: number): string[] {
  return network.sent
    .slice(before)
    .map(({ from, to, channel }) => `${from}->${to} ${channel}`)
    .sort();
}

describe('connectDoc', () => {
  it('sends a peer that joins later the state it lacks', () => {
    const network = new MemoryNetwork();
    const first = join(network, 'a');
    shapes(first).set('box', 'drawn before b joined');
    network.flush();

    const synced: string[] = [];
    const second = join(network, 'b', synced);
    network.flush();

    expect(shapes(second).toJSON()).toEqual({ box: 'drawn before b joined' });
    expect(synced).toEqual(['a']);
  });

  it('sends each later change to every connected peer', () => {
    const network = new MemoryNetwork();
    const docs = ['a', 'b', 'c'].map((id) => join(network, id));
    network.flush();

    shapes(docs[0]).set('box', 'from a');
    network.flush();

    for (const doc of docs) expect(shapes(doc).toJSON()).toEqual({ box: 'from a' });
  });

  it('merges the changes two peers made before they connected', () => {
    const network = new MemoryNetwork();
    const a = new Y.Doc();
    const b = new Y.Doc();
    shapes(a).set('left', 'from a');
    shapes(b).set('right', 'from b');

    join(network, 'a', [], a);
    join(network, 'b', [], b);
    network.flush();

    expect(shapes(a).toJSON()).toEqual({ left: 'from a', right: 'from b' });
    expect(shapes(b).toJSON()).toEqual({ left: 'from a', right: 'from b' });
  });

  it("sends a peer whose link broke, as it comes back, the change that hadn't arrived", () => {
    const network = new MemoryNetwork();
    const synced: string[] = [];
    const a = join(network, 'a');
    const b = join(network, 'b', synced);
    network.flush();

    shapes(a).set('box', 'sent as the link broke');
    network.disconnect('a', 'b');
    network.flush();

    expect(network.dropped).toBe(1);
    expect(shapes(b).toJSON()).toEqual({ box: 'sent as the link broke' });
    expect(synced).toEqual(['a', 'a']);
  });

  it("doesn't send a peer's change on to a peer that the sender reaches", () => {
    const network = new MemoryNetwork();
    const docs = ['a', 'b', 'c'].map((id) => join(network, id));
    network.flush();
    const before = network.sent.length;

    shapes(docs[0]).set('box', 'from a');
    network.flush();

    expect(sentSince(network, before)).toEqual(['a->b update', 'a->c update']);
  });

  it("carries a change on to a peer that the sender doesn't connect to", () => {
    const network = new MemoryNetwork();
    network.keepApart('a', 'c');
    const [a, , c] = ['a', 'b', 'c'].map((id) => join(network, id));
    network.flush();
    const before = network.sent.length;

    shapes(a).set('box', 'from a');
    network.flush();

    expect(shapes(c).toJSON()).toEqual({ box: 'from a' });
    expect(sentSince(network, before)).toEqual(['a->b update', 'b->c update']);
  });

  it("doesn't send on an update that its copy holds already", () => {
    const network = new MemoryNetwork();
    const a = join(network, 'a');
    join(network, 'b');
    const x = network.join('x');
    const updates: Uint8Array[] = [];
    x.onMessage((channel, data) => {
      if (channel === 'update') updates.push(data);
    });
    network.flush();
    shapes(a).set('box', 'from a');
    network.flush();
    const before = network.sent.length;

    x.send('update', updates[0], 'b');
    network.flush();

    expect(updates).toHaveLength(1);
    expect(sentSince(network, before)).toEqual(['x->b update']);
  });

  it("sends an update that it can't apply yet on to every other connected peer, which may lack the same earlier updates", () => {
    const network = new MemoryNetwork();
    const b = join(network, 'b');
    const c = join(network, 'c');
    const x = network.join('x');
    network.flush();
    // x says that it connects to b and c, so that b would leave c out of a change from x that b can apply.
    x.send('peers', new TextEncoder().encode(JSON.stringify({ seq: 1, peers: ['b', 'c'] })), 'b');
    const source = new Y.Doc();
    const updates: Uint8Array[] = [];
    source.on('update', (update: Uint8Array) => updates.push(update));
    shapes(source).set('box', 'first');
    shapes(source).set('box', 'second');
    network.flush();
    const before = network.sent.length;

    // The second update needs the first, which b and c lack.
    x.send('update', updates[1], 'b');
    network.flush();

    expect(shapes(b).toJSON()).toEqual({});
    expect(b.store.pendingStructs).not.toBeNull();
    expect(c.store.pendingStructs).not.toBeNull();
    expect(sentSince(network, before)).toContain('b->c update');
  });

  it('asks each connected peer again for the updates it lacks as a link ends, so that a change the link lost comes through another peer', () => {
    const network = new MemoryNetwork();
    const [a, , c] = ['a', 'b', 'c'].map((id) => join(network, id));
    network.flush();
    const before = network.sent.length;

    shapes(a).set('box', 'sent as the link to c ended');
    network.keepApart('a', 'c');
    network.flush();

    expect(network.dropped).toBe(1);
    expect(shapes(c).toJSON()).toEqual({ box: 'sent as the link to c ended' });
    const sent = sentSince(network, before);
    expect(sent).toContain('c->b resync');
    expect(sent).toContain('b->c resync');
  });

  it('reports each peer that answered its state', () => {
    const network = new MemoryNetwork();
    const synced: Record<string, string[]> = { a: [], b: [], c: [] };
    for (const id of ['a', 'b', 'c']) join(network, id, synced[id]);
    network.flush();

    expect(synced.a.sort()).toEqual(['b', 'c']);
    expect(synced.b.sort()).toEqual(['a', 'c']);
    expect(synced.c.sort()).toEqual(['a', 'b']);
  });

  it('reports a send that fails, whether it throws or rejects', async () => {
    const errors: unknown[] = [];
    const failing: Transport = {
      send: (channel) => {
        if (channel === 'update') return Promise.reject(new Error(`${channel}: the channel closed`));
        throw new Error(`${channel}: the peer is gone`);
      },
      onMessage: () => {},
      onPeerJoin: (handler) => handler('gone'),
      onPeerLeave: () => () => {},
    };
    const doc = new Y.Doc();
    connectDoc(doc, failing, { onSendError: (error) => errors.push(error) });
    shapes(doc).set('box', 'drawn');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(errors.map((error) => (error as Error).message).sort()).toEqual([
      'peers: the peer is gone',
      'state: the peer is gone',
      'update: the channel closed',
    ]);
  });
});
