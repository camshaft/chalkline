// Tests of the board a helper's link opens: the room, the relays and the servers its turn parameter
// carries, which chalkline-mcp and chalkline-mcp listen join the board's room with.
import { roomFragment, type TurnServer } from '@chalkline/sync';
import { describe, expect, it } from 'vitest';
import { joinConfig, joinErrorLine, readBoardLink, routeText, type BoardLink } from './board-link';

const USAGE = 'Usage: chalkline-mcp <board link>';
const ROOM = { room: 'board', key: 'secret' };
const PAGE = 'https://camshaft.github.io/chalkline/';
const TURN: TurnServer = {
  urls: ['turn:turn.cloudflare.com:3478?transport=udp', 'turns:turn.cloudflare.com:5349?transport=tcp'],
  username: 'link-user',
  credential: 'link-pass',
};
const STUN: TurnServer = { urls: ['stun:stun.cloudflare.com:3478'] };

/** The board's link with `text` as its turn parameter. */
const linkWithParam = (text: string) => `${PAGE}${roomFragment(ROOM)}&turn=${text}`;

/** The board's link whose turn parameter holds `value` in JSON, in base64url, as a script that asks a TURN service writes it. */
const linkWith = (value: unknown) => linkWithParam(Buffer.from(JSON.stringify(value)).toString('base64url'));

/** A stand-in for werift's connection class, which the config passes on as it is. */
const PeerConnection = class {} as unknown as typeof RTCPeerConnection;

describe("a helper's board link", () => {
  it('reads the room, and no TURN servers, from a link without a turn parameter', () => {
    expect(readBoardLink(`${PAGE}${roomFragment(ROOM)}`, USAGE)).toEqual({ room: ROOM, relays: [], turnServers: [] });
  });

  it("reads the relay of a local network's link", () => {
    const board = readBoardLink('http://192.168.1.2:8080/?relay=/relay#room=board&key=secret', USAGE);
    expect(board.relays).toEqual(['ws://192.168.1.2:8080/relay']);
  });

  it('reads the servers that a page writes in the turn parameter', () => {
    expect(readBoardLink(`${PAGE}${roomFragment(ROOM, [STUN, TURN])}`, USAGE)).toEqual({
      room: ROOM,
      relays: [],
      turnServers: [STUN, TURN],
    });
  });

  it("reads the iceServers list that a TURN service answers, as Cloudflare's does, with one address or a list in urls", () => {
    const cloudflare = {
      urls: ['stun:stun.cloudflare.com:3478', 'turn:turn.cloudflare.com:3478?transport=udp', 'turns:turn.cloudflare.com:5349?transport=tcp'],
      username: 'u1',
      credential: 'c1',
    };
    const board = readBoardLink(linkWith([cloudflare, { urls: 'turn:turn.example.com:3478', username: 'u2', credential: 'c2' }]), USAGE);
    expect(board.turnServers).toEqual([cloudflare, { urls: ['turn:turn.example.com:3478'], username: 'u2', credential: 'c2' }]);
  });

  it("refuses a link whose turn parameter it can't read, and says why and what to do", () => {
    const refusals: [string, string][] = [
      [linkWithParam('%25%25'), "The link's turn parameter isn't base64url text."],
      [linkWithParam(Buffer.from('not json').toString('base64url')), "The link's turn parameter doesn't hold JSON text in base64url."],
      [linkWith({ urls: 'turn:turn.example.com:3478' }), "The link's turn parameter doesn't hold a list of servers"],
      [
        linkWith([{ urls: ['turn:turn.example.com:3478'] }]),
        "Server 1 of the link's turn parameter has a turn: or turns: address but lacks its username or its credential.",
      ],
      [
        linkWith([STUN, { urls: ['https://turn.example.com'] }]),
        `Server 2 of the link's turn parameter: "https://turn.example.com" doesn't start with turn:, turns:, stun: or stuns:.`,
      ],
    ];
    for (const [link, reason] of refusals) {
      expect(() => readBoardLink(link, USAGE), link).toThrow(reason);
      expect(() => readBoardLink(link, USAGE), link).toThrow('Ask the person who shared the link to copy it again.');
      expect(() => readBoardLink(link, USAGE), link).toThrow(USAGE);
    }
  });

  it("refuses a text that isn't a link, and a link without the room's name and its password, as before", () => {
    expect(() => readBoardLink('not a link', USAGE)).toThrow(`not a link isn't a link.\n\n${USAGE}`);
    expect(() => readBoardLink(PAGE, USAGE)).toThrow(`The link lacks the #room=<name>&key=<password> fragment.\n\n${USAGE}`);
  });
});

describe("the config a helper joins the board's room with", () => {
  const board = (turnServers: TurnServer[]): BoardLink => ({ room: ROOM, relays: [], turnServers });

  it("passes the link's servers on as the room's TURN servers, which Trystero sets as each connection's ICE servers", () => {
    const config = joinConfig(board([STUN, TURN]), PeerConnection);
    expect(config).toEqual({ appId: 'chalkline', password: 'secret', rtcPolyfill: PeerConnection, turnConfig: [STUN, TURN] });
    // The config holds copies, so that a change of its list leaves the board's servers as they are.
    expect(config.turnConfig?.[1]).not.toBe(TURN);
    expect(config.turnConfig?.[1]?.urls).not.toBe(TURN.urls);
  });

  it("doesn't set TURN servers where the link carries none", () => {
    const config = joinConfig(board([]), PeerConnection);
    expect(config).toEqual({ appId: 'chalkline', password: 'secret', rtcPolyfill: PeerConnection });
    expect(config).not.toHaveProperty('turnConfig');
  });

  it('says what it joins through', () => {
    expect(routeText(board([]))).toBe('the public Nostr relays');
    expect(routeText(board([TURN]))).toBe("the public Nostr relays, with the server of the link's turn parameter");
    expect(routeText({ room: ROOM, relays: ['ws://192.168.1.2:8080/relay'], turnServers: [STUN, TURN] })).toBe(
      "ws://192.168.1.2:8080/relay, with the 2 servers of the link's turn parameter",
    );
  });

  it("says that the TURN passwords of the link may have expired where a peer can't connect", () => {
    expect(joinErrorLine(board([]), 'peer', 'timed out')).toBe("peer couldn't connect: timed out");
    expect(joinErrorLine(board([STUN]), 'peer', 'timed out')).toBe("peer couldn't connect: timed out");
    expect(joinErrorLine(board([TURN]), 'peer', 'timed out')).toBe(
      "peer couldn't connect: timed out (the passwords of the TURN servers the link carries may have expired: ask the person who shared the link for a fresh link)",
    );
  });
});
