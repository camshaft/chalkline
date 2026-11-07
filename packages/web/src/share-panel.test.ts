// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { linkTurnServers, parseRoomFragment, roomFragment, type RoomSecrets, type TurnServer } from './room';
import { boardLink, linkableServers, shareOpener, sharePanel } from './share-panel';

const BOARD: RoomSecrets = { room: 'a1b2c3d4e5f60718', key: '00112233445566778899aabbccddeeff' };
const PAGE = 'https://camshaft.github.io/chalkline/?relay=wss%3A%2F%2Frelay.example';
const ADDRESS = `${PAGE}#room=old&key=old`;
const TURN: TurnServer = {
  urls: ['turn:turn.cloudflare.com:3478?transport=udp', 'turns:turn.cloudflare.com:5349?transport=tcp'],
  username: 'link-user',
  credential: 'link-pass',
};
const STUN: TurnServer = { urls: ['stun:stun.cloudflare.com:3478'] };

// A copy's promise settles after the click's handler returns.
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function button(within: Element, text: string): HTMLButtonElement {
  const found = [...within.querySelectorAll('button')].find((candidate) => candidate.textContent === text);
  if (found === undefined) throw new Error(`there is no ${text} button`);
  return found;
}

const buttonTexts = (within: Element) => [...within.querySelectorAll('button')].map((found) => found.textContent);

function field(panel: Element): HTMLInputElement {
  const found = panel.querySelector<HTMLInputElement>('input[aria-label="Board link"]');
  if (found === null) throw new Error('the panel lacks the link field');
  return found;
}

const statusText = (panel: Element) => panel.querySelector('.share-status')?.textContent;

function open(turnServers: readonly TurnServer[], copy = vi.fn<(text: string) => Promise<void>>(() => Promise.resolve())) {
  const onClose = vi.fn<() => void>();
  const panel = sharePanel(document, { address: ADDRESS, secrets: BOARD, turnServers, copy, onClose });
  document.body.replaceChildren(panel);
  return { panel, copy, onClose };
}

describe("a board's link", () => {
  it("holds the board in its fragment, beside the address of the page, and doesn't hold any TURN servers by default", () => {
    const link = boardLink(ADDRESS, BOARD);
    expect(link.split('#')[0]).toBe(PAGE);
    const { hash } = new URL(link);
    expect(parseRoomFragment(hash)).toEqual(BOARD);
    expect(hash).not.toContain('turn=');
    expect(linkTurnServers(hash)).toEqual({ turnServers: [] });
  });

  it('holds the TURN servers it is given, which the turn parameter reads back', () => {
    const { hash } = new URL(boardLink(ADDRESS, BOARD, [STUN, TURN]));
    expect(parseRoomFragment(hash)).toEqual(BOARD);
    expect(linkTurnServers(hash)).toEqual({ turnServers: [STUN, TURN] });
  });

  it("leaves out the TURN servers of the link the page opened with, where it isn't given them", () => {
    const opened = `${PAGE}${roomFragment(BOARD, [TURN])}`;
    expect(boardLink(opened, BOARD)).toBe(boardLink(ADDRESS, BOARD));
  });

  it('carries only the TURN servers that hold their username and their password', () => {
    const noPassword: TurnServer = { urls: ['turn:turn.example.com:3478'], username: 'alice' };
    const bare: TurnServer = { urls: ['turns:turn.example.com:5349'] };
    expect(linkableServers([STUN, noPassword, TURN, bare])).toEqual([STUN, TURN]);
  });
});

describe('the Share link panel', () => {
  it('copies the link without TURN servers on Copy link, and says so', async () => {
    const { panel, copy } = open([TURN]);
    expect(panel.textContent).toContain('Share this board');
    button(panel, 'Copy link').click();
    await settle();
    expect(copy).toHaveBeenCalledOnce();
    expect(copy).toHaveBeenCalledWith(boardLink(ADDRESS, BOARD));
    expect(statusText(panel)).toBe('Copied the link.');
    expect(field(panel).hidden).toBe(true);
  });

  it('copies the link with the TURN servers the page uses on Copy link with TURN servers, beside a warning', async () => {
    const { panel, copy } = open([STUN, TURN]);
    const warning = panel.querySelector('.share-warning')?.textContent;
    expect(warning).toContain('Anyone who has that link can use those servers');
    expect(warning).toContain('Short-lived passwords');
    button(panel, 'Copy link with TURN servers').click();
    await settle();
    const link = boardLink(ADDRESS, BOARD, [STUN, TURN]);
    expect(copy).toHaveBeenCalledOnce();
    expect(copy).toHaveBeenCalledWith(link);
    expect(linkTurnServers(new URL(link).hash)).toEqual({ turnServers: [STUN, TURN] });
    expect(statusText(panel)).toBe('Copied the link with TURN servers.');
  });

  it("offers the plain link alone where the page doesn't use any TURN servers", () => {
    const { panel } = open([]);
    expect(buttonTexts(panel)).toEqual(['Copy link', 'Close']);
    expect(panel.querySelector('.share-warning')).toBeNull();
    expect(panel.textContent).toContain('add them in Connection settings first');
  });

  it('leaves a TURN server without its password out of the link, and says so', async () => {
    const { panel, copy } = open([{ urls: ['turn:turn.example.com:3478'] }, TURN]);
    expect(panel.textContent).toContain('The link leaves out a TURN server of the Connection settings that lacks a username or a password');
    button(panel, 'Copy link with TURN servers').click();
    await settle();
    expect(copy).toHaveBeenCalledOnce();
    expect(copy).toHaveBeenCalledWith(boardLink(ADDRESS, BOARD, [TURN]));

    const { panel: none } = open([{ urls: ['turn:a.example.com'] }, { urls: ['turn:b.example.com'] }]);
    expect(buttonTexts(none)).toEqual(['Copy link', 'Close']);
    expect(none.textContent).toContain('The link leaves out 2 TURN servers of the Connection settings that lack a username or a password');
  });

  it("shows the link in a field to copy, and selects it, where the browser doesn't let the page copy it", async () => {
    const refused = vi.fn<(text: string) => Promise<void>>(() => Promise.reject(new Error('denied')));
    const { panel } = open([], refused);
    button(panel, 'Copy link').click();
    await settle();
    const shown = field(panel);
    expect(shown.hidden).toBe(false);
    expect(shown.readOnly).toBe(true);
    expect(shown.value).toBe(boardLink(ADDRESS, BOARD));
    expect(document.activeElement).toBe(shown);
    expect(statusText(panel)).toBe("This browser didn't let the page copy the link: copy it from the field above.");
  });

  it('shows the link in the field where the copy throws before it returns, as without a clipboard', async () => {
    const throwing = vi.fn<(text: string) => Promise<void>>(() => {
      throw new TypeError('navigator.clipboard is undefined');
    });
    const { panel } = open([TURN], throwing);
    button(panel, 'Copy link with TURN servers').click();
    await settle();
    expect(field(panel).value).toBe(boardLink(ADDRESS, BOARD, [TURN]));
    expect(statusText(panel)).toBe(
      "This browser didn't let the page copy the link with TURN servers: copy it from the field above.",
    );
  });

  it('closes on Close', () => {
    const { panel, onClose } = open([]);
    button(panel, 'Close').click();
    expect(onClose).toHaveBeenCalledOnce();
  });
});

describe("the main menu's Share link item", () => {
  it('opens the panel each time it is chosen, with what the page shares then, and closes it on Close', () => {
    document.body.innerHTML = '<div id="share" hidden></div>';
    const holder = document.getElementById('share') as HTMLElement;
    let turnServers: TurnServer[] = [];
    const openShare = shareOpener(holder, () => ({ address: ADDRESS, secrets: BOARD, turnServers, copy: () => Promise.resolve() }));

    openShare();
    expect(holder.hidden).toBe(false);
    expect(buttonTexts(holder)).toEqual(['Copy link', 'Close']);
    button(holder, 'Close').click();
    expect(holder.hidden).toBe(true);
    expect(holder.childElementCount).toBe(0);

    turnServers = [TURN];
    openShare();
    expect(holder.hidden).toBe(false);
    expect(holder.querySelectorAll('.share-panel')).toHaveLength(1);
    expect(buttonTexts(holder)).toContain('Copy link with TURN servers');
  });
});
