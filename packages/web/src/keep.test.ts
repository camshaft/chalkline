import 'fake-indexeddb/auto';
import { connectDoc, MemoryNetwork } from '@chalkline/sync';
import { afterEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { keepBoard, storeName, STORE_PREFIX, type KeptBoard } from './keep';

interface Shape {
  id: string;
  version: number;
}

function shape(id: string, version = 1): Shape {
  return { id, version };
}

let names = 0;
/** A database name that no other test uses. */
function freshName(): string {
  names += 1;
  return `test-board-${names}`;
}

const open = new Set<KeptBoard>();
afterEach(async () => {
  await Promise.all([...open].map((kept) => kept.stop()));
  open.clear();
});

/** A page that keeps its board in the database `name`, once the copy kept there has loaded. */
async function page(name: string, doc = new Y.Doc()) {
  const kept = keepBoard(doc, name);
  open.add(kept);
  await kept.loaded;
  return { doc, kept, elements: doc.getMap<Shape>('elements') };
}

/** The page closes: its database closes once each change it kept is written. */
async function close(kept: KeptBoard): Promise<void> {
  open.delete(kept);
  await kept.stop();
}

describe('storeName', () => {
  it("names the database with the room's name and a digest of its name and password", async () => {
    const name = await storeName({ room: 'standup', key: 'a-password' });

    expect(name).toMatch(/^chalkline-board-standup-[0-9a-f]{32}$/);
    expect(name.startsWith(STORE_PREFIX)).toBe(true);
    expect(name).not.toContain('a-password');
    expect(await storeName({ room: 'standup', key: 'a-password' })).toBe(name);
  });

  it('names a database of its own for each password of one room, and for each room', async () => {
    const name = await storeName({ room: 'standup', key: 'a-password' });

    expect(await storeName({ room: 'standup', key: 'another-password' })).not.toBe(name);
    expect(await storeName({ room: 'retro', key: 'a-password' })).toMatch(/^chalkline-board-retro-[0-9a-f]{32}$/);
  });

  it("doesn't take a line break in the room's name for the end of the name", async () => {
    const one = await storeName({ room: 'a\nb', key: 'c' });
    const other = await storeName({ room: 'a', key: 'b\nc' });

    expect(one).toMatch(/^chalkline-board-a%0Ab-[0-9a-f]{32}$/);
    expect(one.slice(-32)).not.toBe(other.slice(-32));
  });
});

describe('keepBoard', () => {
  it('keeps the board through a reload', async () => {
    const name = freshName();
    const first = await page(name);
    first.elements.set('box', shape('box', 2));
    await close(first.kept);

    const second = await page(name);

    expect(second.elements.toJSON()).toEqual({ box: shape('box', 2) });
  });

  it('keeps the shapes drawn before the database opened', async () => {
    const name = freshName();
    const doc = new Y.Doc();
    doc.getMap<Shape>('elements').set('early', shape('early'));
    const first = await page(name, doc);
    await close(first.kept);

    const second = await page(name);

    expect(second.elements.toJSON()).toEqual({ early: shape('early') });
  });

  it('adds the kept copy to the shapes the page holds already', async () => {
    const name = freshName();
    const first = await page(name);
    first.elements.set('kept', shape('kept'));
    await close(first.kept);

    const doc = new Y.Doc();
    doc.getMap<Shape>('elements').set('new', shape('new'));
    const second = await page(name, doc);

    expect(second.elements.toJSON()).toEqual({ kept: shape('kept'), new: shape('new') });
  });

  it('keeps each room apart', async () => {
    const one = await page(freshName());
    one.elements.set('box', shape('box'));
    await close(one.kept);

    const other = await page(freshName());

    expect(other.elements.size).toBe(0);
  });

  it("keeps a peer's shapes, and sends the shapes drawn offline once the peer is back", async () => {
    const name = freshName();
    const network = new MemoryNetwork();
    // Ada's page connects to the room, then keeps the board, as the page does.
    const adaDoc = new Y.Doc();
    connectDoc(adaDoc, network.join('ada'));
    const ada = await page(name, adaDoc);
    const grace = new Y.Doc();
    connectDoc(grace, network.join('grace'));
    grace.getMap<Shape>('elements').set('theirs', shape('theirs'));
    network.flush();
    expect(ada.elements.toJSON()).toEqual({ theirs: shape('theirs') });

    // Ada goes offline, draws a box, and reloads the page while still offline.
    network.leave('ada');
    ada.elements.set('mine', shape('mine'));
    network.flush();
    await close(ada.kept);
    expect(grace.getMap<Shape>('elements').has('mine')).toBe(false);
    const backDoc = new Y.Doc();
    const back = await page(name, backDoc);
    expect(back.elements.toJSON()).toEqual({ theirs: shape('theirs'), mine: shape('mine') });

    // Ada's connection comes back, and the box she drew offline reaches Grace.
    connectDoc(backDoc, network.join('ada-again'));
    network.flush();

    expect(grace.getMap<Shape>('elements').toJSON()).toEqual({ theirs: shape('theirs'), mine: shape('mine') });
  });

  it('sends the kept copy to the peers where it loads after the page connected', async () => {
    const name = freshName();
    const first = await page(name);
    first.elements.set('kept', shape('kept'));
    await close(first.kept);

    const network = new MemoryNetwork();
    const adaDoc = new Y.Doc();
    connectDoc(adaDoc, network.join('ada'));
    const grace = new Y.Doc();
    connectDoc(grace, network.join('grace'));
    network.flush();
    await page(name, adaDoc);
    network.flush();

    expect(grace.getMap<Shape>('elements').toJSON()).toEqual({ kept: shape('kept') });
  });
});
