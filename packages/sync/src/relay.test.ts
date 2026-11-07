import { describe, expect, it } from 'vitest';
import { RELAY_PARAM, relaysFromAddress } from './relay';

describe('relaysFromAddress', () => {
  it('returns an empty list for an address without a relay', () => {
    expect(relaysFromAddress('https://camshaft.github.io/chalkline/#room=r&key=k')).toEqual([]);
  });

  it('resolves a relay against the address, with the WebSocket scheme of its page', () => {
    expect(relaysFromAddress('http://192.168.1.5:8080/?relay=%2Frelay#room=r&key=k')).toEqual([
      'ws://192.168.1.5:8080/relay',
    ]);
    expect(relaysFromAddress(new URL('https://board.example/chalkline/?relay=relay'))).toEqual([
      'wss://board.example/chalkline/relay',
    ]);
  });

  it('keeps a WebSocket relay, maps an http or https relay to ws or wss, and keeps their order', () => {
    const address = new URL('https://camshaft.github.io/chalkline/');
    for (const relay of ['ws://10.0.0.2:8080/relay', 'wss://relay.example/', 'http://10.0.0.3/relay', 'https://relay.example/a?b=c']) {
      address.searchParams.append(RELAY_PARAM, relay);
    }
    expect(relaysFromAddress(address)).toEqual([
      'ws://10.0.0.2:8080/relay',
      'wss://relay.example/',
      'ws://10.0.0.3/relay',
      'wss://relay.example/a?b=c',
    ]);
  });

  it("leaves out a blank relay, and the fragment of a relay, which a WebSocket address can't hold", () => {
    expect(relaysFromAddress('http://10.0.0.2:8080/?relay=&relay=%20&relay=ws%3A%2F%2F10.0.0.2%3A8080%2Frelay%23x')).toEqual([
      'ws://10.0.0.2:8080/relay',
    ]);
  });

  it("refuses a relay that isn't a WebSocket, http or https address", () => {
    expect(() => relaysFromAddress('http://10.0.0.2/?relay=ftp%3A%2F%2F10.0.0.2%2F')).toThrow("isn't a WebSocket address");
    expect(() => relaysFromAddress('http://10.0.0.2/?relay=javascript%3Aalert(1)')).toThrow("isn't a WebSocket address");
    expect(() => relaysFromAddress('http://10.0.0.2/?relay=http%3A%2F%2F')).toThrow("isn't a WebSocket address");
  });
});
