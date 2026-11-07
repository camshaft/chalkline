import { newRoomSecrets, parseRoomFragment, roomFragment, type RoomSecrets } from './room';

/** The page's address, and the changes of its fragment. */
export interface PageAddress {
  /** The page's address now. */
  href(): string;
  /** Puts `fragment` in the address in place of its fragment, without loading the page or adding a history entry. */
  replaceFragment(fragment: string): void;
  /**
   * Calls `handler` each time the fragment changes without a load, as when a
   * person puts a board's link in the address bar or presses Back; returns a
   * function that stops it.
   */
  onFragmentChange(handler: () => void): () => void;
}

/** The address of the page that `win` shows. */
export function windowAddress(win: Window): PageAddress {
  return {
    href: () => win.location.href,
    replaceFragment: (fragment) => win.history.replaceState(win.history.state, '', fragment),
    onFragmentChange: (handler) => {
      win.addEventListener('hashchange', handler);
      return () => win.removeEventListener('hashchange', handler);
    },
  };
}

/** The board that the address's fragment names, or null where it lacks the room's name or its password. */
export function boardInAddress(address: PageAddress): RoomSecrets | null {
  return parseRoomFragment(new URL(address.href()).hash);
}

/**
 * The room's name and password in the link of a board that a person pasted:
 * the whole link, or its fragment alone, read against `base`, the page's
 * address. Null where the text isn't a link, or where its fragment lacks
 * either part.
 */
export function secretsFromLink(text: string, base: string): RoomSecrets | null {
  const trimmed = text.trim();
  if (trimmed === '') return null;
  let link: URL;
  try {
    link = new URL(trimmed, base);
  } catch {
    return null;
  }
  return parseRoomFragment(link.hash);
}

/** What the join screen does with the board a person chooses. */
export interface JoinScreenOptions {
  /**
   * The page's address: the screen says whether its fragment holds part of a
   * board's link, and reads a pasted fragment against it.
   */
  address: string;
  /** Opens the board the person chose. */
  onJoin(secrets: RoomSecrets): void;
}

/**
 * The screen of a link that doesn't name a board: a New board button, which
 * makes a new room's name and password, and a field for the link of a board
 * that someone shared.
 */
export function joinScreen(doc: Document, options: JoinScreenOptions): HTMLElement {
  const make = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string): HTMLElementTagNameMap[K] => {
    const made = doc.createElement(tag);
    if (text !== undefined) made.textContent = text;
    return made;
  };

  const params = new URLSearchParams(new URL(options.address).hash.slice(1));
  const partial = Boolean(params.get('room') || params.get('key'));
  const message = make(
    'p',
    partial
      ? "This link holds only part of a board's name and password, so it doesn't open a board. Paste the whole link someone shared with you, or start a new board."
      : "This link doesn't name a board. Start a new board, or paste the link of a board someone shared with you.",
  );
  message.className = 'join-message';

  const newBoard = make('button', 'New board');
  newBoard.type = 'button';
  newBoard.addEventListener('click', () => options.onJoin(newRoomSecrets()));

  const link = make('input');
  link.name = 'link';
  link.type = 'text';
  link.placeholder = '#room=<name>&key=<password>';
  link.setAttribute('autocomplete', 'off');
  const linkLabel = make('label', 'Board link');
  linkLabel.append(link);
  const join = make('button', 'Join');
  join.type = 'submit';

  const error = make('p', "That isn't a board's link: a board's link ends in #room=<name>&key=<password>.");
  error.className = 'join-error';
  error.setAttribute('role', 'alert');
  error.hidden = true;

  const form = make('form');
  form.append(linkLabel, join);
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const secrets = secretsFromLink(link.value, options.address);
    error.hidden = secrets !== null;
    if (secrets !== null) options.onJoin(secrets);
  });

  const screen = make('section');
  screen.className = 'join-screen';
  screen.setAttribute('aria-label', 'Open a board');
  screen.append(
    make('h2', 'Open a board'),
    message,
    newBoard,
    form,
    error,
    make(
      'p',
      "A board's name and password travel in its link after the #, which the browser doesn't send to the site that serves this page. Anyone who holds the link can join the board.",
    ),
  );
  return screen;
}

/**
 * Shows the join screen in `holder` until a person chooses a board, and
 * resolves with that board. New board and a pasted link put the board's
 * fragment in the address; a board's link put in the address bar, which
 * changes the fragment without a load, chooses that board too. The screen
 * leaves `holder` once a board is chosen, and later choices change nothing.
 */
export function chooseRoom(holder: HTMLElement, address: PageAddress): Promise<RoomSecrets> {
  return new Promise((resolve) => {
    let chosen = false;
    const choose = (secrets: RoomSecrets) => {
      if (chosen) return;
      chosen = true;
      stop();
      holder.replaceChildren();
      resolve(secrets);
    };
    const stop = address.onFragmentChange(() => {
      const secrets = boardInAddress(address);
      if (secrets !== null) choose(secrets);
    });
    holder.replaceChildren(
      joinScreen(holder.ownerDocument, {
        address: address.href(),
        onJoin: (secrets) => {
          if (chosen) return;
          address.replaceFragment(roomFragment(secrets));
          choose(secrets);
        },
      }),
    );
  });
}

/**
 * Loads the page again once its address names another board than `joined`,
 * or none: the page joins its board only as it loads, and a change of the
 * fragment alone, as from the New board button, a board's link put in the
 * address bar or the Back button, doesn't load it. Returns a function that
 * stops it.
 */
export function reloadOnRoomChange(address: PageAddress, joined: RoomSecrets, reload: () => void): () => void {
  return address.onFragmentChange(() => {
    const now = boardInAddress(address);
    if (now === null || now.room !== joined.room || now.key !== joined.key) reload();
  });
}

/**
 * The fragment of a new board's link, with a new room's name and password,
 * which the main menu's New board item opens.
 */
export function newBoardFragment(): string {
  return roomFragment(newRoomSecrets());
}
