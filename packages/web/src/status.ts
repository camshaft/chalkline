import { joinErrorText, type ConnectionSettings } from './connection';

/** The part of the page's status element that `statusLine` writes. */
export interface StatusElement {
  textContent: string | null;
}

/** The page's status line, under its bar. */
export interface StatusLine {
  /** Says how many other people are on the board. */
  showPeers(count: number): void;
  /** Says that a peer couldn't connect, and what the person can do about it, until the next `showPeers`. */
  showFailure(): void;
}

/** The status line, in `element`, of a page that joined its room with `settings`. */
export function statusLine(element: StatusElement, settings: ConnectionSettings): StatusLine {
  return {
    showPeers: (count) => {
      element.textContent =
        count === 0
          ? "No one else is here yet. Share this page's link to invite people."
          : `${count} other ${count === 1 ? 'person is' : 'people are'} on this board.`;
    },
    showFailure: () => {
      element.textContent = joinErrorText(settings);
    },
  };
}

/**
 * Why a connection to a peer can't open: `checks-failed` where every pair of
 * addresses between the two browsers failed its checks, and
 * `no-local-candidates` where this browser finished gathering without an
 * address to offer the peer, as where its network doesn't allow a direct
 * connection and no TURN server is set.
 */
export type FailureReason = 'checks-failed' | 'no-local-candidates';

/** A connection to a peer that can't open, with the states the page logs. */
export interface ConnectionFailure {
  reason: FailureReason;
  iceConnectionState: RTCIceConnectionState;
  connectionState: RTCPeerConnectionState;
  iceGatheringState: RTCIceGatheringState;
  signalingState: RTCSignalingState;
  /** How many of this browser's own candidates, its addresses for the peer, the connection gathered. */
  localCandidates: number;
}

/** The part of an `RTCPeerConnection` that `watchForFailure` reads. */
export interface WatchedConnection extends EventTarget {
  readonly iceConnectionState: RTCIceConnectionState;
  readonly connectionState: RTCPeerConnectionState;
  readonly iceGatheringState: RTCIceGatheringState;
  readonly signalingState: RTCSignalingState;
  readonly remoteDescription: { readonly type: RTCSdpType } | null;
}

/** The part of an `icecandidate` event that `watchForFailure` reads: the candidate, or null at the end of them. */
interface CandidateEvent extends Event {
  readonly candidate?: { readonly candidate: string } | null;
}

const stateEvents = ['iceconnectionstatechange', 'connectionstatechange', 'icegatheringstatechange', 'signalingstatechange'];

/**
 * Calls `onFailure` once where `connection` can't open: it holds the peer's
 * offer or answer, and either its checks failed, or it finished gathering
 * without a candidate of this browser's, so no pair of addresses can form and
 * its checks never start. A connection that opened and fails later is a peer
 * that leaves, which the room reports itself, and an offer that no peer
 * answers doesn't hold an answer, so neither calls it. It reads the connection's
 * states as each of their change events fires.
 */
export function watchForFailure(connection: WatchedConnection, onFailure: (failure: ConnectionFailure) => void): void {
  let localCandidates = 0;
  const countCandidate = (event: Event) => {
    const { candidate } = event as CandidateEvent;
    // An empty candidate marks the end of a transport's candidates, as some browsers send it.
    if (candidate && candidate.candidate !== '') localCandidates += 1;
  };
  const stop = () => {
    connection.removeEventListener('icecandidate', countCandidate);
    for (const type of stateEvents) connection.removeEventListener(type, check);
  };
  const report = (reason: FailureReason) => {
    stop();
    onFailure({
      reason,
      iceConnectionState: connection.iceConnectionState,
      connectionState: connection.connectionState,
      iceGatheringState: connection.iceGatheringState,
      signalingState: connection.signalingState,
      localCandidates,
    });
  };
  const check = () => {
    const { iceConnectionState, connectionState } = connection;
    if (iceConnectionState === 'connected' || iceConnectionState === 'completed' || connectionState === 'connected') {
      stop();
    } else if (iceConnectionState === 'failed' || connectionState === 'failed') {
      report('checks-failed');
    } else if (connection.remoteDescription !== null && connection.iceGatheringState === 'complete' && localCandidates === 0) {
      report('no-local-candidates');
    }
  };
  connection.addEventListener('icecandidate', countCandidate);
  for (const type of stateEvents) connection.addEventListener(type, check);
}

/**
 * A subclass of `base` whose every connection `watchForFailure` watches. The
 * page passes it to Trystero as `rtcPolyfill`, the class Trystero makes each
 * connection to a peer with, since Trystero's `onJoinError` reports a
 * connection that can't open only once one of its own timers runs out, such
 * as 23 seconds after this browser answered, and not when the connection's
 * state shows it.
 */
export function watchedPeerConnection(
  base: typeof RTCPeerConnection,
  onFailure: (failure: ConnectionFailure) => void,
): typeof RTCPeerConnection {
  return class WatchedPeerConnection extends base {
    constructor(configuration?: RTCConfiguration) {
      super(configuration);
      watchForFailure(this, onFailure);
    }
  };
}
