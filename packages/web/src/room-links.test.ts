// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseRoomFragment, roomFragment, type RoomSecrets } from './room';
import {
  boardInAddress,
  chooseRoom,
  newBoardFragment,
  joinScreen,
  reloadOnRoomChange,
  secretsFromLink,
  windowAddress,
  type PageAddress,
} from './room-links';

const PAGE = 'https://camshaft.github.io/chalkline/';
const BOARD: RoomSecrets = { room: 'abc', key: 's3cret' };
const BOARD_FRAGMENT = '#room=abc&key=s3cret';

/** An address whose fragment a test changes, as a person does in the address bar. */
class TestAddress implements PageAddress {
  readonly handlers = new Set<() => void>();
  readonly replaced: string[] = [];
  current: string;
  constructor(current: string) {
    this.current = current;
  }
  href(): string {
    return this.current;
  }
  replaceFragment(fragment: string): void {
    this.replaced.push(fragment);
    this.current = new URL(fragment, this.current).toString();
  }
  onFragmentChange(handler: () => void): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }
  /** Puts `fragment` in the address without a load, and tells each handler, as a browser does. */
  navigate(fragment: string): void {
    this.current = new URL(fragment, this.current).toString();
    for (const handler of [...this.handlers]) handler();
  }
}

function button(within: Element, text: string): HTMLButtonElement {
  const found = [...within.querySelectorAll('button')].find((candidate) => candidate.textContent === text);
  if (found === undefined) throw new Error(`there is no ${text} button`);
  return found;
}

function find<T extends Element>(within: Element, selector: string): T {
  const found = within.querySelector<T>(selector);
  if (found === null) throw new Error(`there is no ${selector}`);
  return found;
}

const linkField = (within: Element) => find<HTMLInputElement>(within, 'input[name="link"]');
const errorOf = (within: Element) => find<HTMLElement>(within, '.join-error');
const messageOf = (within: Element) => find<HTMLElement>(within, '.join-message').textContent ?? '';
const isNewBoard = (secrets: RoomSecrets) => /^[0-9a-f]{16}$/.test(secrets.room) && /^[0-9a-f]{32}$/.test(secrets.key);

/** Lets each promise that a step resolved run its callbacks. */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();
}

describe('the link a person pastes', () => {
  it('reads the room and the password from a whole board link', () => {
    expect(secretsFromLink(`${PAGE}${BOARD_FRAGMENT}`, 'http://127.0.0.1:4173/')).toEqual(BOARD);
  });

  it("reads a fragment alone against the page's address, and trims white space", () => {
    expect(secretsFromLink(`  ${BOARD_FRAGMENT}\n`, PAGE)).toEqual(BOARD);
  });

  it("reads the link of the local-network mode, whose query names its relay", () => {
    expect(secretsFromLink(`http://192.168.1.20:8080/?relay=%2Frelay${BOARD_FRAGMENT}`, PAGE)).toEqual(BOARD);
  });

  it("returns null for text that isn't a board's link", () => {
    for (const text of ['', '   ', 'hello there', `${PAGE}#room=abc`, `${PAGE}#key=s3cret`, `${PAGE}?room=abc&key=s3cret`, 'http://[::1']) {
      expect(secretsFromLink(text, PAGE), text).toBeNull();
    }
  });
});

describe("the board an address names", () => {
  it("reads the room and the password from the address's fragment", () => {
    expect(boardInAddress(new TestAddress(`${PAGE}${BOARD_FRAGMENT}`))).toEqual(BOARD);
  });

  it('returns null where the fragment lacks either part', () => {
    for (const address of [PAGE, `${PAGE}#room=abc`, `${PAGE}#key=s3cret`, `${PAGE}#room=abc&key=`]) {
      expect(boardInAddress(new TestAddress(address)), address).toBeNull();
    }
  });
});

describe('the join screen', () => {
  function open(address = PAGE) {
    const onJoin = vi.fn<(secrets: RoomSecrets) => void>();
    const screen = joinScreen(document, { address, onJoin });
    document.body.replaceChildren(screen);
    return { screen, onJoin };
  }

  it("says that a link without a board's name and password doesn't name a board", () => {
    for (const address of [PAGE, `${PAGE}#unrelated=1`]) {
      expect(messageOf(open(address).screen), address).toContain("This link doesn't name a board.");
    }
  });

  it("says that a link with only part of a board's name and password doesn't open a board", () => {
    for (const address of [`${PAGE}#room=abc`, `${PAGE}#key=s3cret`, `${PAGE}#room=abc&key=`]) {
      expect(messageOf(open(address).screen), address).toContain("This link holds only part of a board's name and password");
    }
  });

  it('opens a new board, with a new random name and password, on New board', () => {
    const { screen, onJoin } = open();
    button(screen, 'New board').click();
    button(screen, 'New board').click();
    expect(onJoin).toHaveBeenCalledTimes(2);
    const [[first], [second]] = onJoin.mock.calls;
    expect(isNewBoard(first)).toBe(true);
    expect(isNewBoard(second)).toBe(true);
    expect(second).not.toEqual(first);
    expect(errorOf(screen).hidden).toBe(true);
  });

  it('opens the board of a pasted link on Join', () => {
    const { screen, onJoin } = open();
    linkField(screen).value = `${PAGE}${BOARD_FRAGMENT}`;
    button(screen, 'Join').click();
    expect(onJoin).toHaveBeenCalledOnce();
    expect(onJoin).toHaveBeenCalledWith(BOARD);
    expect(errorOf(screen).hidden).toBe(true);
  });

  it("says so where the pasted text isn't a board's link, and opens the board once it is", () => {
    const { screen, onJoin } = open();
    linkField(screen).value = `${PAGE}#room=abc`;
    button(screen, 'Join').click();
    expect(errorOf(screen).hidden).toBe(false);
    linkField(screen).value = '';
    button(screen, 'Join').click();
    expect(errorOf(screen).hidden).toBe(false);
    expect(onJoin).not.toHaveBeenCalled();
    linkField(screen).value = BOARD_FRAGMENT;
    button(screen, 'Join').click();
    expect(onJoin).toHaveBeenCalledOnce();
    expect(onJoin).toHaveBeenCalledWith(BOARD);
    expect(errorOf(screen).hidden).toBe(true);
  });
});

describe('choosing a board on the join screen', () => {
  function choose(start = PAGE) {
    const holder = document.createElement('div');
    document.body.replaceChildren(holder);
    const address = new TestAddress(start);
    let chosen: RoomSecrets | undefined;
    const choice = chooseRoom(holder, address).then((secrets) => {
      chosen = secrets;
      return secrets;
    });
    return { holder, address, choice, chosen: () => chosen };
  }

  it('shows the join screen, and on New board opens a new board and puts its link in the address', async () => {
    const { holder, address, choice } = choose();
    expect(holder.querySelector('.join-screen')).not.toBeNull();
    button(holder, 'New board').click();
    const secrets = await choice;
    expect(isNewBoard(secrets)).toBe(true);
    expect(address.replaced).toEqual([roomFragment(secrets)]);
    expect(boardInAddress(address)).toEqual(secrets);
    expect(holder.childElementCount).toBe(0);
    expect(address.handlers.size).toBe(0);
  });

  it('opens the board of a pasted link, and puts its fragment in the address', async () => {
    const { holder, address, choice } = choose('http://192.168.1.20:8080/?relay=%2Frelay');
    linkField(holder).value = `http://192.168.1.20:8080/?relay=%2Frelay${BOARD_FRAGMENT}`;
    button(holder, 'Join').click();
    expect(await choice).toEqual(BOARD);
    expect(address.replaced).toEqual([roomFragment(BOARD)]);
    expect(holder.childElementCount).toBe(0);
    expect(address.handlers.size).toBe(0);
  });

  it('opens the board whose link a person puts in the address bar', async () => {
    const { holder, address, choice } = choose();
    address.navigate(BOARD_FRAGMENT);
    expect(await choice).toEqual(BOARD);
    expect(address.replaced).toEqual([]);
    expect(holder.childElementCount).toBe(0);
    expect(address.handlers.size).toBe(0);
  });

  it("stays on the join screen while the address doesn't name a board", async () => {
    const { holder, address, choice, chosen } = choose();
    address.navigate('#room=abc');
    address.navigate('#');
    await settle();
    expect(chosen()).toBeUndefined();
    expect(holder.querySelector('.join-screen')).not.toBeNull();
    expect(address.handlers.size).toBe(1);
    address.navigate(BOARD_FRAGMENT);
    expect(await choice).toEqual(BOARD);
  });

  it('changes the address no more once a board is chosen', async () => {
    const { holder, address, choice } = choose();
    const newBoard = button(holder, 'New board');
    address.navigate(BOARD_FRAGMENT);
    expect(await choice).toEqual(BOARD);
    newBoard.click();
    expect(address.replaced).toEqual([]);
    expect(boardInAddress(address)).toEqual(BOARD);
  });
});

describe('loading the page again on another board', () => {
  it('loads the page again once the address names another room, another password or no board', () => {
    for (const fragment of ['#room=other&key=s3cret', '#room=abc&key=other', '#room=abc', '#']) {
      const address = new TestAddress(`${PAGE}${BOARD_FRAGMENT}`);
      const reload = vi.fn<() => void>();
      reloadOnRoomChange(address, BOARD, reload);
      address.navigate(fragment);
      expect(reload, fragment).toHaveBeenCalledOnce();
    }
  });

  it('keeps the page where the address names the same board', () => {
    const address = new TestAddress(`${PAGE}${BOARD_FRAGMENT}`);
    const reload = vi.fn<() => void>();
    reloadOnRoomChange(address, BOARD, reload);
    address.navigate('#key=s3cret&room=abc');
    address.navigate(BOARD_FRAGMENT);
    expect(reload).not.toHaveBeenCalled();
  });

  it('stops once the function it returns runs', () => {
    const address = new TestAddress(`${PAGE}${BOARD_FRAGMENT}`);
    const reload = vi.fn<() => void>();
    reloadOnRoomChange(address, BOARD, reload)();
    address.navigate('#room=other&key=s3cret');
    expect(reload).not.toHaveBeenCalled();
    expect(address.handlers.size).toBe(0);
  });
});

describe("the main menu's New board item", () => {
  it("makes a new board's link each time it is chosen", () => {
    const first = parseRoomFragment(newBoardFragment());
    const second = parseRoomFragment(newBoardFragment());
    expect(first !== null && isNewBoard(first)).toBe(true);
    expect(second !== null && isNewBoard(second)).toBe(true);
    expect(second).not.toEqual(first);
  });
});

describe("a window's address", () => {
  afterEach(() => {
    window.history.replaceState(null, '', '/');
  });

  it('puts a fragment in the address, keeping its path and query, without a fragment-change event', async () => {
    window.history.replaceState(null, '', '/chalkline/?relay=%2Frelay');
    const address = windowAddress(window);
    const seen: string[] = [];
    const stop = address.onFragmentChange(() => seen.push(address.href()));
    address.replaceFragment(BOARD_FRAGMENT);
    expect(address.href()).toBe(`${window.location.origin}/chalkline/?relay=%2Frelay${BOARD_FRAGMENT}`);
    expect(boardInAddress(address)).toEqual(BOARD);
    // A fragment set as a link sets it fires the event, and it is the first event the handler sees.
    const fired = new Promise<void>((resolve) => {
      const stopNext = address.onFragmentChange(() => {
        stopNext();
        resolve();
      });
    });
    window.location.hash = '#room=other&key=s3cret';
    await fired;
    stop();
    expect(seen).toEqual([`${window.location.origin}/chalkline/?relay=%2Frelay#room=other&key=s3cret`]);
  });

  it('stops telling a handler once its stop function runs', async () => {
    const address = windowAddress(window);
    const stopped = vi.fn<() => void>();
    address.onFragmentChange(stopped)();
    const fired = new Promise<void>((resolve) => {
      const stop = address.onFragmentChange(() => {
        stop();
        resolve();
      });
    });
    window.location.hash = BOARD_FRAGMENT;
    await fired;
    expect(stopped).not.toHaveBeenCalled();
  });
});
