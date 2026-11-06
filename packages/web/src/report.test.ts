import { describe, expect, it } from 'vitest';
import { reportFromStats, type RtcStat } from './report';

const stats = (...entries: RtcStat[]) => new Map(entries.map((entry) => [entry.id, entry]));

const local: RtcStat = {
  id: 'L1',
  type: 'local-candidate',
  candidateType: 'srflx',
  protocol: 'udp',
  address: '203.0.113.7',
  port: 50000,
};
const remote: RtcStat = {
  id: 'R1',
  type: 'remote-candidate',
  candidateType: 'prflx',
  protocol: 'udp',
  ip: '198.51.100.9',
  port: 60000,
};
const expected = {
  local: { type: 'srflx', protocol: 'udp', address: '203.0.113.7', port: 50000 },
  remote: { type: 'prflx', protocol: 'udp', address: '198.51.100.9', port: 60000 },
};

describe('reportFromStats', () => {
  it("reads the pair the transport selected, as Chromium reports it", () => {
    const report = reportFromStats(
      stats(
        { id: 'T1', type: 'transport', selectedCandidatePairId: 'P2' },
        { id: 'P1', type: 'candidate-pair', localCandidateId: 'L0', remoteCandidateId: 'R0', nominated: true, state: 'succeeded' },
        { id: 'P2', type: 'candidate-pair', localCandidateId: 'L1', remoteCandidateId: 'R1' },
        local,
        remote,
      ),
    );

    expect(report).toEqual(expected);
  });

  it('reads the pair marked selected, as Firefox reports it', () => {
    const report = reportFromStats(
      stats({ id: 'P1', type: 'candidate-pair', localCandidateId: 'L1', remoteCandidateId: 'R1', selected: true }, local, remote),
    );

    expect(report).toEqual(expected);
  });

  it('falls back to the nominated pair that succeeded', () => {
    const report = reportFromStats(
      stats(
        { id: 'P0', type: 'candidate-pair', localCandidateId: 'L0', remoteCandidateId: 'R0', nominated: true, state: 'failed' },
        { id: 'P1', type: 'candidate-pair', localCandidateId: 'L1', remoteCandidateId: 'R1', nominated: true, state: 'succeeded' },
        local,
        remote,
      ),
    );

    expect(report).toEqual(expected);
  });

  it('reports nothing where no pair is in use', () => {
    expect(reportFromStats(stats(local, remote))).toEqual({});
  });
});
