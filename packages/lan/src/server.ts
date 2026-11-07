import { createReadStream, type Stats } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { extname, resolve, sep } from 'node:path';
import { RELAY_PARAM } from '@chalkline/sync/relay';
import { createWsRelayServer, type WsRelayServer } from '@trystero-p2p/ws-relay/server';

/** The path of the WebSocket relay, on the same port as the page. */
export const RELAY_PATH = '/relay';

/** The Content-Type of each kind of file the built page holds; any other file is sent as bytes. */
const CONTENT_TYPES = new Map<string, string>([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.map', 'application/json; charset=utf-8'],
  ['.txt', 'text/plain; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.gif', 'image/gif'],
  ['.webp', 'image/webp'],
  ['.ico', 'image/x-icon'],
  ['.woff', 'font/woff'],
  ['.woff2', 'font/woff2'],
  ['.ttf', 'font/ttf'],
  ['.wasm', 'application/wasm'],
]);

export interface LanServerOptions {
  /** The directory of the built page, which holds its index.html. */
  root: string;
  /** The port to listen on, or 0 for a free port. */
  port: number;
  /** The address to listen on; every address of the machine where it is left out. */
  host?: string;
  /** Called with each error of a request or of the relay, after which the server keeps serving. */
  onError?: (error: Error) => void;
}

export interface LanServer {
  /** The port the server listens on. */
  port: number;
  /** The WebSocket relay at RELAY_PATH. */
  relay: WsRelayServer;
  /** Closes the relay's connections and every other connection, and stops listening. */
  close(): Promise<void>;
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/**
 * The file of the page that `pathname` names, or null where it names a
 * directory, a missing file or a path outside `root`.
 */
async function fileOf(root: string, pathname: string): Promise<{ path: string; stats: Stats } | null> {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes('\0')) return null;
  const path = resolve(root, decoded === '/' ? 'index.html' : `.${decoded}`);
  if (!path.startsWith(root + sep)) return null;
  try {
    const stats = await stat(path);
    return stats.isFile() ? { path, stats } : null;
  } catch {
    return null;
  }
}

async function serve(
  root: string,
  request: IncomingMessage,
  response: ServerResponse,
  report: (error: unknown) => void,
): Promise<void> {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.writeHead(405, { allow: 'GET, HEAD', 'content-type': 'text/plain; charset=utf-8' });
    response.end('Only GET and HEAD are allowed.\n');
    return;
  }
  const url = new URL(request.url ?? '/', 'http://localhost');
  if ((url.pathname === '/' || url.pathname === '/index.html') && !url.searchParams.has(RELAY_PARAM)) {
    // The page finds the other participants through the relay its address names, so an address
    // without one goes to the same address with this server's relay. The browser keeps the
    // fragment, which holds the room's name and password.
    url.searchParams.append(RELAY_PARAM, RELAY_PATH);
    response.writeHead(302, { location: `${url.pathname}${url.search}` });
    response.end();
    return;
  }
  const file = await fileOf(root, url.pathname);
  if (file === null) {
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('Not found.\n');
    return;
  }
  response.writeHead(200, {
    'content-type': CONTENT_TYPES.get(extname(file.path).toLowerCase()) ?? 'application/octet-stream',
    'content-length': file.stats.size,
    'x-content-type-options': 'nosniff',
  });
  if (request.method === 'HEAD') {
    response.end();
    return;
  }
  const stream = createReadStream(file.path);
  stream.on('error', (error) => {
    report(error);
    response.destroy(error);
  });
  stream.pipe(response);
}

/**
 * Serves the built page in `root` over plain HTTP, and Trystero's WebSocket
 * relay at RELAY_PATH on the same port, so that a page this server serves can
 * open a plain WebSocket connection to the relay. Resolves once the server
 * listens.
 */
export async function startLanServer(options: LanServerOptions): Promise<LanServer> {
  const root = resolve(options.root);
  const report = (error: unknown): void => {
    options.onError?.(toError(error));
  };
  const server = createServer((request, response) => {
    serve(root, request, response, report).catch((error: unknown) => {
      report(error);
      if (!response.headersSent) response.writeHead(500);
      response.end();
    });
  });
  await new Promise<void>((listening, failed) => {
    server.once('error', failed);
    server.listen({ port: options.port, host: options.host }, () => {
      server.off('error', failed);
      listening();
    });
  });
  const relay = createWsRelayServer({ server, path: RELAY_PATH, onError: report });
  await relay.ready;
  return {
    port: (server.address() as AddressInfo).port,
    relay,
    close: async () => {
      await relay.close();
      await new Promise<void>((closed, failed) => {
        server.close((error) => (error === undefined ? closed() : failed(error)));
        server.closeAllConnections();
      });
    },
  };
}
