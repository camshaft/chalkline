import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connectDoc, trysteroTransport } from '@chalkline/sync';
import { joinBoardRoom } from '@chalkline/sync/join';
import { RELAY_PARAM, relaysFromAddress } from '@chalkline/sync/relay';
import { pauseRelayReconnection, type Room } from '@trystero-p2p/ws-relay';
import { build } from 'esbuild';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { RELAY_PATH, startLanServer, type LanServer } from './server';

/** The app id both participants join with. */
const APP_ID = 'chalkline';
const LAN = fileURLToPath(new URL('..', import.meta.url));
const PEER = join(LAN, 'dist', 'test', 'peer.mjs');

describe('the local-network mode', () => {
  let directory: string;
  let server: LanServer | undefined;
  let peer: ChildProcess | undefined;
  let room: Room | undefined;
  let output = '';

  beforeAll(async () => {
    // The second participant runs in a process of its own, since Trystero keeps one peer id for each process.
    await build({
      absWorkingDir: LAN,
      entryPoints: ['test/peer.ts'],
      outfile: 'dist/test/peer.mjs',
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node22',
      external: ['werift', '@trystero-p2p/*'],
      // Bundled CommonJS code calls `require`, which an ES module lacks.
      banner: {
        js: "import { createRequire as chalklineCreateRequire } from 'node:module'; const require = chalklineCreateRequire(import.meta.url);",
      },
      logLevel: 'warning',
    });
    directory = await mkdtemp(join(tmpdir(), 'chalkline-lan-mode-'));
    server = await startLanServer({ root: directory, port: 0, host: '127.0.0.1' });
  }, 30_000);

  afterAll(async () => {
    const child = peer;
    if (child !== undefined && child.exitCode === null && child.signalCode === null) {
      const exited = new Promise((resolve) => child.once('exit', resolve));
      child.kill('SIGTERM');
      await exited;
    }
    await room?.leave();
    // The relay closes this process's socket as the server stops: keep Trystero from opening it again.
    pauseRelayReconnection();
    await server?.close();
    await rm(directory, { recursive: true, force: true });
  }, 30_000);

  it('connects two participants through the relay alone, and syncs the board between them', async () => {
    const lan = server;
    if (lan === undefined) throw new Error('the server did not start');
    const link = new URL(`http://127.0.0.1:${lan.port}/`);
    link.searchParams.set(RELAY_PARAM, RELAY_PATH);
    link.hash = `room=lan-${randomUUID()}&key=${randomUUID()}`;
    const relays = relaysFromAddress(link);
    expect(relays).toEqual([`ws://127.0.0.1:${lan.port}/relay`]);

    const child = spawn(process.execPath, [PEER, link.href, APP_ID], { stdio: ['ignore', 'pipe', 'pipe'] });
    peer = child;
    child.stdout?.on('data', (data: Buffer) => {
      output += data.toString();
    });
    child.stderr?.on('data', (data: Buffer) => {
      output += data.toString();
    });
    const peerLeft = new Promise<never>((_, reject) => {
      child.once('exit', (code, signal) => reject(new Error(`the peer left with ${signal ?? code}:\n${output}`)));
    });
    // The peer leaves at the end of every run, after the race below is settled.
    peerLeft.catch(() => undefined);

    const werift = await import('werift');
    const PeerConnection =
      werift.RTCPeerConnection ?? (werift as unknown as { default: typeof werift }).default.RTCPeerConnection;
    const fragment = new URLSearchParams(link.hash.slice(1));
    const joined = joinBoardRoom(
      {
        appId: APP_ID,
        password: fragment.get('key') ?? '',
        rtcPolyfill: PeerConnection as unknown as typeof RTCPeerConnection,
        // Host candidates alone, as on a local network without the internet.
        rtcConfig: { iceServers: [] },
      },
      fragment.get('room') ?? '',
      relays,
      { onJoinError: ({ peerId, error }) => console.warn(`${peerId} couldn't connect: ${error}`) },
    );
    room = joined;
    const doc = new Y.Doc();
    const transport = trysteroTransport(joined);
    connectDoc(doc, transport);
    const probe = doc.getMap<boolean>('probe');
    const marked = new Promise<void>((resolve) => {
      const check = () => {
        if (probe.get('drawn-by-peer') !== true) return;
        probe.unobserve(check);
        resolve();
      };
      probe.observe(check);
      check();
    });

    await Promise.race([marked, peerLeft]);
    expect(transport.peers()).toHaveLength(1);
    expect(lan.relay.getSubscriberCount()).toBeGreaterThan(0);
  }, 60_000);
});
