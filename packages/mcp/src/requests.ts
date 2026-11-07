import { randomBytes } from 'node:crypto';
import {
  convertsMermaid,
  readRequest,
  REQUESTS,
  type Awareness,
  type MermaidRequest,
  type Point,
} from '@chalkline/sync';
import type * as Y from 'yjs';

/** A request's state, as add_mermaid and get_request answer it. */
export type RequestAnswer = {
  id: string;
  status: 'pending' | 'done' | 'failed';
  /** The ids of the shapes a page added for a request that is done. */
  ids?: string[];
  /** Why a page couldn't convert a request that failed. */
  error?: string;
};

/** A refusal of a request's id, whose message says what to give instead. */
export class RequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RequestError';
  }
}

/** Writes a request, with status pending, for a page to convert the Mermaid text `text`, and returns its id. */
export function writeMermaidRequest(doc: Y.Doc, text: string, by: string, at?: Point): string {
  const id = randomBytes(15).toString('base64url');
  const request: MermaidRequest = { kind: 'mermaid', text, by, status: 'pending', error: null };
  if (at !== undefined) request.at = { x: at.x, y: at.y };
  doc.getMap<unknown>(REQUESTS).set(id, request);
  return id;
}

/** Whether `awareness` holds a page: a participant other than this one that converts Mermaid requests. */
export function pageInRoom(awareness: Awareness): boolean {
  for (const [client, state] of awareness.getStates()) {
    if (client !== awareness.clientID && convertsMermaid(state)) return true;
  }
  return false;
}

/** The board's requests that no page has carried out yet, as get_board lists them. */
export function pendingRequests(doc: Y.Doc): { id: string; kind: 'mermaid' }[] {
  const pending: { id: string; kind: 'mermaid' }[] = [];
  for (const [id, value] of doc.getMap<unknown>(REQUESTS)) {
    const request = readRequest(value);
    if (request?.status === 'pending') pending.push({ id, kind: request.kind });
  }
  return pending.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * Answers the request `id` of the board that `doc` holds, on the first of two
 * events: the shared state's change event that sets the request's status to
 * done or failed, answering that status, with the new shapes' ids or the
 * reason; or the awareness change event after which the room doesn't hold a
 * page, answering status pending. It answers at once where the request is done
 * or failed already, or where no page is in the room. It doesn't poll.
 *
 * Rejects with a RequestError where the board doesn't hold the request, and
 * with `signal`'s reason once `signal` aborts, as the agent's client cancels
 * the call, after which it stops listening.
 */
export function waitForRequest(
  doc: Y.Doc,
  awareness: Awareness,
  id: string,
  signal?: AbortSignal,
): Promise<RequestAnswer> {
  const requests = doc.getMap<unknown>(REQUESTS);
  if (readRequest(requests.get(id)) === null) {
    return Promise.reject(
      new RequestError(`The board doesn't hold a Mermaid request with the id "${id}": give an id that add_mermaid answered.`),
    );
  }
  const settled = (): RequestAnswer | null => {
    const request = readRequest(requests.get(id));
    if (request === null) return { id, status: 'failed', error: 'The request was taken off the board before a page converted it.' };
    if (request.status === 'done') return { id, status: 'done', ids: request.ids ?? [] };
    if (request.status === 'failed') {
      return { id, status: 'failed', error: request.error ?? "The page that converted it didn't say why it failed." };
    }
    return pageInRoom(awareness) ? null : { id, status: 'pending' };
  };
  const now = settled();
  if (now !== null) return Promise.resolve(now);

  return new Promise((resolve, reject) => {
    const check = () => {
      const answer = settled();
      if (answer === null) return;
      stop();
      resolve(answer);
    };
    const abort = () => {
      stop();
      reject(signal?.reason);
    };
    const stop = () => {
      requests.unobserve(check);
      awareness.off('change', check);
      signal?.removeEventListener('abort', abort);
    };
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    requests.observe(check);
    awareness.on('change', check);
    signal?.addEventListener('abort', abort, { once: true });
  });
}
