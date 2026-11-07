import {
  linkErrorText,
  sameTurnServer,
  saveSettings,
  settingsFromForm,
  turnPartOf,
  type ConnectionSettings,
  type FromLink,
  type SettingsStorage,
  type TurnRow,
  type TurnServer,
} from './connection';

/** What the panel does with a person's choices. */
export interface PanelOptions {
  /** The settings the panel opens with. */
  settings: ConnectionSettings;
  /** The servers of the board's link that the settings don't hold, and why the page can't read them, where it can't. */
  fromLink?: FromLink;
  /** Keeps the settings the person saves; throws where the browser didn't keep them. */
  onSave(settings: ConnectionSettings): void;
  /** Closes the panel without saving. */
  onClose(): void;
}

/**
 * The connection settings panel: a row for each TURN server, the person's
 * own relays, and Save and reload, since the room reads its settings as the
 * page joins it.
 */
export function settingsPanel(doc: Document, options: PanelOptions): HTMLElement {
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
  const field = (label: string, name: keyof TurnRow, type: string, value: string, placeholder = ''): HTMLLabelElement => {
    const wrapper = make('label', label);
    const input = make('input');
    input.name = name;
    input.type = type;
    input.value = value;
    input.placeholder = placeholder;
    input.setAttribute('autocomplete', type === 'password' ? 'new-password' : 'off');
    wrapper.append(input);
    return wrapper;
  };

  const rows = make('div');
  rows.className = 'turn-rows';
  const addRow = (server?: TurnServer) => {
    const row = make('div');
    row.className = 'turn-row';
    row.append(
      field('Address', 'urls', 'text', server?.urls.join(' ') ?? '', 'turn:turn.example.com:3478'),
      field('Username', 'username', 'text', server?.username ?? ''),
      field('Password', 'credential', 'password', server?.credential ?? ''),
      button('Remove', () => row.remove()),
    );
    rows.append(row);
  };
  for (const server of options.settings.turnServers) addRow(server);
  const readRows = (): TurnRow[] =>
    [...rows.querySelectorAll<HTMLElement>('.turn-row')].map((row) => {
      const value = (name: keyof TurnRow) => row.querySelector<HTMLInputElement>(`input[name="${name}"]`)?.value ?? '';
      return { urls: value('urls'), username: value('username'), credential: value('credential') };
    });

  const relays = make('textarea');
  relays.name = 'relays';
  relays.rows = 3;
  relays.placeholder = 'wss://relay.example.com';
  relays.value = options.settings.relays.join('\n');
  const relaysLabel = make('label', 'Nostr relays');
  relaysLabel.append(relays);

  const errors = make('ul');
  errors.className = 'settings-errors';
  errors.setAttribute('role', 'alert');
  errors.hidden = true;
  const showErrors = (messages: string[]) => {
    errors.replaceChildren(...messages.map((message) => make('li', message)));
    errors.hidden = messages.length === 0;
  };

  /** Saves what the person typed, and `extra`, servers of the board's link that the person chose to keep. */
  const save = (extra: TurnServer[] = []) => {
    const result = settingsFromForm(readRows(), relays.value);
    if ('errors' in result) {
      showErrors(result.errors);
      return;
    }
    showErrors([]);
    // A server of the link that the person typed in the panel too is kept once.
    const { turnServers } = result.settings;
    const added = extra.filter((server) => !turnServers.some((kept) => sameTurnServer(kept, server)));
    try {
      options.onSave({ ...result.settings, turnServers: [...turnServers, ...added] });
    } catch (error) {
      showErrors([`This browser didn't keep the settings: ${error instanceof Error ? error.message : String(error)}`]);
    }
  };

  // The servers of the board's link, which the page uses for this board alone, and which Keep adds to the settings.
  const fromLink = options.fromLink ?? { servers: [], error: null };
  const linkPart: HTMLElement[] = [];
  if (fromLink.servers.length > 0 || fromLink.error !== null) linkPart.push(make('h3', 'From this link'));
  if (fromLink.servers.length > 0) {
    const list = make('ul');
    list.className = 'link-servers';
    for (const server of fromLink.servers) {
      const urls = server.urls.join(' ');
      list.append(make('li', server.username === undefined ? urls : `${urls} (username ${server.username})`));
    }
    linkPart.push(
      make(
        'p',
        "This board's link carries these servers. The page uses them for this board alone, beside the TURN servers above, and doesn't keep them.",
      ),
      list,
    );
    const keep = fromLink.servers.flatMap((server) => {
      const part = turnPartOf(server);
      return part === null ? [] : [part];
    });
    if (keep.length > 0) {
      linkPart.push(
        make(
          'p',
          'Keep them in this browser to use them on every board it opens: the page saves their turn: and turns: addresses with the settings above, and reloads the board.',
        ),
        button('Keep them in this browser', () => save(keep)),
      );
    }
  }
  if (fromLink.error !== null) {
    const refusal = make('p', linkErrorText(fromLink.error));
    refusal.className = 'link-error';
    refusal.setAttribute('role', 'alert');
    linkPart.push(refusal);
  }

  const actions = make('div');
  actions.className = 'settings-actions';
  actions.append(button('Cancel', () => options.onClose()), button('Save and reload', () => save()));

  const panel = make('section');
  panel.className = 'settings-panel';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', 'Connection settings');
  panel.append(
    make('h2', 'Connection settings'),
    make('p', 'These settings stay in this browser and apply to every board it opens. Saving them reloads the board.'),
    make('h3', 'TURN servers'),
    make(
      'p',
      "A TURN server forwards the encrypted traffic between two browsers that can't connect directly, as on some office networks and VPNs; traffic goes through it only between those browsers. Sign up for a hosted TURN service, such as Cloudflare's, or run your own, such as coturn.",
    ),
    rows,
    button('Add a TURN server', () => addRow()),
    ...linkPart,
    make('h3', 'Relays'),
    make(
      'p',
      "Relays carry the first connection details between browsers, encrypted with the board's password. To use your own Nostr relays in place of the public ones, list them here, one wss:// address a line. Everyone on a board needs at least one relay in common. Leave the list empty to use the public relays.",
    ),
    relaysLabel,
    errors,
    actions,
  );
  return panel;
}

/** What the Connection settings button and the main menu's item open the panel with. */
export interface ButtonOptions {
  settings: ConnectionSettings;
  /** The browser's storage, or null where the browser doesn't let the page use it. */
  storage: SettingsStorage | null;
  /** Loads the board again, so that the room joins with the saved settings. */
  reload(): void;
  /** The servers of the board's link that the settings don't hold, which the panel reads each time it opens. */
  fromLink?(): FromLink;
}

/**
 * Returns the call that opens the panel in `holder`. Save keeps the settings in
 * `storage` and reloads the board; Cancel closes the panel.
 */
export function settingsOpener(holder: HTMLElement, options: ButtonOptions): () => void {
  const close = () => {
    holder.hidden = true;
    holder.replaceChildren();
  };
  return () => {
    holder.replaceChildren(
      settingsPanel(holder.ownerDocument, {
        settings: options.settings,
        fromLink: options.fromLink?.(),
        onSave: (saved) => {
          if (options.storage === null) throw new Error("it doesn't let this page keep anything");
          saveSettings(options.storage, saved);
          options.reload();
        },
        onClose: close,
      }),
    );
    holder.hidden = false;
  };
}

/** Opens the panel in `holder` each time `button` is clicked, as `settingsOpener` does. */
export function connectSettingsButton(button: HTMLElement, holder: HTMLElement, options: ButtonOptions): void {
  button.addEventListener('click', settingsOpener(holder, options));
}
