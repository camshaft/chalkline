// The creator mark: each shape that chalkline-mcp adds, through its tools or through a Mermaid
// request that a page converts, records the agent in the element's `customData`, so that the agent
// can tell the shapes it added, and change them, from the shapes the people drew. This module reads
// and writes the mark, and runs in Node and in the browser alike.

/** The member of an element's `customData` that holds Chalkline's fields. */
export const CUSTOM_DATA = 'chalkline';

/** Who added a shape: an agent, by the name its MCP client gave as it connected. */
export interface Creator {
  kind: 'agent';
  name: string;
}

/**
 * A copy of `element` whose `customData` records `creator` as the shape's creator. The other
 * members of the element, of its `customData` and of Chalkline's member there stay as they are,
 * and `element` itself doesn't change.
 */
export function withCreator<T extends object>(element: T, creator: Creator): T {
  const customData = recordOf((element as { customData?: unknown }).customData) ?? {};
  const fields = recordOf(customData[CUSTOM_DATA]) ?? {};
  return {
    ...element,
    customData: { ...customData, [CUSTOM_DATA]: { ...fields, creator: { kind: creator.kind, name: creator.name } } },
  };
}

/** The creator that the `customData` of `element` records, or undefined where it doesn't hold a mark of this form. */
export function creatorOf(element: unknown): Creator | undefined {
  const customData = recordOf(recordOf(element)?.customData);
  const creator = recordOf(recordOf(customData?.[CUSTOM_DATA])?.creator);
  if (creator?.kind !== 'agent' || typeof creator.name !== 'string') return undefined;
  return { kind: 'agent', name: creator.name };
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}
