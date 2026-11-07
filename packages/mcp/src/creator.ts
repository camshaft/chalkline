// The creator mark and the change mark: each shape that chalkline-mcp adds, through its tools or
// through a Mermaid request that a page converts, records the agent in the element's `customData`,
// so that the agent can tell the shapes it added, and change them, from the shapes the people drew.
// Each element that chalkline-mcp adds or changes also records the agent as the author of the
// element's version, so that a person's later change of a shape an agent added, which sets a new
// version on the element, reads as the person's. This module reads and writes both marks, and
// runs in Node and in the browser alike.

/** The member of an element's `customData` that holds Chalkline's fields. */
export const CUSTOM_DATA = 'chalkline';

/** Who added a shape: an agent, by the name its MCP client gave as it connected. */
export interface Creator {
  kind: 'agent';
  name: string;
}

/**
 * The change mark: the agent that wrote a version of an element, and that version, by the
 * element's `version` and `versionNonce`. Each later change of the element, such as a person's,
 * sets a new version and a new nonce on it and keeps its `customData`, so that the mark then
 * records a version the element no longer has.
 */
export interface Change {
  by: Creator;
  version: number;
  versionNonce: number;
}

/**
 * A copy of `element` whose `customData` records `creator` as the shape's creator, and as the
 * author of the element's version where the element holds one. The other members of the element,
 * of its `customData` and of Chalkline's member there stay as they are, and `element` itself
 * doesn't change.
 */
export function withCreator<T extends object>(element: T, creator: Creator): T {
  return withChange(withFields(element, { creator: agentOf(creator) }), creator);
}

/**
 * A copy of `element` whose `customData` records `agent` as the author of the element's version,
 * by its `version` and its `versionNonce`. The other members of the element, of its `customData`
 * and of Chalkline's member there stay as they are, and `element` itself doesn't change. Where
 * `element` doesn't hold a version and a nonce, it answers `element` itself, since a mark without
 * a version would match any later version.
 */
export function withChange<T extends object>(element: T, agent: Creator): T {
  const { version, versionNonce } = element as { version?: unknown; versionNonce?: unknown };
  if (!finite(version) || !finite(versionNonce)) return element;
  const change: Change = { by: agentOf(agent), version, versionNonce };
  return withFields(element, { change });
}

/** The creator that the `customData` of `element` records, or undefined where it doesn't hold a mark of this form. */
export function creatorOf(element: unknown): Creator | undefined {
  return agentIn(fieldsOf(element)?.creator);
}

/**
 * The agent that wrote the version `element` holds: the agent of its change mark, where the
 * mark's version and nonce are the element's. An element that holds a creator mark and no change
 * mark, as chalkline-mcp wrote each shape before it wrote change marks, reads as its creator's.
 * Undefined for any other element, such as one whose last change a person made.
 */
export function changerOf(element: unknown): Creator | undefined {
  const fields = fieldsOf(element);
  const change = recordOf(fields?.change);
  if (change === undefined) return agentIn(fields?.creator);
  const current = recordOf(element);
  const by = agentIn(change.by);
  if (by === undefined || change.version !== current?.version || change.versionNonce !== current?.versionNonce) {
    return undefined;
  }
  return by;
}

/** A copy of `element` whose Chalkline member of `customData` holds `fields` beside its other members. */
function withFields<T extends object>(element: T, fields: Record<string, unknown>): T {
  const customData = recordOf((element as { customData?: unknown }).customData) ?? {};
  const own = recordOf(customData[CUSTOM_DATA]) ?? {};
  return { ...element, customData: { ...customData, [CUSTOM_DATA]: { ...own, ...fields } } };
}

/** Chalkline's member of the `customData` of `element`, where it holds one. */
function fieldsOf(element: unknown): Record<string, unknown> | undefined {
  return recordOf(recordOf(recordOf(element)?.customData)?.[CUSTOM_DATA]);
}

/** A copy of `agent` with its kind and its name alone. */
function agentOf(agent: Creator): Creator {
  return { kind: agent.kind, name: agent.name };
}

/** The agent that `value` records, where it holds one of this form. */
function agentIn(value: unknown): Creator | undefined {
  const agent = recordOf(value);
  if (agent?.kind !== 'agent' || typeof agent.name !== 'string') return undefined;
  return { kind: 'agent', name: agent.name };
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}
