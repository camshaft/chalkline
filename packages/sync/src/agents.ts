/**
 * The awareness field in which the agent's helper says that an agent is on the board, as `true`, so
 * that each page offers its people Ask an agent only while an agent is there to read and answer an
 * ask. A page doesn't set it.
 */
export const AGENT = 'agent';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Whether an awareness `state` says that its participant is an agent's helper: its `agent` field is true. */
export function isAgent(state: unknown): boolean {
  return isRecord(state) && state[AGENT] === true;
}

/** Whether `states`, the room's awareness states by client id, hold an agent's helper other than the participant `self`. */
export function agentInRoom(states: ReadonlyMap<number, unknown>, self: number): boolean {
  for (const [client, state] of states) {
    if (client !== self && isAgent(state)) return true;
  }
  return false;
}
