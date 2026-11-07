import { access } from 'node:fs/promises';
import { isIPv6 } from 'node:net';
import { networkInterfaces, type NetworkInterfaceInfo } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { startLanServer, type LanServer } from './server';

/** The port the command listens on where `--port` is left out. */
export const DEFAULT_PORT = 8080;

/**
 * The page that `npm run build --workspace @chalkline/web` builds, packages/web/dist,
 * from this module in packages/lan/src and from its bundle in packages/lan/dist alike.
 */
export const DEFAULT_ROOT = fileURLToPath(new URL('../../web/dist/', import.meta.url));

export const USAGE = `Usage: chalkline-lan [--port <port>] [--host <address>] [--root <directory>]

Serves the Chalkline page and a WebSocket relay from this machine, so that the
people on its local network share a board through this machine in place of
the public relays. Open one of the addresses it prints, and share the board's
link from the address bar.

Options:
  --port <port>       The port to listen on: ${DEFAULT_PORT} where left out, and 0 for a free port.
  --host <address>    The address to listen on: every address of this machine where left out.
  --root <directory>  The built page to serve: packages/web/dist where left out.
  -h, --help          Shows this message.`;

/** The command's options, as parseOptions reads them. */
export interface LanOptions {
  help: boolean;
  port: number;
  host: string | undefined;
  root: string;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Reads the command's arguments. A value left blank, as `--host ''` is,
 * counts as left out. Throws on an argument the command doesn't take, and on
 * a port that isn't a whole number from 0 to 65535.
 */
export function parseOptions(args: string[]): LanOptions {
  const { values } = parseArgs({
    args,
    options: {
      port: { type: 'string' },
      host: { type: 'string' },
      root: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
    strict: true,
    allowPositionals: false,
  });
  const given = (value: string | undefined) => (value === undefined || value.trim() === '' ? undefined : value.trim());
  const portText = given(values.port);
  let port = DEFAULT_PORT;
  if (portText !== undefined) {
    if (!/^\d+$/.test(portText) || Number(portText) > 65535) {
      throw new Error(`--port takes a port number from 0 to 65535, not ${JSON.stringify(values.port)}.`);
    }
    port = Number(portText);
  }
  return { help: values.help === true, port, host: given(values.host), root: given(values.root) ?? DEFAULT_ROOT };
}

/**
 * The addresses to open the board at: the one address `host` names, or,
 * where the server listens on every address, each IPv4 address of this
 * machine on a network, then localhost for this machine's own browser.
 */
export function boardAddresses(
  port: number,
  host: string | undefined,
  interfaces: NodeJS.Dict<NetworkInterfaceInfo[]> = networkInterfaces(),
): string[] {
  const at = (address: string) => `http://${isIPv6(address) ? `[${address}]` : address}:${port}/`;
  if (host !== undefined && host !== '0.0.0.0' && host !== '::') return [at(host)];
  const addresses: string[] = [];
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal) addresses.push(at(entry.address));
    }
  }
  addresses.push(at('localhost'));
  return addresses;
}

/** Resolves at the first SIGINT or SIGTERM. */
export function signalled(): Promise<void> {
  return new Promise((resolve) => {
    process.once('SIGINT', () => resolve());
    process.once('SIGTERM', () => resolve());
  });
}

/**
 * Runs the command with `args`, serving until `stopped` resolves, and
 * answers its exit code: 0 once it stops, 1 where it can't serve, and 2 for
 * an argument it doesn't take. Each line it prints goes to `log`.
 */
export async function main(
  args: string[],
  stopped: Promise<void>,
  log: (line: string) => void = console.log,
): Promise<number> {
  let options: LanOptions;
  try {
    options = parseOptions(args);
  } catch (error) {
    log(`${message(error)}\n\n${USAGE}`);
    return 2;
  }
  if (options.help) {
    log(USAGE);
    return 0;
  }
  const index = join(options.root, 'index.html');
  try {
    await access(index);
  } catch {
    log(
      `${index} isn't there. Build the page with npm run build --workspace @chalkline/web, or give --root the directory of a built page.`,
    );
    return 1;
  }
  let server: LanServer;
  try {
    server = await startLanServer({
      root: options.root,
      port: options.port,
      host: options.host,
      onError: (error) => log(`chalkline-lan: ${error.message}`),
    });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EADDRINUSE') {
      log(`Port ${options.port} is in use on this machine: pass --port with another port.`);
      return 1;
    }
    if (code === 'EACCES') {
      log(`This user may not listen on port ${options.port}: pass --port with a port above 1023.`);
      return 1;
    }
    throw error;
  }
  log("Serving the board and its relay. Open one of these addresses, and share the board's link from the address bar:");
  for (const address of boardAddresses(server.port, options.host)) log(`  ${address}`);
  log('Press Ctrl-C to stop.');
  await stopped;
  await server.close();
  return 0;
}
