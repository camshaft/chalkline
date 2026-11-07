// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import {
  defaultSettings,
  relayUrlError,
  SETTINGS_KEY,
  turnUrlError,
  type ConnectionSettings,
  type SettingsStorage,
} from './connection';
import { connectSettingsButton, settingsOpener, settingsPanel } from './settings-panel';

class MemoryStorage implements SettingsStorage {
  readonly items = new Map<string, string>();
  getItem(key: string): string | null {
    return this.items.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.items.set(key, value);
  }
  removeItem(key: string): void {
    this.items.delete(key);
  }
}

function open(settings: ConnectionSettings = defaultSettings(), onSave = vi.fn<(saved: ConnectionSettings) => void>()) {
  const onClose = vi.fn<() => void>();
  const panel = settingsPanel(document, { settings, onSave, onClose });
  document.body.replaceChildren(panel);
  return { panel, onSave, onClose };
}

function button(within: Element, text: string): HTMLButtonElement {
  const found = [...within.querySelectorAll('button')].find((candidate) => candidate.textContent === text);
  if (found === undefined) throw new Error(`there is no ${text} button`);
  return found;
}

function rows(panel: Element): HTMLElement[] {
  return [...panel.querySelectorAll<HTMLElement>('.turn-row')];
}

function input(row: Element, name: string): HTMLInputElement {
  const found = row.querySelector<HTMLInputElement>(`input[name="${name}"]`);
  if (found === null) throw new Error(`the row lacks the ${name} field`);
  return found;
}

function relays(panel: Element): HTMLTextAreaElement {
  const found = panel.querySelector<HTMLTextAreaElement>('textarea[name="relays"]');
  if (found === null) throw new Error('the panel lacks the relays field');
  return found;
}

function errors(panel: Element): HTMLElement {
  const found = panel.querySelector<HTMLElement>('.settings-errors');
  if (found === null) throw new Error('the panel lacks its error list');
  return found;
}

const errorTexts = (panel: Element) => [...errors(panel).querySelectorAll('li')].map((item) => item.textContent);

describe('the connection settings panel', () => {
  it('opens without a TURN server or a relay where none is saved', () => {
    const { panel } = open();
    expect(rows(panel)).toEqual([]);
    expect(relays(panel).value).toBe('');
    expect(errors(panel).hidden).toBe(true);
  });

  it('shows the saved TURN servers and relays, with each password hidden', () => {
    const { panel } = open({
      turnServers: [{ urls: ['turn:turn.example.com:3478', 'turns:turn.example.com:5349'], username: 'alice', credential: 'secret' }],
      relays: ['wss://relay.one.example', 'wss://relay.two.example'],
    });
    const [row, ...others] = rows(panel);
    expect(others).toEqual([]);
    expect(input(row, 'urls').value).toBe('turn:turn.example.com:3478 turns:turn.example.com:5349');
    expect(input(row, 'username').value).toBe('alice');
    expect(input(row, 'credential').value).toBe('secret');
    expect(input(row, 'credential').type).toBe('password');
    expect(relays(panel).value).toBe('wss://relay.one.example\nwss://relay.two.example');
  });

  it('saves a TURN server and a relay that a person adds', () => {
    const { panel, onSave } = open();
    button(panel, 'Add a TURN server').click();
    const [row] = rows(panel);
    input(row, 'urls').value = 'turn:turn.example.com:3478';
    input(row, 'username').value = 'alice';
    input(row, 'credential').value = 'secret';
    relays(panel).value = 'wss://relay.one.example';
    button(panel, 'Save and reload').click();
    expect(onSave).toHaveBeenCalledOnce();
    expect(onSave).toHaveBeenCalledWith({
      turnServers: [{ urls: ['turn:turn.example.com:3478'], username: 'alice', credential: 'secret' }],
      relays: ['wss://relay.one.example'],
    });
    expect(errors(panel).hidden).toBe(true);
  });

  it('removes the TURN server whose Remove button a person clicks', () => {
    const { panel, onSave } = open({
      turnServers: [{ urls: ['turn:first.example.com:3478'] }, { urls: ['turn:second.example.com:3478'] }],
      relays: [],
    });
    button(rows(panel)[0], 'Remove').click();
    expect(rows(panel).map((row) => input(row, 'urls').value)).toEqual(['turn:second.example.com:3478']);
    button(panel, 'Save and reload').click();
    expect(onSave).toHaveBeenCalledWith({ turnServers: [{ urls: ['turn:second.example.com:3478'] }], relays: [] });
  });

  it('lists each error and saves nothing', () => {
    const { panel, onSave } = open();
    button(panel, 'Add a TURN server').click();
    input(rows(panel)[0], 'urls').value = 'stun:stun.example.com';
    relays(panel).value = 'https://relay.example.com';
    button(panel, 'Save and reload').click();
    expect(onSave).not.toHaveBeenCalled();
    expect(errors(panel).hidden).toBe(false);
    expect(errorTexts(panel)).toEqual([
      `TURN server 1: ${turnUrlError('stun:stun.example.com')}`,
      `Relay: ${relayUrlError('https://relay.example.com')}`,
    ]);
  });

  it("says so where the browser doesn't keep the settings", () => {
    const refused = vi.fn<(saved: ConnectionSettings) => void>(() => {
      throw new Error('the storage is full');
    });
    const { panel } = open(defaultSettings(), refused);
    relays(panel).value = 'wss://relay.one.example';
    button(panel, 'Save and reload').click();
    expect(refused).toHaveBeenCalledOnce();
    expect(errorTexts(panel)).toEqual(["This browser didn't keep the settings: the storage is full"]);
  });

  it('closes on Cancel without saving', () => {
    const { panel, onSave, onClose } = open();
    button(panel, 'Cancel').click();
    expect(onClose).toHaveBeenCalledOnce();
    expect(onSave).not.toHaveBeenCalled();
  });
});

describe('the Connection settings button', () => {
  function page(storage: SettingsStorage | null, settings: ConnectionSettings = defaultSettings()) {
    document.body.innerHTML = '<button id="settings-button">Connection settings</button><div id="settings" hidden></div>';
    const opener = document.getElementById('settings-button') as HTMLElement;
    const holder = document.getElementById('settings') as HTMLElement;
    const reload = vi.fn<() => void>();
    connectSettingsButton(opener, holder, { settings, storage, reload });
    return { opener, holder, reload };
  }

  it('opens the panel, and closes it on Cancel', () => {
    const { opener, holder } = page(new MemoryStorage());
    expect(holder.hidden).toBe(true);
    opener.click();
    expect(holder.hidden).toBe(false);
    expect(holder.querySelector('.settings-panel')).not.toBeNull();
    button(holder, 'Cancel').click();
    expect(holder.hidden).toBe(true);
    expect(holder.childElementCount).toBe(0);
  });

  it('keeps the saved settings in the browser and reloads the board', () => {
    const storage = new MemoryStorage();
    const { opener, holder, reload } = page(storage);
    opener.click();
    relays(holder).value = 'wss://relay.one.example';
    button(holder, 'Save and reload').click();
    expect(JSON.parse(storage.getItem(SETTINGS_KEY) ?? 'null')).toStrictEqual({
      turnServers: [],
      relays: ['wss://relay.one.example'],
    });
    expect(reload).toHaveBeenCalledOnce();
  });

  it("says so where the browser's storage isn't available, and doesn't reload", () => {
    const { opener, holder, reload } = page(null);
    opener.click();
    relays(holder).value = 'wss://relay.one.example';
    button(holder, 'Save and reload').click();
    expect(reload).not.toHaveBeenCalled();
    expect(errorTexts(holder)).toEqual(["This browser didn't keep the settings: it doesn't let this page keep anything"]);
  });

  it('opens with the settings the page joined with', () => {
    const { opener, holder } = page(new MemoryStorage(), { turnServers: [{ urls: ['turn:turn.example.com:3478'] }], relays: [] });
    opener.click();
    expect(rows(holder).map((row) => input(row, 'urls').value)).toEqual(['turn:turn.example.com:3478']);
  });
});

describe("the main menu's Connection settings item", () => {
  it('opens the panel each time it is chosen, with the settings the page joined with, and closes it on Cancel', () => {
    document.body.innerHTML = '<div id="settings" hidden></div>';
    const holder = document.getElementById('settings') as HTMLElement;
    const open = settingsOpener(holder, {
      settings: { turnServers: [], relays: ['wss://relay.one.example'] },
      storage: new MemoryStorage(),
      reload: vi.fn<() => void>(),
    });

    open();
    expect(holder.hidden).toBe(false);
    expect(relays(holder).value).toBe('wss://relay.one.example');
    button(holder, 'Cancel').click();
    expect(holder.hidden).toBe(true);
    expect(holder.childElementCount).toBe(0);

    open();
    expect(holder.hidden).toBe(false);
    expect(holder.querySelectorAll('.settings-panel')).toHaveLength(1);
  });
});
