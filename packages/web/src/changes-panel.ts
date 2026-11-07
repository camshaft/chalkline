// The list of the agent's changes of the board, newest first, each with an Undo button, which the main
// menu's "Agent's changes" opens. chalkline-mcp records each of its tool calls that changes the board
// on the board's list of the agent's changes (@chalkline/mcp/agent-changes). Undo writes each element
// the change wrote back as it was before the change, for everyone on the board; the change's item then
// says who undid it and when, and names each element the undo left as it is, since someone changed it
// after the change.
import { listAgentChanges, undoAgentChange, UndoError, type KeptElement, type ListedChange } from '@chalkline/mcp/agent-changes';
import type * as Y from 'yjs';

/** Who undoes a change from the panel, and the time of each undo. */
export interface ChangesOptions {
  /** The name of the person who presses Undo, as the board shows it now. */
  undoer(): string;
  /** The time of an undo; now where left out. */
  now?(): Date;
}

/** What bindChangesPanel returns. */
export interface ChangesPanel {
  /** Opens the panel, or closes it where `shown` is false. */
  open(shown: boolean): void;
  /** Opens the panel where it is closed, and closes it where it is open. */
  toggle(): void;
  /** Stops following the board's list of changes. */
  stop(): void;
}

/**
 * Fills `panel` with the agent's changes that `changes` records, newest first, and keeps it in step
 * with the board: each change shows its summary, its time, and an Undo button, or, once someone undid
 * it, who undid it and when, and the elements of `elements` that the undo left as they are. The panel
 * starts closed, and puts the focus on its Close button as it opens; the Close button, as Escape in
 * the panel does, closes it. Where an undo can't run, as where someone undid the change already on
 * another page, the panel's status line says why.
 */
export function bindChangesPanel(
  panel: HTMLElement,
  elements: Y.Map<unknown>,
  changes: Y.Array<unknown>,
  options: ChangesOptions,
): ChangesPanel {
  const doc = panel.ownerDocument;
  const now = options.now ?? (() => new Date());
  const make = <K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text = ''): HTMLElementTagNameMap[K] => {
    const made = doc.createElement(tag);
    made.className = className;
    made.textContent = text;
    return made;
  };

  const open = (shown: boolean): void => {
    const opening = shown && panel.hidden;
    panel.hidden = !shown;
    if (opening) closer.focus();
  };
  const closer = make('button', 'changes-close', 'Close');
  closer.type = 'button';
  closer.setAttribute('aria-label', "Close the agent's changes");
  closer.addEventListener('click', () => open(false));
  const header = make('div', 'changes-header');
  header.append(make('h2', '', "Agent's changes"), closer);
  const status = make('p', 'changes-status');
  status.setAttribute('role', 'status');
  status.hidden = true;
  const empty = make('p', 'changes-empty', "The agent hasn't changed the board yet.");
  const list = make('ol', 'changes-list');
  panel.replaceChildren(header, status, empty, list);
  panel.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || event.isComposing) return;
    event.preventDefault();
    open(false);
  });

  const say = (text: string): void => {
    status.textContent = text;
    status.hidden = text === '';
  };
  const undo = (id: string): void => {
    try {
      undoAgentChange(elements, changes, id, { by: options.undoer(), now: now() });
      say('');
    } catch (error) {
      if (!(error instanceof UndoError)) throw error;
      say(error.message);
    }
  };

  const render = (): void => {
    const listed = listAgentChanges(changes);
    list.replaceChildren(...listed.map((change) => changeItem(doc, change, undo)));
    empty.hidden = listed.length > 0;
  };
  changes.observe(render);
  render();
  open(false);

  return {
    open,
    toggle: () => open(panel.hidden),
    stop: () => changes.unobserve(render),
  };
}

/** The item of one change: its summary, its time, and its Undo button, or who undid it and what the undo left. */
function changeItem(doc: Document, change: ListedChange, undo: (id: string) => void): HTMLLIElement {
  const item = doc.createElement('li');
  item.className = 'changes-item';
  item.dataset.id = change.id;
  item.dataset.state = change.undo === null ? 'undoable' : 'undone';
  const summary = doc.createElement('span');
  summary.className = 'changes-summary';
  summary.textContent = change.summary;
  item.append(summary, ' ', timeOf(doc, change.at));
  if (change.undo === null) {
    const button = doc.createElement('button');
    button.type = 'button';
    button.className = 'changes-undo';
    button.textContent = 'Undo';
    button.title = `Undo: ${change.summary}`;
    button.addEventListener('click', () => undo(change.id));
    item.append(button);
    return item;
  }
  const undone = doc.createElement('p');
  undone.className = 'changes-undone';
  undone.append(`Undone by ${change.undo.by} at `, timeOf(doc, change.undo.at));
  item.append(undone);
  if (change.undo.kept.length > 0) item.append(keptPart(doc, change.undo.kept));
  return item;
}

/** A time element of `at`, an ISO 8601 time, which shows its hour and minute. */
function timeOf(doc: Document, at: string): HTMLTimeElement {
  const when = doc.createElement('time');
  when.className = 'changes-time';
  when.dateTime = at;
  when.textContent = new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return when;
}

/** What an undo left as it was: the elements that someone changed after the change, by their names. */
function keptPart(doc: Document, kept: KeptElement[]): HTMLParagraphElement {
  const part = doc.createElement('p');
  part.className = 'changes-kept';
  const names = joined(kept.map((element) => element.name));
  part.textContent =
    kept.length === 1
      ? `Left ${names} as it is, since someone changed it after this change.`
      : `Left ${names} as they are, since someone changed them after this change.`;
  return part;
}

/** `names` in one phrase, such as "a rectangle", "a rectangle and an arrow" or "a, b and c". */
export function joined(names: string[]): string {
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}
