import { describe, expect, it } from 'vitest';
import {
  encodeTurnServers,
  linkTurnServers,
  newRoomSecrets,
  parseRoomFragment,
  roomFragment,
  TURN_PARAM,
  type TurnServer,
} from './room';

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

const SECRETS = { room: 'abc', key: 's3cret' };

/** The list Cloudflare's TURN service answers as `iceServers`: a STUN server, then a TURN server with three addresses. */
const CLOUDFLARE: TurnServer[] = [
  { urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.cloudflare.com:53'] },
  {
    urls: [
      'turn:turn.cloudflare.com:3478?transport=udp',
      'turn:turn.cloudflare.com:3478?transport=tcp',
      'turns:turn.cloudflare.com:5349?transport=tcp',
    ],
    username: 'bc91b63e2b5d759f8eb9f3b58062439e0a0e15893d76317d833265ad08d6631099ce7c7087caabb31ad3e1c386424e3e',
    credential: 'ebd71f1d3edbc2b0edae3cd5a6d82284aeb5c3b8fdaa9b8e3bf9cec683e0d45fe9f5b44e5145db3300f06c250a15b4a0',
  },
];

/** `value` as JSON in base64url without padding, as a script that prints a board's link writes it. */
const base64url = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');

/** The `turn` parameter's text of `fragment`. */
const turnParam = (fragment: string) => new URLSearchParams(fragment.slice(1)).get(TURN_PARAM) ?? '';

describe("a board link's TURN servers", () => {
  it('leave the fragment as it was where the link carries none', () => {
    expect(roomFragment(SECRETS)).toBe('#room=abc&key=s3cret');
    expect(roomFragment(SECRETS, [])).toBe('#room=abc&key=s3cret');
    expect(linkTurnServers('#room=abc&key=s3cret')).toStrictEqual({ turnServers: [] });
    expect(linkTurnServers('')).toStrictEqual({ turnServers: [] });
    expect(linkTurnServers('#room=abc&key=s3cret&turn=')).toStrictEqual({ turnServers: [] });
  });

  it('go in the turn parameter as a JSON list in base64url without padding, beside the room and the password', () => {
    const fragment = roomFragment(SECRETS, CLOUDFLARE);
    expect(fragment.startsWith('#room=abc&key=s3cret&turn=')).toBe(true);
    const text = turnParam(fragment);
    expect(text).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(text).toBe(encodeTurnServers(CLOUDFLARE));
    expect(JSON.parse(Buffer.from(text, 'base64url').toString('utf8'))).toStrictEqual(CLOUDFLARE);
    expect(parseRoomFragment(fragment)).toEqual(SECRETS);
    expect(linkTurnServers(fragment)).toStrictEqual({ turnServers: CLOUDFLARE });
  });

  it('read back a username and a password of any characters, and leave out the fields a server lacks', () => {
    const servers: TurnServer[] = [
      { urls: ['turn:turn.example.com:3478'], username: '\u00e4d\u00e4 \u2713', credential: 'p&s=s#w/o+r?d' },
      { urls: ['stun:stun.example.com'] },
    ];
    const fragment = roomFragment(SECRETS, servers);
    expect(linkTurnServers(fragment)).toStrictEqual({ turnServers: servers });
    expect(JSON.parse(Buffer.from(turnParam(fragment), 'base64url').toString('utf8'))[1]).toStrictEqual({
      urls: ['stun:stun.example.com'],
    });
  });

  it("read the list Cloudflare's TURN service answers, as a script prints it after a board's link", () => {
    expect(linkTurnServers(`#room=abc&key=s3cret&turn=${base64url(CLOUDFLARE)}`)).toStrictEqual({
      turnServers: CLOUDFLARE,
    });
  });

  it('read an address given alone in place of a list, and a username or a password given as null as left out', () => {
    const list = [
      { urls: 'turn:turn.example.com:3478', username: 'alice', credential: 'secret' },
      { urls: 'stun:stun.example.com', username: null, credential: null },
    ];
    expect(linkTurnServers(`#room=abc&key=s3cret&turn=${base64url(list)}`)).toStrictEqual({
      turnServers: [
        { urls: ['turn:turn.example.com:3478'], username: 'alice', credential: 'secret' },
        { urls: ['stun:stun.example.com'] },
      ],
    });
  });

  it('read base64 with padding, and with the + and / that a link holds unescaped', () => {
    // Five of each character put a whole group of three of them in the text, which base64 writes with a + and a /.
    const list = [{ urls: ['turn:turn.example.com:3478'], username: 'alice', credential: '>>>>>?????' }];
    const base64 = Buffer.from(JSON.stringify(list)).toString('base64');
    expect(base64).toMatch(/\+/);
    expect(base64).toMatch(/\//);
    expect(linkTurnServers(`#room=abc&key=s3cret&turn=${base64}`)).toStrictEqual({ turnServers: list });
    expect(linkTurnServers(`#room=abc&key=s3cret&turn=${encodeURIComponent(base64)}`)).toStrictEqual({ turnServers: list });
    // The port makes the JSON 41 bytes long, which base64 writes with one = of padding.
    const padded = Buffer.from(JSON.stringify([{ urls: ['stun:stun.example.com:3478'] }])).toString('base64');
    expect(padded).toMatch(/=$/);
    expect(linkTurnServers(`#room=abc&key=s3cret&turn=${padded}`)).toStrictEqual({
      turnServers: [{ urls: ['stun:stun.example.com:3478'] }],
    });
  });

  it("refuse a turn parameter they can't read, and say why", () => {
    const refused = (turn: string) => {
      const read = linkTurnServers(`#room=abc&key=s3cret&turn=${turn}`);
      if (!('error' in read)) throw new Error(`the link's turn=${turn} was read as ${JSON.stringify(read)}`);
      return read.error;
    };
    expect(refused('@@@')).toBe("The link's turn parameter isn't base64url text.");
    expect(refused('a')).toBe("The link's turn parameter isn't base64url text.");
    expect(refused(Buffer.from('not json').toString('base64url'))).toBe(
      "The link's turn parameter doesn't hold JSON text in base64url.",
    );
    expect(refused(Buffer.from([0xff, 0xfe, 0x5b, 0x5d]).toString('base64url'))).toBe(
      "The link's turn parameter doesn't hold JSON text in base64url.",
    );
    expect(refused(base64url({ urls: ['turn:turn.example.com'] }))).toContain("doesn't hold a list of servers");
    expect(refused(base64url(['turn:turn.example.com']))).toBe(
      'Server 1 of the link\'s turn parameter isn\'t an object, as {"urls", "username", "credential"} is.',
    );
    expect(refused(base64url([{ urls: ['stun:stun.example.com'] }, { urls: [] }]))).toBe(
      "Server 2 of the link's turn parameter has no address in urls.",
    );
    expect(refused(base64url([{ username: 'alice', credential: 'secret' }]))).toBe(
      "Server 1 of the link's turn parameter has no address in urls.",
    );
    expect(refused(base64url([{ urls: [3478] }]))).toBe("Server 1 of the link's turn parameter has an address in urls that isn't text.");
    expect(refused(base64url([{ urls: ['https://turn.example.com'] }]))).toBe(
      'Server 1 of the link\'s turn parameter: "https://turn.example.com" doesn\'t start with turn:, turns:, stun: or stuns:.',
    );
    expect(refused(base64url([{ urls: ['turn:turn.example.com:3478'], username: 7, credential: 'secret' }]))).toBe(
      "Server 1 of the link's turn parameter has a username that isn't text.",
    );
    expect(refused(base64url([{ urls: ['turn:turn.example.com:3478'], username: 'alice', credential: { value: 1 } }]))).toBe(
      "Server 1 of the link's turn parameter has a credential that isn't text.",
    );
    expect(refused(base64url([{ urls: ['stun:stun.example.com', 'turns:turn.example.com:5349'], username: 'alice' }]))).toBe(
      "Server 1 of the link's turn parameter has a turn: or turns: address but lacks its username or its credential.",
    );
  });
});
