import { describe, expect, it, vi } from 'vitest';
import { defaultSettings, joinErrorText, linkErrorText, type ConnectionSettings } from './connection';
import { statusLine, watchedPeerConnection, watchForFailure, type ConnectionFailure, type StatusElement } from './status';

/** An `icecandidate` event: one of this browser's candidates, or null at the end of them. */
class CandidateEvent extends Event {
  readonly candidate: { candidate: string } | null;
  constructor(candidate: string | null) {
    super('icecandidate');
    this.candidate = candidate === null ? null : { candidate };
  }
}

/** A peer connection whose states a test moves, each with the event a browser fires for it. */
class FakeConnection extends EventTarget {
  static made: FakeConnection[] = [];
  readonly configuration: RTCConfiguration | undefined;
  iceConnectionState: RTCIceConnectionState = 'new';
  connectionState: RTCPeerConnectionState = 'new';
  iceGatheringState: RTCIceGatheringState = 'new';
  signalingState: RTCSignalingState = 'stable';
  remoteDescription: { readonly type: RTCSdpType } | null = null;

  constructor(configuration?: RTCConfiguration) {
    super();
    this.configuration = configuration;
    FakeConnection.made.push(this);
  }

  /** Takes the peer's offer or answer. */
  receive(type: RTCSdpType): void {
    this.remoteDescription = { type };
    this.dispatchEvent(new Event('signalingstatechange'));
  }

  /** Gathers `candidates`, then ends the gathering, as a browser does, with the state's event and then the end of the candidates. */
  gather(candidates: string[]): void {
    this.iceGatheringState = 'gathering';
    this.dispatchEvent(new Event('icegatheringstatechange'));
    for (const candidate of candidates) this.dispatchEvent(new CandidateEvent(candidate));
    this.iceGatheringState = 'complete';
    this.dispatchEvent(new Event('icegatheringstatechange'));
    this.dispatchEvent(new CandidateEvent(null));
  }

  /** Moves the ICE connection state, then the connection state, each with its event. */
  move(ice: RTCIceConnectionState, connection: RTCPeerConnectionState): void {
    this.iceConnectionState = ice;
    this.dispatchEvent(new Event('iceconnectionstatechange'));
    this.connectionState = connection;
    this.dispatchEvent(new Event('connectionstatechange'));
  }
}

function lastMade(): FakeConnection {
  const made = FakeConnection.made.at(-1);
  if (made === undefined) throw new Error('no connection was made');
  return made;
}

// Trystero calls the class that `watchedPeerConnection` returns as it calls the browser's RTCPeerConnection.
const AsPeerConnection = FakeConnection as unknown as typeof RTCPeerConnection;

const host = 'candidate:1 1 udp 2122260223 192.0.2.10 54321 typ host generation 0';

const withTurn: ConnectionSettings = { turnServers: [{ urls: ['turn:turn.example.com:3478'] }], relays: [] };

/** A page's status line, with the class it passes to Trystero for its connections, as the page wires them. */
function page(settings: ConnectionSettings) {
  const element: StatusElement = { textContent: null };
  const line = statusLine(element, settings);
  const failures: ConnectionFailure[] = [];
  const Watched = watchedPeerConnection(AsPeerConnection, (failure) => {
    failures.push(failure);
    line.showFailure();
  });
  line.showPeers(0);
  const connect = () => {
    new Watched({ iceServers: [] });
    return lastMade();
  };
  return { element, line, failures, connect };
}

const nobodyHere = "No one else is here yet. Share this page's link to invite people.";

describe('the status line', () => {
  it('says how many other people are on the board', () => {
    const element: StatusElement = { textContent: null };
    const line = statusLine(element, defaultSettings());
    line.showPeers(0);
    expect(element.textContent).toBe(nobodyHere);
    line.showPeers(1);
    expect(element.textContent).toBe('1 other person is on this board.');
    line.showPeers(3);
    expect(element.textContent).toBe('3 other people are on this board.');
  });

  it("shows the Connection settings hint where a peer's offer arrives and this browser has no address for it", () => {
    const { element, line, failures, connect } = page(defaultSettings());
    expect(element.textContent).toBe(nobodyHere);
    const peer = connect();
    peer.receive('offer');
    expect(element.textContent).toBe(nobodyHere);
    peer.gather([]);
    expect(element.textContent).toBe(joinErrorText(defaultSettings()));
    expect(element.textContent).toContain('add a TURN server in Connection settings');
    expect(failures).toStrictEqual([
      {
        reason: 'no-local-candidates',
        iceConnectionState: 'new',
        connectionState: 'new',
        iceGatheringState: 'complete',
        signalingState: 'stable',
        localCandidates: 0,
      },
    ]);
    // A peer that joins later replaces the hint with the count.
    line.showPeers(1);
    expect(element.textContent).toBe('1 other person is on this board.');
  });

  it("shows the hint where every pair of addresses fails its checks, and points to the TURN servers in use", () => {
    const { element, failures, connect } = page(withTurn);
    const peer = connect();
    peer.receive('offer');
    peer.gather([host]);
    peer.move('checking', 'connecting');
    expect(element.textContent).toBe(nobodyHere);
    peer.move('failed', 'failed');
    expect(element.textContent).toBe(joinErrorText(withTurn));
    expect(element.textContent).toContain('Check their addresses, usernames and passwords in Connection settings');
    expect(failures).toStrictEqual([
      {
        reason: 'checks-failed',
        iceConnectionState: 'failed',
        connectionState: 'connecting',
        iceGatheringState: 'complete',
        signalingState: 'stable',
        localCandidates: 1,
      },
    ]);
  });

  it("says that the TURN servers of the board's link may have expired, where the page uses them", () => {
    const element: StatusElement = { textContent: null };
    const fromLink = { servers: [{ urls: ['turn:turn.example.com:3478'], username: 'alice', credential: 'secret' }], error: null };
    const line = statusLine(element, defaultSettings(), fromLink);
    line.showPeers(0);
    expect(element.textContent).toBe(nobodyHere);
    line.showFailure();
    expect(element.textContent).toBe(joinErrorText(defaultSettings(), true));
    expect(element.textContent).toContain('may have expired: ask the person who shared the link for a fresh link');
    // The same link on a browser with TURN servers of its own says the same.
    const withOwn = statusLine(element, withTurn, fromLink);
    withOwn.showFailure();
    expect(element.textContent).toBe(joinErrorText(withTurn, true));
  });

  it("points to the browser's own TURN servers where the link carries a STUN server alone", () => {
    const element: StatusElement = { textContent: null };
    const line = statusLine(element, withTurn, { servers: [{ urls: ['stun:stun.example.com'] }], error: null });
    line.showFailure();
    expect(element.textContent).toBe(joinErrorText(withTurn));
  });

  it("says beside the count of people that the page can't read the TURN servers of its link", () => {
    const element: StatusElement = { textContent: null };
    const error = "The link's turn parameter isn't base64url text.";
    const line = statusLine(element, defaultSettings(), { servers: [], error });
    line.showPeers(0);
    expect(element.textContent).toBe(`${nobodyHere} ${linkErrorText(error)}`);
    line.showPeers(2);
    expect(element.textContent).toBe(`2 other people are on this board. ${linkErrorText(error)}`);
    line.showFailure();
    expect(element.textContent).toBe(joinErrorText(defaultSettings()));
  });
});

describe('the watch for a connection that can not open', () => {
  it("makes each connection with the browser's class and the configuration Trystero passes", () => {
    const Watched = watchedPeerConnection(AsPeerConnection, () => {});
    const configuration = { iceServers: [{ urls: 'stun:stun.example.com:3478' }] };
    const made = new Watched(configuration);
    expect(made).toBe(lastMade());
    expect(lastMade().configuration).toBe(configuration);
  });

  it('reports a failure once', () => {
    const peer = new FakeConnection();
    const onFailure = vi.fn<(failure: ConnectionFailure) => void>();
    watchForFailure(peer, onFailure);
    peer.receive('offer');
    peer.gather([]);
    peer.move('failed', 'failed');
    expect(onFailure).toHaveBeenCalledTimes(1);
    expect(onFailure.mock.calls[0]?.[0].reason).toBe('no-local-candidates');
  });

  it("reports an offer of this browser whose answer arrives after it didn't gather an address", () => {
    const peer = new FakeConnection();
    const onFailure = vi.fn<(failure: ConnectionFailure) => void>();
    watchForFailure(peer, onFailure);
    peer.gather([]);
    expect(onFailure).not.toHaveBeenCalled();
    peer.receive('answer');
    expect(onFailure).toHaveBeenCalledTimes(1);
    expect(onFailure.mock.calls[0]?.[0]).toMatchObject({ reason: 'no-local-candidates', localCandidates: 0 });
  });

  it("doesn't count an empty candidate, which ends a transport's candidates", () => {
    const peer = new FakeConnection();
    const onFailure = vi.fn<(failure: ConnectionFailure) => void>();
    watchForFailure(peer, onFailure);
    peer.receive('offer');
    peer.gather(['']);
    expect(onFailure).toHaveBeenCalledTimes(1);
    expect(onFailure.mock.calls[0]?.[0]).toMatchObject({ reason: 'no-local-candidates', localCandidates: 0 });
  });

  it("doesn't report a connection that has a candidate and is still checking", () => {
    const peer = new FakeConnection();
    const onFailure = vi.fn<(failure: ConnectionFailure) => void>();
    watchForFailure(peer, onFailure);
    peer.receive('offer');
    peer.gather([host]);
    peer.move('checking', 'connecting');
    expect(onFailure).not.toHaveBeenCalled();
  });

  it("doesn't report an offer that no peer answers, though it didn't gather an address", () => {
    const peer = new FakeConnection();
    const onFailure = vi.fn<(failure: ConnectionFailure) => void>();
    watchForFailure(peer, onFailure);
    peer.gather([]);
    peer.move('closed', 'closed');
    expect(onFailure).not.toHaveBeenCalled();
  });

  it("doesn't report a connection that opened and fails later, since its peer leaves", () => {
    for (const [ice, connection] of [
      ['connected', 'connecting'],
      ['completed', 'connecting'],
      ['checking', 'connected'],
    ] as const) {
      const peer = new FakeConnection();
      const onFailure = vi.fn<(failure: ConnectionFailure) => void>();
      watchForFailure(peer, onFailure);
      peer.receive('offer');
      peer.gather([host]);
      peer.move(ice, connection);
      peer.move('failed', 'failed');
      expect(onFailure).not.toHaveBeenCalled();
    }
  });
});
