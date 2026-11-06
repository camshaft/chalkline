import { describe, expect, it } from 'vitest';
import { MemoryNetwork, seededRandom } from './memory-transport';

/** Joins each of `ids`, and records each join, leave and message each peer sees. */
function watched(network: MemoryNetwork, ids: string[]) {
  const seen: string[] = [];
  const peers = ids.map((id) => {
    const peer = network.join(id);
    peer.onPeerJoin((other) => seen.push(`${id} saw ${other} join`));
    peer.onPeerLeave((other) => seen.push(`${id} saw ${other} leave`));
    peer.onMessage((channel, data, from) => seen.push(`${id} got ${channel} ${data[0]} from ${from}`));
    return peer;
  });
  return { seen, peers };
}

describe('MemoryNetwork', () => {
  it('without faults, runs each join and message in the order it was queued', () => {
    const network = new MemoryNetwork();
    const { seen, peers } = watched(network, ['a', 'b']);
    network.flush();

    for (const number of [1, 2, 3]) peers[0].send('update', new Uint8Array([number]));
    network.flush();

    expect(seen).toEqual([
      'a saw b join',
      'b saw a join',
      'b got update 1 from a',
      'b got update 2 from a',
      'b got update 3 from a',
    ]);
    expect(network.reordered).toBe(0);
    expect(network.dropped).toBe(0);
  });

  it('with a delay, delivers every message out of the order it was sent in, the same way for the same seed', () => {
    const run = (seed: number) => {
      const network = new MemoryNetwork({ seed, delay: 5 });
      const { seen, peers } = watched(network, ['a', 'b']);
      network.flush();
      for (let number = 0; number < 20; number += 1) peers[0].send('update', new Uint8Array([number]));
      network.flush();
      return { arrived: seen.filter((line) => line.startsWith('b got')), reordered: network.reordered };
    };

    const first = run(7);

    expect(first.reordered).toBeGreaterThan(0);
    expect(first.arrived).toHaveLength(20);
    expect(first.arrived).not.toEqual([...first.arrived].sort((x, y) => Number(x.split(' ')[3]) - Number(y.split(' ')[3])));
    expect(run(7)).toEqual(first);
  });

  it("breaks the link of a lost message: both peers see a leave, what hadn't arrived is lost, and the link comes back", () => {
    const network = new MemoryNetwork({ seed: 1 });
    const { seen, peers } = watched(network, ['a', 'b']);
    network.flush();
    const [a] = peers;

    a.send('update', new Uint8Array([1]));
    network.drop = 1;
    a.send('update', new Uint8Array([2]));
    network.drop = 0;
    a.send('update', new Uint8Array([3]));
    network.flush();
    a.send('update', new Uint8Array([4]));
    network.flush();

    expect(seen).toEqual([
      'a saw b join',
      'b saw a join',
      'a saw b leave',
      'b saw a leave',
      'a saw b join',
      'b saw a join',
      'b got update 4 from a',
    ]);
    // The second message was dropped, and the first hadn't arrived when its link broke.
    expect(network.dropped).toBe(2);
    // The third went while the link was down, so a didn't send it.
    expect(network.sent.map(({ to }) => to)).toEqual(['b', 'b', 'b']);
  });

  it('breaks a link on request, as a lost message does', () => {
    const network = new MemoryNetwork();
    const { seen } = watched(network, ['a', 'b']);
    network.flush();

    network.disconnect('a', 'b');
    network.flush();

    expect(seen.slice(2)).toEqual(['a saw b leave', 'b saw a leave', 'a saw b join', 'b saw a join']);
  });

  it("takes a peer that leaves off the network, with its messages that hadn't arrived", () => {
    const network = new MemoryNetwork();
    const { seen, peers } = watched(network, ['a', 'b', 'c']);
    network.flush();

    peers[0].send('update', new Uint8Array([1]));
    network.leave('a');
    network.flush();
    peers[0].send('update', new Uint8Array([2]));
    network.flush();

    expect(seen.slice(6)).toEqual(['b saw a leave', 'c saw a leave']);
    expect(network.dropped).toBe(2);
  });
});

describe('seededRandom', () => {
  it('returns the same series for the same seed, each number from 0 up to 1', () => {
    const first = Array.from({ length: 100 }, seededRandom(42));
    const again = Array.from({ length: 100 }, seededRandom(42));
    const other = Array.from({ length: 100 }, seededRandom(43));

    expect(again).toEqual(first);
    expect(other).not.toEqual(first);
    expect(first.every((number) => number >= 0 && number < 1)).toBe(true);
  });
});
