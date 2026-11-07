/** The Trystero app id that every Chalkline page and script joins rooms under. */
export const APP_ID = 'chalkline';

/** A room's name and password, which travel in the link's fragment. */
export interface RoomSecrets {
  room: string;
  key: string;
}

/**
 * Reads `#room=<name>&key=<password>` from a link's fragment, or returns null
 * where either part is missing. A browser doesn't send the fragment to the
 * static host, so the host never sees either part.
 */
export function parseRoomFragment(hash: string): RoomSecrets | null {
  const params = new URLSearchParams(hash.startsWith('#') ? hash.slice(1) : hash);
  const room = params.get('room');
  const key = params.get('key');
  return room && key ? { room, key } : null;
}

/** The fragment that `parseRoomFragment` reads back. */
export function roomFragment(secrets: RoomSecrets): string {
  return `#${new URLSearchParams({ room: secrets.room, key: secrets.key }).toString()}`;
}

/** A new room: a random name of 16 hex digits and a random password of 32. */
export function newRoomSecrets(): RoomSecrets {
  return { room: randomHex(8), key: randomHex(16) };
}

function randomHex(bytes: number): string {
  const data = crypto.getRandomValues(new Uint8Array(bytes));
  return Array.from(data, (byte) => byte.toString(16).padStart(2, '0')).join('');
}
