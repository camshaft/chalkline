import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { MemoryNetwork } from './memory-transport';
import { connectDoc, type Transport } from './sync';

function join(network: MemoryNetwork, id: string, synced: string[] = [], doc = new Y.Doc()): Y.Doc {
  connectDoc(doc, network.join(id), { onSynced: (peerId) => synced.push(peerId) });
  return doc;
}

const shapes = (doc: Y.Doc) => doc.getMap<string>('shapes');

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

  it('sends a peer whose link broke, as it comes back, the change that hadn't arrived', () => {
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

  it("doesn't send on a change that came from another peer", () => {
    const network = new MemoryNetwork();
    const docs = ['a', 'b', 'c'].map((id) => join(network, id));
    network.flush();
    const before = network.sent.length;

    shapes(docs[0]).set('box', 'from a');
    network.flush();

    const sent = network.sent.slice(before).map(({ from, to, channel }) => `${from}->${to} ${channel}`);
    expect(sent.sort()).toEqual(['a->b update', 'a->c update']);
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
        if (channel === 'update') return Promise.reject(new Error('the channel closed'));
        throw new Error('the peer is gone');
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
      'the channel closed',
      'the peer is gone',
    ]);
  });
});
