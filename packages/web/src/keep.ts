import { IndexeddbPersistence } from 'y-indexeddb';
import type * as Y from 'yjs';
import type { RoomSecrets } from './room';

/** The start of the name of each IndexedDB database that keeps a board in a browser. */
export const STORE_PREFIX = 'chalkline-board-';

/**
 * The name of the IndexedDB database that keeps the board of `secrets` in this
 * browser: the prefix, the room's name, and the first 32 hex digits of the
 * SHA-256 of the room's name and password. Two rooms of one name and different
 * passwords are different boards, so each has a database of its own, and the
 * name doesn't hold the password.
 */
export async function storeName(secrets: RoomSecrets): Promise<string> {
  const data = new TextEncoder().encode(JSON.stringify([secrets.room, secrets.key]));
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', data));
  const hex = Array.from(digest.subarray(0, 16), (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${STORE_PREFIX}${encodeURIComponent(secrets.room)}-${hex}`;
}

/** A board that this browser keeps in IndexedDB. */
export interface KeptBoard {
  /** Resolves once the copy that the browser kept is in the document. */
  readonly loaded: Promise<void>;
  /** Stops keeping the document's changes, and closes the database. The kept copy stays. */
  stop(): Promise<void>;
}

/**
 * Keeps `doc` in this browser's IndexedDB database `name`, with y-indexeddb:
 * the copy kept there goes into `doc`, and each later change to `doc`, a
 * peer's as well as this participant's, is kept too. So the board survives a
 * reload, and the shapes drawn while offline stay in the browser until the
 * peers are back, when the sync adapter sends them on.
 */
export function keepBoard(doc: Y.Doc, name: string): KeptBoard {
  const persistence = new IndexeddbPersistence(name, doc);
  return {
    loaded: persistence.whenSynced.then(() => undefined),
    stop: () => persistence.destroy(),
  };
}
