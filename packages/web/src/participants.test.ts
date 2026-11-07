// @vitest-environment jsdom
import { Awareness, connectAwareness, MemoryNetwork } from '@chalkline/sync';
import { afterEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { bindParticipants, participantLine, participantsFrom, type Participant, type ParticipantsView } from './participants';

const made: Awareness[] = [];
afterEach(() => {
  for (const awareness of made.splice(0)) awareness.destroy();
});

/** A participant of awareness client id `client` on `network`, which shares `state`. */
function peer(network: MemoryNetwork, client: number, state: Record<string, unknown>): Awareness {
  const doc = new Y.Doc();
  doc.clientID = client;
  const awareness = new Awareness(doc);
  made.push(awareness);
  awareness.setLocalState(state);
  connectAwareness(awareness, network.join(String(client)));
  return awareness;
}

/** A board that holds the shapes the test sets, with the shapes each Go to showed. */
function testView(...held: string[]) {
  let shapes = new Set(held);
  const handlers = new Set<() => void>();
  const shown: string[][] = [];
  const view: ParticipantsView = {
    holds: (id) => shapes.has(id),
    goTo: (ids) => {
      shown.push([...ids]);
    },
    onShapes: (handler) => {
      handlers.add(handler);
      return () => {
        handlers.delete(handler);
      };
    },
  };
  return {
    view,
    shown,
    handlers,
    /** The board's shapes change to `ids`, and the board tells its listeners. */
    hold(...ids: string[]) {
      shapes = new Set(ids);
      for (const handler of handlers) handler();
    },
  };
}

/** Each item of `list`: its client, its line, its badge, and whether it holds a Go to button. */
function items(list: HTMLElement) {
  return Array.from(list.querySelectorAll('li'), (entry) => ({
    client: entry.dataset.client,
    line: entry.querySelector('.chalkline-participant-name')?.textContent,
    badge: entry.querySelector('.chalkline-participant-badge')?.textContent ?? null,
    go: entry.querySelector('.chalkline-participant-go') !== null,
  }));
}

describe('participantsFrom', () => {
  it('lists each other participant that has a name, in the order of their client ids', () => {
    const states = new Map<number, unknown>([
      [3, { name: 'Grace', pointer: { x: 1, y: 2, tool: 'pointer' } }],
      [1, { name: 'Ada' }],
      [2, { name: 'Claude', agent: true, status: 'working', shapes: ['box', 'arrow'] }],
      [4, { pointer: { x: 0, y: 0, tool: 'pointer' } }],
      [5, 'Ada'],
      [6, { name: 'Helper', agent: true }],
    ]);

    expect(participantsFrom(states, 1)).toEqual([
      { client: 2, name: 'Claude', agent: true, working: true, shapes: ['box', 'arrow'] },
      { client: 3, name: 'Grace', agent: false, working: false, shapes: [] },
      { client: 6, name: 'Helper', agent: true, working: false, shapes: [] },
    ]);
  });

  it("reads an idle agent as not working, and doesn't read a status or shapes of a person", () => {
    const states = new Map<number, unknown>([
      [2, { name: 'Claude', agent: true, status: 'idle', shapes: ['box'] }],
      [3, { name: 'Grace', status: 'working', shapes: ['box'] }],
    ]);

    expect(participantsFrom(states, 1)).toEqual([
      { client: 2, name: 'Claude', agent: true, working: false, shapes: ['box'] },
      { client: 3, name: 'Grace', agent: false, working: false, shapes: [] },
    ]);
  });
});

describe('participantLine', () => {
  it('reads the name, or that the agent is drawing while it works', () => {
    const claude: Participant = { client: 2, name: 'Claude', agent: true, working: false, shapes: [] };

    expect(participantLine(claude)).toBe('Claude');
    expect(participantLine({ ...claude, working: true })).toBe('Claude is drawing...');
  });
});

describe('bindParticipants', () => {
  it('shows an agent with the Agent badge, and as drawing only while it works', () => {
    const network = new MemoryNetwork();
    const self = peer(network, 1, { name: 'Ada' });
    const agent = peer(network, 2, { name: 'Claude', agent: true, status: 'idle' });
    network.flush();
    const list = document.createElement('ul');

    bindParticipants(list, self, testView().view);

    expect(list.hidden).toBe(false);
    expect(items(list)).toEqual([{ client: '2', line: 'Claude', badge: 'Agent', go: false }]);

    agent.setLocalState({ name: 'Claude', agent: true, status: 'working' });
    network.flush();
    expect(items(list)).toEqual([{ client: '2', line: 'Claude is drawing...', badge: 'Agent', go: false }]);

    agent.setLocalState({ name: 'Claude', agent: true, status: 'idle' });
    network.flush();
    expect(items(list)).toEqual([{ client: '2', line: 'Claude', badge: 'Agent', go: false }]);
  });

  it('holds Go to while the board holds a shape the agent last drew, and shows the shapes the board holds', () => {
    const network = new MemoryNetwork();
    const self = peer(network, 1, { name: 'Ada' });
    peer(network, 2, { name: 'Claude', agent: true, status: 'idle', shapes: ['box', 'arrow'] });
    network.flush();
    const list = document.createElement('ul');
    const test = testView('box');

    bindParticipants(list, self, test.view);

    expect(items(list)).toEqual([{ client: '2', line: 'Claude', badge: 'Agent', go: true }]);
    const go = list.querySelector<HTMLButtonElement>('.chalkline-participant-go');
    expect(go?.textContent).toBe('Go to');
    go?.click();
    expect(test.shown).toEqual([['box']]);

    // The board takes the arrow too, and later loses both shapes.
    test.hold('box', 'arrow');
    list.querySelector<HTMLButtonElement>('.chalkline-participant-go')?.click();
    expect(test.shown).toEqual([['box'], ['box', 'arrow']]);

    test.hold();
    expect(items(list)).toEqual([{ client: '2', line: 'Claude', badge: 'Agent', go: false }]);
  });

  it('shows a person without the badge, leaves out a participant without a name, and hides once no one else is in the room', () => {
    const network = new MemoryNetwork();
    const self = peer(network, 1, { name: 'Ada' });
    peer(network, 3, { name: 'Grace' });
    peer(network, 2, {});
    network.flush();
    const list = document.createElement('ul');

    bindParticipants(list, self, testView().view);

    expect(list.hidden).toBe(false);
    expect(items(list)).toEqual([{ client: '3', line: 'Grace', badge: null, go: false }]);

    network.leave('3');
    network.flush();
    expect(items(list)).toEqual([]);
    expect(list.hidden).toBe(true);
  });

  it("keeps its items where a peer's pointer moves and the list shows the same", () => {
    const network = new MemoryNetwork();
    const self = peer(network, 1, { name: 'Ada' });
    const agent = peer(network, 2, { name: 'Claude', agent: true, status: 'idle', pointer: { x: 0, y: 0, tool: 'pointer' } });
    network.flush();
    const list = document.createElement('ul');
    bindParticipants(list, self, testView().view);
    const kept = list.querySelector('li');

    agent.setLocalState({ name: 'Claude', agent: true, status: 'idle', pointer: { x: 40, y: 30, tool: 'pointer' } });
    network.flush();

    expect(kept).not.toBeNull();
    expect(list.querySelector('li')).toBe(kept);
  });

  it('stops following the room and the board once stopped', () => {
    const network = new MemoryNetwork();
    const self = peer(network, 1, { name: 'Ada' });
    const grace = peer(network, 3, { name: 'Grace' });
    network.flush();
    const list = document.createElement('ul');
    const test = testView();
    const stop = bindParticipants(list, self, test.view);

    stop();
    grace.setLocalState({ name: 'Grace Hopper' });
    network.flush();

    expect(test.handlers.size).toBe(0);
    expect(items(list)).toEqual([{ client: '3', line: 'Grace', badge: null, go: false }]);
  });
});
