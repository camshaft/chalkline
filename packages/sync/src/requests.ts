/** The shared map that holds, by id, each request that the agent's helper writes for a page to carry out. */
export const REQUESTS = 'requests';

/** Where a request stands: waiting for a page to carry it out, carried out, or failed. */
export type RequestStatus = 'pending' | 'done' | 'failed';

/** A place on the board, in the board's coordinates. */
export interface Point {
  x: number;
  y: number;
}

/**
 * A request for a page to convert the Mermaid text of a whole diagram into
 * shapes on the board. The conversion needs a browser, so the agent's helper
 * writes the request with status pending, and a page that converts it sets its
 * status to done, with the ids of the shapes it added, or to failed, with the
 * reason, in the same transaction as the shapes.
 */
export interface MermaidRequest {
  kind: 'mermaid';
  /** The Mermaid text of the whole diagram. */
  text: string;
  /** Who wrote the request, such as the name of the agent's client. */
  by: string;
  status: RequestStatus;
  /** Why the conversion failed, where it failed, and null otherwise. */
  error: string | null;
  /** Where the diagram's top left corner goes. Where it is left out, the page puts the diagram below the board's shapes. */
  at?: Point;
  /** The ids of the shapes the page added, once the request is done. A shape's label isn't listed apart from its shape. */
  ids?: string[];
}

const STATUSES: ReadonlySet<unknown> = new Set<RequestStatus>(['pending', 'done', 'failed']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Reads a request from the shared map, whose values arrive from the network: a
 * value that isn't a Mermaid request with a known status reads as null, an
 * `error` that isn't text reads as null, and an `at` or `ids` of the wrong type
 * is left out.
 */
export function readRequest(value: unknown): MermaidRequest | null {
  if (!isRecord(value)) return null;
  const { kind, text, by, status, error, at, ids } = value;
  if (kind !== 'mermaid' || typeof text !== 'string' || typeof by !== 'string' || !STATUSES.has(status)) return null;
  const request: MermaidRequest = {
    kind,
    text,
    by,
    status: status as RequestStatus,
    error: typeof error === 'string' ? error : null,
  };
  if (isRecord(at) && finite(at.x) && finite(at.y)) request.at = { x: at.x, y: at.y };
  if (Array.isArray(ids) && ids.every((id) => typeof id === 'string')) request.ids = [...ids];
  return request;
}

/** The awareness field in which a participant lists the kinds of request it carries out, as a page lists `mermaid`. */
export const CONVERTS = 'converts';

/** Whether an awareness `state` says that its participant converts Mermaid requests. */
export function convertsMermaid(state: unknown): boolean {
  if (!isRecord(state)) return false;
  const converts = state[CONVERTS];
  return Array.isArray(converts) && converts.includes('mermaid');
}

/** The awareness client ids of the participants that convert Mermaid requests, lowest first. */
export function mermaidConverters(states: ReadonlyMap<number, unknown>): number[] {
  return [...states]
    .filter(([, state]) => convertsMermaid(state))
    .map(([client]) => client)
    .sort((a, b) => a - b);
}
