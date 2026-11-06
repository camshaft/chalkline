import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { relaysFromAddress } from '@chalkline/sync/relay';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { RELAY_PATH, startLanServer, type LanServer } from './server';

interface Answer {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

/** Sends one request with `path` as it is written, which fetch would normalize. */
function send(port: number, path: string, method = 'GET'): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const sent = request({ host: '127.0.0.1', port, path, method }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () =>
        resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks).toString('utf8') }),
      );
      response.on('error', reject);
    });
    sent.on('error', reject);
    sent.end();
  });
}

function opened(socket: WebSocket): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    socket.addEventListener('open', () => resolve(socket), { once: true });
    socket.addEventListener('error', () => reject(new Error(`${socket.url} refused the WebSocket connection`)), {
      once: true,
    });
  });
}

interface RelayMessage {
  topic: string;
  payload: unknown;
}

/** Resolves with the first message `socket` receives whose payload is `payload`. */
function received(socket: WebSocket, payload: unknown): Promise<RelayMessage> {
  return new Promise((resolve) => {
    const onMessage = (event: MessageEvent) => {
      const message = JSON.parse(String(event.data)) as RelayMessage;
      if (message.payload !== payload) return;
      socket.removeEventListener('message', onMessage);
      resolve(message);
    };
    socket.addEventListener('message', onMessage);
  });
}

describe('startLanServer', () => {
  const PAGE = '<!doctype html><title>board</title>';
  const SCRIPT = 'console.log("board");';
  const errors: Error[] = [];
  let directory: string;
  let server: LanServer;

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'chalkline-lan-'));
    const root = join(directory, 'page');
    await mkdir(join(root, 'assets'), { recursive: true });
    await writeFile(join(root, 'index.html'), PAGE);
    await writeFile(join(root, 'assets', 'main.js'), SCRIPT);
    await writeFile(join(root, 'assets', 'data.bin'), Buffer.from([0, 1, 2]));
    // A file beside the page's directory, which the server must not send.
    await writeFile(join(directory, 'secret.txt'), 'not for the network');
    server = await startLanServer({ root, port: 0, host: '127.0.0.1', onError: (error) => errors.push(error) });
  });

  afterEach(() => {
    expect(errors).toEqual([]);
  });

  afterAll(async () => {
    await server?.close();
    await rm(directory, { recursive: true, force: true });
  });

  it("sends an address of the page without a relay to the same address with this server's relay", async () => {
    const root = await send(server.port, '/');
    expect(root.status).toBe(302);
    expect(root.headers.location).toBe('/?relay=%2Frelay');
    const index = await send(server.port, '/index.html?lang=en');
    expect(index.status).toBe(302);
    expect(index.headers.location).toBe('/index.html?lang=en&relay=%2Frelay');

    // The page at the address the browser goes to reads the relay of the machine that served it.
    const redirected = new URL(root.headers.location as string, `http://127.0.0.1:${server.port}/`);
    expect(relaysFromAddress(redirected)).toEqual([`ws://127.0.0.1:${server.port}${RELAY_PATH}`]);
  });

  it('serves the page at an address with a relay, and each file with its type', async () => {
    for (const path of ['/?relay=%2Frelay', '/index.html?relay=%2Frelay']) {
      const page = await send(server.port, path);
      expect(page.status, path).toBe(200);
      expect(page.headers['content-type'], path).toBe('text/html; charset=utf-8');
      expect(page.headers['x-content-type-options'], path).toBe('nosniff');
      expect(page.body, path).toBe(PAGE);
    }
    const script = await send(server.port, '/assets/main.js');
    expect(script.status).toBe(200);
    expect(script.headers['content-type']).toBe('text/javascript; charset=utf-8');
    expect(script.body).toBe(SCRIPT);
    const data = await send(server.port, '/assets/data.bin');
    expect(data.headers['content-type']).toBe('application/octet-stream');
    expect(data.headers['content-length']).toBe('3');
  });

  it('answers HEAD with the headers alone', async () => {
    const head = await send(server.port, '/assets/main.js', 'HEAD');
    expect(head.status).toBe(200);
    expect(head.headers['content-length']).toBe(String(Buffer.byteLength(SCRIPT)));
    expect(head.body).toBe('');
  });

  it('answers 404 for a path outside the page, a directory, a missing file and a path it cannot decode', async () => {
    for (const path of ['/..%2Fsecret.txt', '/%2E%2E/secret.txt', '/assets/..%2F..%2Fsecret.txt', '/assets', '/assets/', '/missing.js', '/%E0%A4%A']) {
      expect((await send(server.port, path)).status, path).toBe(404);
    }
  });

  it('refuses a method other than GET and HEAD', async () => {
    const posted = await send(server.port, '/', 'POST');
    expect(posted.status).toBe(405);
    expect(posted.headers.allow).toBe('GET, HEAD');
  });

  it('relays a message to each subscriber of its topic, on the relay path alone', async () => {
    const relay = `ws://127.0.0.1:${server.port}${RELAY_PATH}`;
    const listener = await opened(new WebSocket(relay));
    const publisher = await opened(new WebSocket(relay));
    try {
      const topic = 'chalkline-test';
      listener.send(JSON.stringify({ type: 'subscribe', topic }));
      // The relay sends a message to its sender too, so the listener's own message shows that its subscription holds.
      const subscribed = received(listener, 'listening');
      listener.send(JSON.stringify({ type: 'publish', topic, payload: 'listening' }));
      await subscribed;
      expect(server.relay.getSubscriberCount(topic)).toBe(1);

      const hello = received(listener, 'hello');
      publisher.send(JSON.stringify({ type: 'publish', topic, payload: 'hello' }));
      expect(await hello).toEqual({ topic, payload: 'hello' });
    } finally {
      listener.close();
      publisher.close();
    }
    await expect(opened(new WebSocket(`ws://127.0.0.1:${server.port}/elsewhere`))).rejects.toThrow('refused');
  });
});
