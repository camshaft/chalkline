import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { get } from 'node:http';
import { createServer, type AddressInfo } from 'node:net';
import { tmpdir, type NetworkInterfaceInfo } from 'node:os';
import { join, sep } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { boardAddresses, DEFAULT_PORT, DEFAULT_ROOT, main, parseOptions, USAGE } from './cli';

/** A promise that never resolves, for a run that the test doesn't stop. */
const never = new Promise<void>(() => {});

function statusOf(address: string): Promise<{ status: number; location: string | undefined }> {
  return new Promise((resolve, reject) => {
    get(address, (response) => {
      response.resume();
      resolve({ status: response.statusCode ?? 0, location: response.headers.location });
    }).on('error', reject);
  });
}

const INTERFACES: NodeJS.Dict<NetworkInterfaceInfo[]> = {
  lo: [
    { address: '127.0.0.1', netmask: '255.0.0.0', family: 'IPv4', mac: '00:00:00:00:00:00', internal: true, cidr: '127.0.0.1/8' },
  ],
  eth0: [
    {
      address: '192.168.1.5',
      netmask: '255.255.255.0',
      family: 'IPv4',
      mac: '02:00:00:00:00:01',
      internal: false,
      cidr: '192.168.1.5/24',
    },
    {
      address: 'fe80::1',
      netmask: 'ffff:ffff:ffff:ffff::',
      family: 'IPv6',
      mac: '02:00:00:00:00:01',
      internal: false,
      cidr: 'fe80::1/64',
      scopeid: 2,
    },
  ],
  wlan0: [
    { address: '10.0.0.7', netmask: '255.255.255.0', family: 'IPv4', mac: '02:00:00:00:00:02', internal: false, cidr: '10.0.0.7/24' },
  ],
};

describe('parseOptions', () => {
  it('listens on port 8080 on every address and serves the built page where nothing is given', () => {
    expect(DEFAULT_PORT).toBe(8080);
    expect(DEFAULT_ROOT.endsWith(join('packages', 'web', 'dist') + sep)).toBe(true);
    expect(parseOptions([])).toEqual({ help: false, port: 8080, host: undefined, root: DEFAULT_ROOT });
  });

  it('counts a blank value as left out', () => {
    expect(parseOptions(['--port', ' ', '--host', '', '--root', ' '])).toEqual(parseOptions([]));
  });

  it('reads each option it is given', () => {
    expect(parseOptions(['--port', '0', '--host', '127.0.0.1', '--root', '/srv/board', '--help'])).toEqual({
      help: true,
      port: 0,
      host: '127.0.0.1',
      root: '/srv/board',
    });
    expect(parseOptions(['--port=65535', '-h'])).toEqual({ help: true, port: 65535, host: undefined, root: DEFAULT_ROOT });
  });

  it('refuses a port that is not a whole number from 0 to 65535, and an argument it does not take', () => {
    for (const port of ['65536', '-1', '80a', '8.5', '0x50']) {
      expect(() => parseOptions([`--port=${port}`]), port).toThrow('--port takes a port number from 0 to 65535');
    }
    expect(() => parseOptions(['--verbose'])).toThrow();
    expect(() => parseOptions(['board'])).toThrow();
  });
});

describe('boardAddresses', () => {
  it('lists each IPv4 address on a network, then localhost, where the server listens on every address', () => {
    const every = ['http://192.168.1.5:8080/', 'http://10.0.0.7:8080/', 'http://localhost:8080/'];
    expect(boardAddresses(8080, undefined, INTERFACES)).toEqual(every);
    expect(boardAddresses(8080, '0.0.0.0', INTERFACES)).toEqual(every);
    expect(boardAddresses(8080, '::', INTERFACES)).toEqual(every);
    expect(boardAddresses(8080, undefined, {})).toEqual(['http://localhost:8080/']);
  });

  it('lists the one address the server listens on, in brackets for an IPv6 address', () => {
    expect(boardAddresses(9000, '192.168.1.5', INTERFACES)).toEqual(['http://192.168.1.5:9000/']);
    expect(boardAddresses(9000, 'fe80::1', INTERFACES)).toEqual(['http://[fe80::1]:9000/']);
    expect(boardAddresses(9000, 'board.local', INTERFACES)).toEqual(['http://board.local:9000/']);
  });
});

describe('main', () => {
  let directory: string;
  let root: string;

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'chalkline-lan-cli-'));
    root = join(directory, 'page');
    await mkdir(root);
    await writeFile(join(root, 'index.html'), '<!doctype html><title>board</title>');
  });

  afterAll(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('prints its usage for --help, and serves nothing', async () => {
    const lines: string[] = [];
    expect(await main(['--help'], never, (line) => lines.push(line))).toBe(0);
    expect(lines).toEqual([USAGE]);
  });

  it('prints why and its usage for an argument it does not take', async () => {
    const lines: string[] = [];
    expect(await main(['--port', 'eighty'], never, (line) => lines.push(line))).toBe(2);
    expect(lines).toEqual([`--port takes a port number from 0 to 65535, not "eighty".\n\n${USAGE}`]);
  });

  it('says how to build the page where the directory it serves holds none', async () => {
    const lines: string[] = [];
    expect(await main(['--root', directory, '--port', '0'], never, (line) => lines.push(line))).toBe(1);
    expect(lines).toEqual([
      `${join(directory, 'index.html')} isn't there. Build the page with npm run build --workspace @chalkline/web, or give --root the directory of a built page.`,
    ]);
  });

  it('says so where its port is in use', async () => {
    const taken = createServer();
    await new Promise<void>((resolve) => taken.listen(0, '127.0.0.1', () => resolve()));
    const { port } = taken.address() as AddressInfo;
    try {
      const lines: string[] = [];
      const args = ['--root', root, '--host', '127.0.0.1', '--port', String(port)];
      expect(await main(args, never, (line) => lines.push(line))).toBe(1);
      expect(lines).toEqual([`Port ${port} is in use on this machine: pass --port with another port.`]);
    } finally {
      await new Promise<void>((resolve) => taken.close(() => resolve()));
    }
  });

  it('serves the page until it is stopped, and then refuses connections', async () => {
    let stop!: () => void;
    const stopped = new Promise<void>((resolve) => {
      stop = resolve;
    });
    let printed!: (address: string) => void;
    const address = new Promise<string>((resolve) => {
      printed = resolve;
    });
    const lines: string[] = [];
    const running = main(['--root', root, '--host', '127.0.0.1', '--port', '0'], stopped, (line) => {
      lines.push(line);
      if (line.startsWith('  http://')) printed(line.trim());
    });

    const at = await address;
    expect(at).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
    expect(await statusOf(at)).toEqual({ status: 302, location: '/?relay=%2Frelay' });
    expect(lines.at(-1)).toBe('Press Ctrl-C to stop.');

    stop();
    expect(await running).toBe(0);
    await expect(statusOf(at)).rejects.toThrow();
  });
});
