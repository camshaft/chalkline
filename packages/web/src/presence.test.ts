import { AGENT, Awareness, connectAwareness, MemoryNetwork } from '@chalkline/sync';
import { afterEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  bindPresence,
  collaboratorsFrom,
  keepName,
  NAME_KEY,
  participantName,
  readPresence,
  setName,
  type Button,
  type Collaborator,
  type NameStorage,
  type Pointer,
  type PresenceView,
} from './presence';

class FakeView implements PresenceView {
  readonly shown: Map<string, Collaborator>[] = [];
  selected: Record<string, boolean> = {};
  private readonly changeHandlers = new Set<() => void>();
  private readonly pointerHandlers = new Set<(pointer: Pointer, button: Button) => void>();

  show(collaborators: Map<string, Collaborator>): void {
    this.shown.push(collaborators);
  }

  /** The participants the canvas shows now. */
  latest(): Map<string, Collaborator> {
    return this.shown.at(-1) ?? new Map();
  }

  selection(): Readonly<Record<string, boolean>> {
    return this.selected;
  }

  onChange(handler: () => void): () => void {
    this.changeHandlers.add(handler);
    return () => {
      this.changeHandlers.delete(handler);
    };
  }

  onPointer(handler: (pointer: Pointer, button: Button) => void): () => void {
    this.pointerHandlers.add(handler);
    return () => {
      this.pointerHandlers.delete(handler);
    };
  }

  /** A person moves the pointer over the canvas. */
  move(x: number, y: number, button: Button = 'up'): void {
    for (const handler of this.pointerHandlers) handler({ x, y, tool: 'pointer' }, button);
  }

  /** A person selects elements: the canvas changes, then tells its listeners. */
  select(...ids: string[]): void {
    this.selected = Object.fromEntries(ids.map((id) => [id, true]));
    this.changed();
  }

  /** The canvas changes and keeps its selection, as after a person scrolls. */
  changed(): void {
    for (const handler of this.changeHandlers) handler();
  }
}

class MemoryStorage implements NameStorage {
  readonly items = new Map<string, string>();

  getItem(key: string): string | null {
    return this.items.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.items.set(key, value);
  }
}

const made: Awareness[] = [];
afterEach(() => {
  for (const awareness of made.splice(0)) awareness.destroy();
});

function awarenessNamed(name: string): Awareness {
  const awareness = new Awareness(new Y.Doc());
  made.push(awareness);
  setName(awareness, name);
  return awareness;
}

/** A participant called `name`, whose page binds its presence as it joins. */
function participant(network: MemoryNetwork, id: string, name: string) {
  const awareness = awarenessNamed(name);
  connectAwareness(awareness, network.join(id));
  const view = new FakeView();
  const stop = bindPresence(awareness, view);
  return { awareness, view, stop, client: String(awareness.clientID) };
}

/** Two participants, Ada and Grace, who see each other. */
function pair() {
  const network = new MemoryNetwork();
  const ada = participant(network, 'a', 'Ada');
  const grace = participant(network, 'b', 'Grace');
  network.flush();
  return { network, ada, grace };
}

describe('readPresence', () => {
  it('reads a name, a pointer, a button and a selection', () => {
    const state = {
      name: 'Ada',
      pointer: { x: 1.5, y: -2, tool: 'laser' },
      button: 'down',
      selectedElementIds: { box: true },
    };

    expect(readPresence(state)).toEqual(state);
  });

  it('leaves out each field of the wrong type', () => {
    expect(readPresence({ name: 7, pointer: { x: '1', y: 2 }, button: 'left', selectedElementIds: ['box'] })).toEqual({});
    expect(readPresence({ name: '  ', pointer: { x: Number.POSITIVE_INFINITY, y: 2, tool: 'pointer' } })).toEqual({});
    expect(readPresence({ pointer: { x: 1, y: Number.NaN, tool: 'pointer' } })).toEqual({});
  });

  it("reads a pointer of a tool it doesn't know as the plain pointer, and keeps only the selected ids", () => {
    expect(readPresence({ pointer: { x: 3, y: 4, tool: 'pen' }, selectedElementIds: { a: true, b: false, c: 'yes' } })).toEqual({
      pointer: { x: 3, y: 4, tool: 'pointer' },
      selectedElementIds: { a: true },
    });
  });

  it('keeps a selected id of `__proto__` as an id', () => {
    const presence = readPresence(JSON.parse('{"selectedElementIds": {"__proto__": true}}'));

    expect(Object.keys(presence?.selectedElementIds ?? {})).toEqual(['__proto__']);
    expect(Object.getPrototypeOf(presence?.selectedElementIds)).toBe(Object.prototype);
  });

  it("reads a state that isn't an object as null", () => {
    for (const state of [null, undefined, 'Ada', 3, ['Ada']]) expect(readPresence(state)).toBeNull();
  });
});

describe('collaboratorsFrom', () => {
  it('lists every other participant by its client id, and leaves out this one and each state that is not an object', () => {
    const states = new Map<number, unknown>([
      [1, { name: 'Me', pointer: { x: 0, y: 0, tool: 'pointer' } }],
      [2, { name: 'Ada', pointer: { x: 1, y: 2, tool: 'pointer' }, button: 'up' }],
      [3, {}],
      [4, 'broken'],
    ]);

    expect([...collaboratorsFrom(states, 1)]).toEqual([
      ['2', { id: '2', username: 'Ada', pointer: { x: 1, y: 2, tool: 'pointer' }, button: 'up' }],
      ['3', { id: '3' }],
    ]);
  });

  it("leaves out an agent's helper, whose state says only that an agent is on the board", () => {
    const states = new Map<number, unknown>([
      [2, { name: 'Ada' }],
      [5, { [AGENT]: true }],
    ]);

    expect([...collaboratorsFrom(states, 1)]).toEqual([['2', { id: '2', username: 'Ada' }]]);
  });
});

describe('bindPresence', () => {
  it("shows a peer's name and pointer as the peer moves", () => {
    const { network, ada, grace } = pair();

    ada.view.move(10, 20, 'down');
    network.flush();

    expect(grace.view.latest().get(ada.client)).toEqual({
      id: ada.client,
      username: 'Ada',
      pointer: { x: 10, y: 20, tool: 'pointer' },
      button: 'down',
      selectedElementIds: {},
    });
  });

  it("doesn't show this participant, and doesn't redraw for its own changes", () => {
    const { network, ada, grace } = pair();
    const shows = ada.view.shown.length;

    ada.view.move(1, 2);
    ada.view.select('box');
    setName(ada.awareness, 'Ada Lovelace');
    network.flush();

    expect(ada.view.shown).toHaveLength(shows);
    expect([...ada.view.latest().keys()]).toEqual([grace.client]);
    expect(grace.view.latest().get(ada.client)?.username).toBe('Ada Lovelace');
  });

  it('shares the selection as it changes, and sends nothing where it stays the same', () => {
    const { network, ada, grace } = pair();

    ada.view.select('box', 'arrow');
    network.flush();

    expect(grace.view.latest().get(ada.client)?.selectedElementIds).toEqual({ box: true, arrow: true });

    const before = network.sent.length;
    ada.view.changed();
    network.flush();

    expect(network.sent).toHaveLength(before);
  });

  it("shows a peer's new name, and sends nothing where the name stays the same", () => {
    const { network, ada, grace } = pair();

    setName(ada.awareness, 'Ada Lovelace');
    network.flush();

    expect(grace.view.latest().get(ada.client)?.username).toBe('Ada Lovelace');

    const before = network.sent.length;
    setName(ada.awareness, 'Ada Lovelace');
    network.flush();

    expect(network.sent).toHaveLength(before);
  });

  it('stops showing a peer that leaves', () => {
    const { network, ada, grace } = pair();
    expect([...grace.view.latest().keys()]).toEqual([ada.client]);

    network.leave('a');
    network.flush();

    expect([...grace.view.latest().keys()]).toEqual([]);
  });

  it('shows the participants already in the room as it binds', () => {
    const network = new MemoryNetwork();
    const ada = participant(network, 'a', 'Ada');
    const awareness = awarenessNamed('Grace');
    connectAwareness(awareness, network.join('b'));
    network.flush();
    const view = new FakeView();

    bindPresence(awareness, view);

    expect(view.shown).toHaveLength(1);
    expect(view.latest().get(ada.client)?.username).toBe('Ada');
  });

  it('stops following both sides once stopped', () => {
    const { network, ada, grace } = pair();
    const shows = grace.view.shown.length;
    const before = network.sent.length;

    grace.stop();
    grace.view.move(5, 5);
    grace.view.select('box');
    ada.view.move(1, 1);
    network.flush();

    expect(grace.view.shown).toHaveLength(shows);
    expect(network.sent.slice(before).map(({ from }) => from)).toEqual(['a']);
  });
});

describe('participantName', () => {
  it('answers the name this browser kept', () => {
    const storage = new MemoryStorage();
    storage.setItem(NAME_KEY, 'Ada');

    expect(participantName(storage, () => 0.5)).toBe('Ada');
  });

  it('makes a name where none is kept, and keeps it', () => {
    const storage = new MemoryStorage();

    expect(participantName(storage, () => 0.25)).toBe('Guest 4000');
    expect(storage.items.get(NAME_KEY)).toBe('Guest 4000');
    expect(participantName(storage, () => 0.75)).toBe('Guest 4000');
  });

  it('makes a new name where the kept one is blank', () => {
    const storage = new MemoryStorage();
    storage.setItem(NAME_KEY, '  ');

    expect(participantName(storage, () => 0)).toBe('Guest 0000');
  });

  it('makes a name where the browser refuses the page its storage', () => {
    const refusing: NameStorage = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
    };

    expect(participantName(refusing, () => 1 / 0x10000)).toBe('Guest 0001');
    expect(participantName(undefined, () => 0.999999)).toBe('Guest ffff');
    expect(() => keepName(refusing, 'Ada')).not.toThrow();
  });
});
