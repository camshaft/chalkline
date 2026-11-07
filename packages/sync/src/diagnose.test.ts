import { afterEach, describe, expect, it } from 'vitest';
import { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';
import { connectAwareness } from './awareness';
import { MemoryNetwork, seededRandom } from './memory-transport';
import { connectDoc } from './sync';

// A temporary diagnostic of the presence gaps: it logs what each participant receives about each state.

const made: Awareness[] = [];
afterEach(() => {
  for (const awareness of made.splice(0)) awareness.destroy();
});

interface Received {
  client: number;
  clock: number;
  removal: boolean;
}

function receivedOf(data: Uint8Array): Received[] {
  let position = 0;
  const readNumber = (): number => {
    let value = 0;
    let scale = 1;
    while (position < data.length) {
      const byte = data[position];
      position += 1;
      value += (byte & 0x7f) * scale;
      if (byte < 0x80) return value;
      scale *= 128;
    }
    return value;
  };
  const decoder = new TextDecoder();
  const list: Received[] = [];
  const count = readNumber();
  for (let index = 0; index < count; index += 1) {
    const client = readNumber();
    const clock = readNumber();
    const length = readNumber();
    const state = decoder.decode(data.subarray(position, position + length));
    position += length;
    list.push({ client, clock, removal: state === 'null' });
  }
  return list;
}

interface Line {
  client: number | null;
  text: string;
}

interface Participant {
  id: string;
  doc: Y.Doc;
  awareness: Awareness;
  log: Line[];
}

let tick = 0;
const names = new Map<number, string>();

function participant(network: MemoryNetwork, id: string): Participant {
  const doc = new Y.Doc();
  doc.getMap('elements').set(`${id}-before`, { by: id });
  const awareness = new Awareness(doc);
  made.push(awareness);
  awareness.setLocalState({ name: id });
  names.set(awareness.clientID, id);
  const transport = network.join(id);
  connectDoc(doc, transport);
  connectAwareness(awareness, transport);
  const log: Line[] = [];
  const held = (client: number) => {
    const meta = awareness.meta.get(client);
    return `${awareness.getStates().has(client) ? 'held' : 'none'}@${meta === undefined ? '-' : meta.clock}`;
  };
  transport.onMessage((channel, data, from) => {
    tick += 1;
    if (channel === 'awareness') {
      for (const { client, clock, removal } of receivedOf(data)) {
        const name = names.get(client) ?? String(client);
        log.push({ client, text: `${tick} from ${from}: ${name}${removal ? ' REMOVAL' : ''}@${clock} -> ${held(client)}` });
      }
    } else if (channel === 'peers') {
      log.push({ client: null, text: `${tick} from ${from}: peers ${new TextDecoder().decode(data)}` });
    }
  });
  transport.onPeerJoin((peerId) => {
    tick += 1;
    log.push({ client: null, text: `${tick} join ${peerId}` });
  });
  transport.onPeerLeave((peerId) => {
    tick += 1;
    log.push({ client: null, text: `${tick} leave ${peerId}` });
  });
  awareness.on('update', ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => {
    if (origin === 'local' && [...added, ...updated, ...removed].includes(awareness.clientID)) {
      tick += 1;
      log.push({ client: awareness.clientID, text: `${tick} own change @${awareness.meta.get(awareness.clientID)?.clock}` });
    }
  });
  return { id, doc, awareness, log };
}

interface Mesh {
  count: number;
  apart: Array<[string, string]>;
}

const meshes: Mesh[] = [
  { count: 2, apart: [] },
  { count: 3, apart: [] },
  { count: 3, apart: [['a', 'c']] },
  {
    count: 4,
    apart: [
      ['a', 'c'],
      ['a', 'd'],
      ['b', 'd'],
    ],
  },
];

function chaos({ count, apart }: Mesh, seed: number) {
  tick = 0;
  const network = new MemoryNetwork({ seed, drop: 0.1, delay: 4 });
  for (const [first, second] of apart) network.keepApart(first, second);
  const random = seededRandom(seed + 1_000_003);
  const ids = ['a', 'b', 'c', 'd'].slice(0, count);
  const participants = ids.slice(0, -1).map((id) => participant(network, id));
  const rounds = 60;
  for (let round = 0; round < rounds; round += 1) {
    if (round === rounds / 3) participants.push(participant(network, ids[ids.length - 1]));
    const { id, doc, awareness } = participants[Math.floor(random() * participants.length)];
    const choice = random();
    const key = `e${Math.floor(random() * 6)}`;
    if (choice < 0.6) doc.getMap('elements').set(key, { by: id, value: random() });
    else if (choice < 0.75) doc.getMap('elements').delete(key);
    else if (choice < 0.9) doc.getArray('transcript').push([{ by: id, value: random() }]);
    else awareness.setLocalStateField('cursor', { x: random(), y: random() });
    network.run(Math.floor(random() * 4));
  }
  network.drop = 0;
  network.flush();
  return participants;
}

function others(awareness: Awareness): string[] {
  return [...awareness.getStates()]
    .filter(([client]) => client !== awareness.clientID)
    .map(([, state]) => String(state.name))
    .sort();
}

function simple(network: MemoryNetwork, id: string) {
  const awareness = new Awareness(new Y.Doc());
  made.push(awareness);
  awareness.setLocalState({ name: id });
  connectAwareness(awareness, network.join(id));
  return awareness;
}

describe('diagnose', () => {
  for (const mesh of meshes) {
    it(`chaos without renewal on ${mesh.count} peers, ${mesh.apart.length} pairs apart`, () => {
      const failing: number[] = [];
      let printed = 0;
      for (let seed = 1; seed <= 200; seed += 1) {
        const participants = chaos(mesh, seed);
        let failed = false;
        for (const viewer of participants) {
          for (const shown of participants) {
            if (viewer === shown) continue;
            const client = shown.awareness.clientID;
            const seen = viewer.awareness.getStates().get(client);
            if (JSON.stringify(seen) === JSON.stringify(shown.awareness.getLocalState())) continue;
            failed = true;
            if (printed >= 6) continue;
            printed += 1;
            const lines = [
              `MISS mesh ${mesh.count}/${mesh.apart.length} seed ${seed}: ${viewer.id} shows ${shown.id} as ${JSON.stringify(seen)} @${viewer.awareness.meta.get(client)?.clock}, ${shown.id} holds ${JSON.stringify(shown.awareness.getLocalState())} @${shown.awareness.meta.get(client)?.clock}`,
            ];
            for (const other of participants) {
              if (other === shown) continue;
              lines.push(`  at ${other.id}:`);
              const relevant = other.log.filter((line) => line.client === client || line.client === null);
              for (const line of relevant.slice(-40)) lines.push(`    ${line.text}`);
            }
            lines.push(`  at ${shown.id} (own):`);
            for (const line of shown.log.filter((line) => line.client === client || line.client === null).slice(-25)) {
              lines.push(`    ${line.text}`);
            }
            console.log(lines.join('\n'));
          }
        }
        if (failed) failing.push(seed);
      }
      console.log(`SUMMARY mesh ${mesh.count}/${mesh.apart.length}: ${failing.length} of 200 seeds miss a state: ${failing.join(',')}`);
      expect(true).toBe(true);
    });
  }

  it('case 2: drops a departed state that a relay sent along two paths', () => {
    const network = new MemoryNetwork();
    network.keepApart('a', 'c');
    network.keepApart('a', 'd');
    simple(network, 'a');
    network.flush();
    const b = simple(network, 'b');
    network.flush();
    const c = simple(network, 'c');
    network.flush();
    const d = simple(network, 'd');
    network.flush();
    expect(others(d)).toEqual(['a', 'b', 'c']);

    network.leave('a');
    network.flush();

    expect(others(b)).toEqual(['c', 'd']);
    expect(others(c)).toEqual(['b', 'd']);
    expect(others(d)).toEqual(['b', 'c']);
  });

  it('case 3: a peer that joins gets a state that only a departed peer sent', () => {
    const network = new MemoryNetwork();
    network.keepApart('e', 'a');
    network.keepApart('e', 'c');
    simple(network, 'a');
    network.flush();
    simple(network, 'b');
    network.flush();
    simple(network, 'c');
    network.flush();

    network.keepApart('a', 'b');
    const e = simple(network, 'e');
    network.flush();

    expect(others(e)).toEqual(['a', 'b', 'c']);
  });
});
