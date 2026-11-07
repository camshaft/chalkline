import { isShape, type SnapshotMark } from '@chalkline/sync';
import type { SnapshotKeeper, SnapshotSummary } from './snapshots';

/** What the History panel reads and writes. */
export interface HistoryOptions<T> {
  /** This browser's snapshots of the board. */
  snapshots: Pick<SnapshotKeeper<T>, 'list' | 'elements' | 'lost' | 'onChange'>;
  /** The board's snapshot mark `id`, which says who saved a mark's snapshot, or null where the board lacks it. */
  mark(id: string): SnapshotMark | null;
  /** Draws a preview of a snapshot's elements, such as the SVG that Excalidraw's `exportToSvg` draws. */
  preview(elements: T[]): Promise<Element>;
  /** Writes a snapshot's elements into the board for everyone, and returns the elements it wrote. */
  restore(elements: T[]): T[];
  /** A snapshot's time as the panel shows it: the browser's local time, unless a test sets another. */
  time?: (at: number) => string;
  /** Closes the panel. */
  onClose(): void;
}

/** The History panel that `historyPanel` makes. */
export interface HistoryPanel {
  /** The panel, which the page puts in its holder. */
  readonly element: HTMLElement;
  /** Resolves once the panel shows the preview of the snapshot chosen last, or says why it doesn't. */
  idle(): Promise<void>;
  /** Stops listing the snapshots again on each write to the store. */
  stop(): void;
}

const counted = (count: number, one: string, many: string): string => `${count} ${count === 1 ? one : many}`;

/** Why the browser took `snapshot`, as the History panel says it; `mark` is the mark of a mark's snapshot. */
export function snapshotReason(snapshot: SnapshotSummary, mark: SnapshotMark | null): string {
  switch (snapshot.reason) {
    case 'interval':
      return 'Every 10 minutes';
    case 'deletion':
      return snapshot.deleted === null ? 'Before a large deletion' : `Before ${snapshot.deleted} shapes were deleted`;
    case 'mark': {
      const saved = `Saved by ${mark?.by ?? 'the agent'}`;
      return snapshot.label === null ? saved : `${saved}: ${snapshot.label}`;
    }
  }
}

/**
 * The History panel (designs/chalkline A14): this browser's snapshots of the board, newest first, each with its
 * time, its shape count and why the browser took it, listed again after each write to the store. Choosing one
 * shows its preview, with Restore, which writes its elements into the board for everyone and says how many shapes
 * it restored.
 */
export function historyPanel<T>(page: Document, options: HistoryOptions<T>): HistoryPanel {
  const time = options.time ?? ((at: number) => new Date(at).toLocaleString());
  const make = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string): HTMLElementTagNameMap[K] => {
    const made = page.createElement(tag);
    if (text !== undefined) made.textContent = text;
    return made;
  };
  const button = (text: string, onClick: () => void): HTMLButtonElement => {
    const made = make('button', text);
    made.type = 'button';
    made.addEventListener('click', onClick);
    return made;
  };

  const lost = make('p', "This browser couldn't keep its newest snapshot of the board: its storage refused it, with every older snapshot removed.");
  lost.className = 'history-lost';
  lost.setAttribute('role', 'alert');
  const empty = make('p', "This browser hasn't kept a snapshot of this board yet.");
  empty.className = 'history-empty';
  const list = make('ul');
  list.className = 'history-list';
  const preview = make('div');
  preview.className = 'history-preview';
  preview.setAttribute('aria-label', 'Preview');
  const status = make('p');
  status.className = 'history-status';
  status.setAttribute('role', 'status');

  /** The snapshot the person chose last, by its key, and its elements once the panel has read them. */
  let chosen: number | null = null;
  let held: T[] | null = null;
  let pending: Promise<void> = Promise.resolve();

  const restore = button('Restore', () => {
    if (held === null) return;
    try {
      const written = options.restore(held);
      status.textContent =
        written.length === 0
          ? 'The board already holds this snapshot.'
          : `Restored ${counted(written.filter(isShape).length, 'shape', 'shapes')}.`;
    } catch (error) {
      status.textContent = `The snapshot couldn't be restored: ${error instanceof Error ? error.message : String(error)}`;
    }
  });
  restore.disabled = true;

  const show = (): void => {
    const snapshots = options.snapshots.list();
    list.replaceChildren(
      ...snapshots.map((snapshot) => {
        const why = snapshotReason(snapshot, snapshot.mark === null ? null : options.mark(snapshot.mark));
        const item = make('li');
        const choose = button(`${time(snapshot.at)} - ${counted(snapshot.shapes, 'shape', 'shapes')} - ${why}`, () =>
          select(snapshot.id),
        );
        choose.setAttribute('aria-pressed', String(snapshot.id === chosen));
        item.append(choose);
        return item;
      }),
    );
    empty.hidden = snapshots.length > 0;
    lost.hidden = !options.snapshots.lost();
  };

  const select = (id: number): void => {
    chosen = id;
    held = null;
    restore.disabled = true;
    status.textContent = '';
    preview.replaceChildren();
    show();
    pending = (async () => {
      const elements = await options.snapshots.elements(id);
      if (chosen !== id) return;
      if (elements === null) {
        status.textContent = "This browser doesn't hold this snapshot any longer.";
        return;
      }
      const drawing = await options.preview(elements);
      if (chosen !== id) return;
      preview.replaceChildren(drawing);
      held = elements;
      restore.disabled = false;
    })().catch((error: unknown) => {
      if (chosen === id) {
        status.textContent = `The preview couldn't be drawn: ${error instanceof Error ? error.message : String(error)}`;
      }
    });
  };

  const actions = make('div');
  actions.className = 'history-actions';
  actions.append(
    button('Close', () => options.onClose()),
    restore,
  );

  const panel = make('section');
  panel.className = 'history-panel';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', 'History');
  panel.append(
    make('h2', 'History'),
    make(
      'p',
      'This browser keeps these snapshots of the board in its own storage: one each 10 minutes while the board changes, one before a change deletes more than 50 shapes, and one each time the agent saves one. Choose a snapshot to preview it, and Restore to bring its shapes back for everyone.',
    ),
    lost,
    empty,
    list,
    preview,
    status,
    actions,
  );
  show();
  const stop = options.snapshots.onChange(show);
  return { element: panel, idle: () => pending, stop };
}

/**
 * Returns the call that opens the History panel in `holder`, as the main menu's History item opens it, and
 * returns the panel; Close closes it.
 */
export function historyOpener<T>(holder: HTMLElement, options: Omit<HistoryOptions<T>, 'onClose'>): () => HistoryPanel {
  let open: HistoryPanel | null = null;
  const close = () => {
    open?.stop();
    open = null;
    holder.hidden = true;
    holder.replaceChildren();
  };
  return () => {
    open?.stop();
    const panel = historyPanel(holder.ownerDocument, { ...options, onClose: close });
    open = panel;
    holder.replaceChildren(panel.element);
    holder.hidden = false;
    return panel;
  };
}
