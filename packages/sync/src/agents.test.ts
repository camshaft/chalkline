import { describe, expect, it } from 'vitest';
import { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';
import { AGENT, agentInRoom, isAgent } from './agents';
import { connectAwareness } from './awareness';
import { MemoryNetwork } from './memory-transport';

describe('isAgent', () => {
  it('reads a state whose agent field is true as an agent, and every other state as not one', () => {
    expect(isAgent({ [AGENT]: true })).toBe(true);
    for (const state of [{ name: 'Ada' }, { [AGENT]: 'yes' }, { [AGENT]: false }, null, undefined, 'agent', [true]]) {
      expect(isAgent(state), JSON.stringify(state)).toBe(false);
    }
  });
});

describe('agentInRoom', () => {
  it("answers whether another participant's state is an agent's, and leaves this participant's own state out", () => {
    const people = new Map<number, unknown>([
      [1, { name: 'Ada' }],
      [2, { name: 'Grace', converts: ['mermaid'] }],
    ]);
    expect(agentInRoom(people, 1)).toBe(false);
    expect(agentInRoom(new Map([...people, [3, { [AGENT]: true }]]), 1)).toBe(true);
    expect(agentInRoom(new Map([[1, { [AGENT]: true }]]), 1)).toBe(false);
  });

  it("reads a peer's agent state as it reaches a page, and reads none once the agent's state goes", () => {
    const network = new MemoryNetwork();
    const page = new Awareness(new Y.Doc());
    page.setLocalState({ name: 'Ada' });
    const helper = new Awareness(new Y.Doc());
    helper.setLocalState({ [AGENT]: true });
    connectAwareness(page, network.join('page'));
    connectAwareness(helper, network.join('helper'));
    network.flush();
    expect(agentInRoom(page.getStates(), page.clientID)).toBe(true);

    helper.setLocalState(null);
    network.flush();
    expect(agentInRoom(page.getStates(), page.clientID)).toBe(false);
    page.destroy();
    helper.destroy();
  });
});
