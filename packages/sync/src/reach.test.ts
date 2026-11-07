import { describe, expect, it } from 'vitest';
import { MemoryNetwork } from './memory-transport';
import { reachOf, readPeerList } from './reach';

describe('Reach', () => {
  it('sends its list of the peers it connects to, to each of them, as each link starts and ends', () => {
    const network = new MemoryNetwork();
    reachOf(network.join('a'));
    const got: string[] = [];
    for (const id of ['b', 'c']) {
      network.join(id).onMessage((channel, data, from) => {
        if (channel !== 'peers') return;
        const list = readPeerList(data);
        if (list !== null) got.push(`${id} got ${list.seq} [${list.peers.join(' ')}] from ${from}`);
      });
      network.flush();
    }

    network.leave('c');
    network.flush();

    expect(got).toEqual(['b got 1 [b] from a', 'b got 2 [b c] from a', 'c got 2 [b c] from a', 'b got 3 [b] from a']);
  });

  it("leaves out of a change from a peer the peers that the peer's newest list holds, and reports a list that drops one", () => {
    const network = new MemoryNetwork();
    const reach = reachOf(network.join('a'));
    const [b] = ['b', 'c', 'd'].map((id) => network.join(id));
    network.flush();
    const changes: boolean[] = [];
    reach.onChange((dropped) => changes.push(dropped));
    const sendList = (list: unknown) => b.send('peers', new TextEncoder().encode(JSON.stringify(list)), 'a');

    expect(reach.targets('b')).toEqual(['c', 'd']);
    sendList({ seq: 2, peers: ['a', 'c', 'd'] });
    network.flush();
    expect(reach.targets('b')).toEqual([]);
    expect(reach.listed('d')).toBe(true);

    // An older list, a list as old as the newest, a list of the wrong form, and bytes that aren't JSON change nothing.
    sendList({ seq: 1, peers: ['a'] });
    sendList({ seq: 2, peers: ['a'] });
    sendList({ seq: 5, peers: 'a' });
    b.send('peers', new TextEncoder().encode('not json'), 'a');
    b.send('peers', new Uint8Array([0xff, 0xfe]), 'a');
    network.flush();
    expect(reach.targets('b')).toEqual([]);

    sendList({ seq: 3, peers: ['a', 'c'] });
    network.flush();
    expect(reach.targets('b')).toEqual(['d']);
    expect(reach.listed('d')).toBe(false);
    expect(changes).toEqual([false, true]);
  });

  it('is one for each transport, so that connectDoc and connectAwareness share it', () => {
    const network = new MemoryNetwork();
    const transport = network.join('a');

    expect(reachOf(transport)).toBe(reachOf(transport));
    expect(reachOf(network.join('b'))).not.toBe(reachOf(transport));
  });
});
