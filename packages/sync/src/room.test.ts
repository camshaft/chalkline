import { describe, expect, it } from 'vitest';
import { newRoomSecrets, parseRoomFragment, roomFragment } from './room';

describe('room links', () => {
  it('reads the room and the password from the fragment', () => {
    expect(parseRoomFragment('#room=abc&key=s3cret')).toEqual({ room: 'abc', key: 's3cret' });
  });

  it('returns null where the fragment lacks the room or the password', () => {
    expect(parseRoomFragment('')).toBeNull();
    expect(parseRoomFragment('#room=abc')).toBeNull();
    expect(parseRoomFragment('#key=s3cret')).toBeNull();
  });

  it('writes a fragment that reads back, with characters that need escaping', () => {
    const secrets = { room: 'a b&c', key: 'k=1#2' };
    expect(parseRoomFragment(roomFragment(secrets))).toEqual(secrets);
  });

  it('makes a new random name and password each time', () => {
    const first = newRoomSecrets();
    const second = newRoomSecrets();
    expect(first.room).toMatch(/^[0-9a-f]{16}$/);
    expect(first.key).toMatch(/^[0-9a-f]{32}$/);
    expect(second).not.toEqual(first);
  });
});
