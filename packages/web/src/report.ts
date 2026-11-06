/** One candidate of the pair of addresses a WebRTC connection uses. */
export interface CandidateInfo {
  /**
   * `host` for the machine's own address, `srflx` for its public address
   * behind a NAT as a STUN server saw it, `prflx` for one learned from the
   * peer, and `relay` for a TURN server's.
   */
  type?: string;
  protocol?: string;
  address?: string;
  port?: number;
}

/** How a connection to one peer is made. */
export interface ConnectionReport {
  connectionState?: string;
  local?: CandidateInfo;
  remote?: CandidateInfo;
}

/** One entry of an `RTCStatsReport`. */
export interface RtcStat {
  id: string;
  type: string;
  [field: string]: unknown;
}

/** The part of an `RTCStatsReport` that `reportFromStats` reads. */
export interface StatsLike {
  forEach(callback: (stat: RtcStat) => void): void;
}

/** Reports the candidate pair a peer connection selected, from its stats. */
export async function connectionReport(connection: RTCPeerConnection): Promise<ConnectionReport> {
  return { connectionState: connection.connectionState, ...reportFromStats(await connection.getStats()) };
}

/**
 * Finds the selected candidate pair: Chromium names it in the transport's
 * `selectedCandidatePairId`, Firefox marks the pair `selected`, and otherwise
 * the nominated pair that succeeded is the one in use.
 */
export function reportFromStats(stats: StatsLike): ConnectionReport {
  const all = new Map<string, RtcStat>();
  stats.forEach((stat) => {
    all.set(stat.id, stat);
  });
  const byId = (id: unknown) => (typeof id === 'string' ? all.get(id) : undefined);
  const entries = [...all.values()];

  const pair =
    entries
      .filter((stat) => stat.type === 'transport')
      .map((stat) => byId(stat.selectedCandidatePairId))
      .find((stat) => stat !== undefined) ??
    entries.find((stat) => stat.type === 'candidate-pair' && stat.selected === true) ??
    entries.find((stat) => stat.type === 'candidate-pair' && stat.nominated === true && stat.state === 'succeeded');
  if (pair === undefined) return {};

  return { local: candidate(byId(pair.localCandidateId)), remote: candidate(byId(pair.remoteCandidateId)) };
}

function candidate(stat: RtcStat | undefined): CandidateInfo | undefined {
  if (stat === undefined) return undefined;
  const text = (value: unknown) => (typeof value === 'string' ? value : undefined);
  return {
    type: text(stat.candidateType),
    protocol: text(stat.protocol),
    address: text(stat.address) ?? text(stat.ip),
    port: typeof stat.port === 'number' ? stat.port : undefined,
  };
}
