import { afterEach, describe, expect, it } from 'vitest';
import { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';
import { connectAwareness } from './awareness';
import { MemoryNetwork, seededRandom } from './memory-transport';
import { connectDoc } from './sync';

interface Participant {
  id: string;
  doc: Y.Doc;
  awareness: Awareness;
}

const made: Awareness[] = [];
afterEach(() => {
  for (const awareness of made.splice(0)) awareness.destroy();
});

function participant(network: MemoryNetwork, id: string): Participant {
  const doc = new Y.Doc();
  // A change made before joining, which the others learn of as this participant joins.
  doc.getMap('elements').set(`${id}-before`, { by: id });
  const awareness = new Awareness(doc);
  made.push(awareness);
  awareness.setLocalState({ name: id });
  const transport = network.join(id);
  connectDoc(doc, transport);
  connectAwareness(awareness, transport);
  return { id, doc, awareness };
}

function stateVector(doc: Y.Doc): Array<[number, number]> {
  return [...Y.decodeStateVector(Y.encodeStateVector(doc))].sort(([left], [right]) => left - right);
}

/** How many participants a test runs, and the pairs of them that never connect. */
interface Mesh {
  count: number;
  apart: Array<[string, string]>;
  /** How the test's title describes the pairs that never connect. */
  where: string;
}

const meshes: Mesh[] = [
  { count: 2, apart: [], where: '' },
  { count: 3, apart: [], where: '' },
  { count: 3, apart: [['a', 'c']], where: ', where a and c never connect' },
  {
    count: 4,
    apart: [
      ['a', 'c'],
      ['a', 'd'],
      ['b', 'd'],
    ],
    where: ', in a line where each connects only to its neighbours',
  },
];

/**
 * Runs the participants of `mesh` on a network that loses, delays and
 * reorders messages, where each pair that `mesh` keeps apart never connects.
 * In each round one participant changes a shape, deletes one, adds to the
 * transcript or moves its cursor, and the network runs a few events. The last
 * participant joins a third of the way through. Then the network heals, and
 * every queued event runs.
 */
function chaos({ count, apart }: Mesh, seed: number) {
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
  return { network, participants };
}

describe('documents on a network that loses, delays and reorders messages', () => {
  for (const mesh of meshes) {
    it(`end with all ${mesh.count} copies equal${mesh.where}, and each participant shows the others' latest awareness`, () => {
      let dropped = 0;
      let reordered = 0;
      for (let seed = 1; seed <= 40; seed += 1) {
        const { network, participants } = chaos(mesh, seed);
        dropped += network.dropped;
        reordered += network.reordered;
        const [first, ...rest] = participants;
        const elements = first.doc.getMap('elements').toJSON();
        for (const { id } of participants) expect(elements, `seed ${seed}`).toHaveProperty(`${id}-before`);
        for (const other of rest) {
          expect(other.doc.getMap('elements').toJSON(), `seed ${seed}`).toEqual(elements);
          expect(other.doc.getArray('transcript').toJSON(), `seed ${seed}`).toEqual(
            first.doc.getArray('transcript').toJSON(),
          );
          expect(stateVector(other.doc), `seed ${seed}`).toEqual(stateVector(first.doc));
        }
        for (const viewer of participants) {
          for (const shown of participants) {
            if (viewer === shown) continue;
            expect(viewer.awareness.getStates().get(shown.awareness.clientID), `seed ${seed}`).toEqual(
              shown.awareness.getLocalState(),
            );
          }
        }
      }
      expect(dropped).toBeGreaterThan(0);
      expect(reordered).toBeGreaterThan(0);
    });
  }
});
