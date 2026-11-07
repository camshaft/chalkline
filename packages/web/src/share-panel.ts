import { roomFragment, type RoomSecrets, type TurnServer } from './room';

/**
 * The link of the board `secrets` names, on the page at `address`: the
 * address with the board's fragment in place of its own, and the `turn`
 * parameter for `servers` where it lists any, so that the plain link never
 * carries the TURN servers of the link the page opened with.
 */
export function boardLink(address: string, secrets: RoomSecrets, servers: readonly TurnServer[] = []): string {
  const link = new URL(address);
  link.hash = roomFragment(secrets, servers);
  return link.toString();
}

const TURN_ADDRESS = /^turns?:/i;

/**
 * The servers of `servers` that a link can carry: each one without a turn:
 * or turns: address, and each one with its username and its password, since
 * a page that opens the link refuses a TURN server that lacks either.
 */
export function linkableServers(servers: readonly TurnServer[]): TurnServer[] {
  return servers.filter(
    (server) =>
      !server.urls.some((url) => TURN_ADDRESS.test(url)) ||
      (server.username !== undefined && server.credential !== undefined),
  );
}

/** What the Share link panel shares, and what it does with a person's choices. */
export interface ShareOptions {
  /** The page's address, whose fragment the panel's links replace. */
  address: string;
  /** The board's room name and password. */
  secrets: RoomSecrets;
  /** The TURN servers the page uses for the board: the browser's own, then the ones its link carries. */
  turnServers: readonly TurnServer[];
  /** Puts `text` on the clipboard; rejects where the browser doesn't let the page. */
  copy(text: string): Promise<void>;
  /** Closes the panel. */
  onClose(): void;
}

/**
 * The Share link panel: Copy link, which copies the board's link, and, where
 * the page uses TURN servers for the board, Copy link with TURN servers,
 * which copies the link with those servers and their passwords in its
 * fragment, beside a warning that anyone who has that link can use them.
 */
export function sharePanel(doc: Document, options: ShareOptions): HTMLElement {
  const make = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string): HTMLElementTagNameMap[K] => {
    const made = doc.createElement(tag);
    if (text !== undefined) made.textContent = text;
    return made;
  };
  const button = (text: string, onClick: () => void): HTMLButtonElement => {
    const made = make('button', text);
    made.type = 'button';
    made.addEventListener('click', onClick);
    return made;
  };

  // The field that shows a link where the browser doesn't let the page copy it, so that the person copies it.
  const shown = make('input');
  shown.type = 'text';
  shown.readOnly = true;
  shown.hidden = true;
  shown.setAttribute('aria-label', 'Board link');
  const status = make('p');
  status.className = 'share-status';
  status.setAttribute('role', 'status');

  const copy = (link: string, what: string) => {
    Promise.resolve()
      .then(() => options.copy(link))
      .then(
        () => {
          shown.hidden = true;
          status.textContent = `Copied the ${what}.`;
        },
        () => {
          shown.value = link;
          shown.hidden = false;
          shown.focus();
          shown.select();
          status.textContent = `This browser didn't let the page copy the ${what}: copy it from the field above.`;
        },
      );
  };

  const servers = linkableServers(options.turnServers);
  const leftOut = options.turnServers.length - servers.length;
  const turnPart: HTMLElement[] = [];
  if (servers.length > 0) {
    const warning = make(
      'p',
      "Copy link with TURN servers puts the TURN servers this page uses for the board in the link, with their usernames and passwords, so that a browser that can't connect directly joins through them without setting them up. Anyone who has that link can use those servers, on the account that pays for them: share it only with the people the board is for. Short-lived passwords that expire, such as the ones a hosted TURN service hands out, are safer to share than a server's lasting password.",
    );
    warning.className = 'share-warning';
    const withServers = boardLink(options.address, options.secrets, servers);
    turnPart.push(warning, button('Copy link with TURN servers', () => copy(withServers, 'link with TURN servers')));
  } else {
    turnPart.push(make('p', 'To share TURN servers with the link, add them in Connection settings first.'));
  }
  if (leftOut > 0) {
    turnPart.push(
      make(
        'p',
        `The link leaves out ${leftOut === 1 ? 'a TURN server' : `${leftOut} TURN servers`} of the Connection settings that ${leftOut === 1 ? 'lacks' : 'lack'} a username or a password, since a page that opens the link can't use ${leftOut === 1 ? 'it' : 'them'}.`,
      ),
    );
  }

  const actions = make('div');
  actions.className = 'settings-actions';
  actions.append(button('Close', () => options.onClose()));

  const panel = make('section');
  panel.className = 'settings-panel share-panel';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', 'Share this board');
  panel.append(
    make('h2', 'Share this board'),
    make(
      'p',
      "Anyone who has the board's link can open the board and draw on it, since its name and password travel in the link: share it only with the people the board is for.",
    ),
    button('Copy link', () => copy(boardLink(options.address, options.secrets), 'link')),
    ...turnPart,
    shown,
    status,
    actions,
  );
  return panel;
}

/** What the main menu's Share link item opens the panel with, read each time it opens. */
export type ShareOpenerOptions = () => Omit<ShareOptions, 'onClose'>;

/** Returns the call that opens the Share link panel in `holder`, with what `options` returns then; Close closes it. */
export function shareOpener(holder: HTMLElement, options: ShareOpenerOptions): () => void {
  const close = () => {
    holder.hidden = true;
    holder.replaceChildren();
  };
  return () => {
    holder.replaceChildren(sharePanel(holder.ownerDocument, { ...options(), onClose: close }));
    holder.hidden = false;
  };
}
