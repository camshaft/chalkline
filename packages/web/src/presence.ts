import type { Awareness } from '@chalkline/sync';

/** Where a participant's pointer is, in the board's coordinates, and which of Excalidraw's pointer tools it holds. */
export interface Pointer {
  x: number;
  y: number;
  tool: 'pointer' | 'laser';
}

/** Whether a participant's pointer button is pressed. */
export type Button = 'up' | 'down';

/** An agent's status: `working` while one of its tool calls runs. */
export type AgentStatus = 'idle' | 'working';

/**
 * The awareness state each page shares, outside the stored document: its
 * participant's name, pointer and selection. An agent's helper shares its
 * name, its pointer, `agent` and its status, and the shapes it last added or
 * changed (designs/chalkline A6).
 */
export interface Presence {
  name?: string;
  pointer?: Pointer;
  button?: Button;
  /** The ids of the elements the participant has selected. */
  selectedElementIds?: Record<string, true>;
  /** Whether the participant is an agent's helper, which the participants list shows with the Agent badge. */
  agent?: true;
  /** An agent's status. */
  status?: AgentStatus;
  /** The ids of the shapes an agent last added or changed, which its Go to button shows. */
  shapes?: string[];
}

/** Another participant, in the fields of Excalidraw's `Collaborator` that the canvas draws. */
export interface Collaborator {
  /**
   * The participant's awareness client id. Excalidraw picks the cursor's color
   * from it, so every page draws one participant in the same color.
   */
  id: string;
  username?: string;
  pointer?: Pointer;
  button?: Button;
  selectedElementIds?: Record<string, true>;
}

/** The clients an awareness `change` event lists, by their ids. */
interface AwarenessChanges {
  added: number[];
  updated: number[];
  removed: number[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readPointer(value: unknown): Pointer | undefined {
  if (!isRecord(value)) return undefined;
  const { x, y, tool } = value;
  if (typeof x !== 'number' || !Number.isFinite(x) || typeof y !== 'number' || !Number.isFinite(y)) return undefined;
  return { x, y, tool: tool === 'laser' ? 'laser' : 'pointer' };
}

// Object.fromEntries defines each id as an own property, so an id such as
// `__proto__` from a peer stays an id and doesn't change the object's prototype.
function selectedIds(value: Readonly<Record<string, unknown>>): Record<string, true> {
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, chosen]) => chosen === true)
      .map(([id]) => [id, true] as const),
  );
}

/**
 * Reads a peer's awareness state, which arrives from the network: a field of
 * the wrong type is left out, a pointer of a tool this page doesn't know reads
 * as the plain pointer, and a state that isn't an object reads as null.
 */
export function readPresence(state: unknown): Presence | null {
  if (!isRecord(state)) return null;
  const { name, pointer, button, selectedElementIds, agent, status, shapes } = state;
  const presence: Presence = {};
  if (typeof name === 'string' && name.trim() !== '') presence.name = name;
  const shownPointer = readPointer(pointer);
  if (shownPointer !== undefined) presence.pointer = shownPointer;
  if (button === 'up' || button === 'down') presence.button = button;
  if (isRecord(selectedElementIds)) presence.selectedElementIds = selectedIds(selectedElementIds);
  if (agent === true) presence.agent = true;
  if (status === 'idle' || status === 'working') presence.status = status;
  if (Array.isArray(shapes) && shapes.every((id): id is string => typeof id === 'string')) presence.shapes = [...shapes];
  return presence;
}

/** Every participant but `self`, by awareness client id, as the canvas shows them. */
export function collaboratorsFrom(states: ReadonlyMap<number, unknown>, self: number): Map<string, Collaborator> {
  const collaborators = new Map<string, Collaborator>();
  for (const [client, state] of states) {
    if (client === self) continue;
    const presence = readPresence(state);
    if (presence === null) continue;
    // An agent's mark, status and shapes stay out of what the canvas reads: the participants list shows them.
    const { name, pointer, button, selectedElementIds } = presence;
    const collaborator: Collaborator = { id: String(client) };
    if (name !== undefined) collaborator.username = name;
    if (pointer !== undefined) collaborator.pointer = pointer;
    if (button !== undefined) collaborator.button = button;
    if (selectedElementIds !== undefined) collaborator.selectedElementIds = selectedElementIds;
    collaborators.set(collaborator.id, collaborator);
  }
  return collaborators;
}

/**
 * Writes `fields` into this participant's awareness state where they change
 * it. Each write goes to every peer, so a write that would change nothing
 * isn't made.
 */
function updateLocal(awareness: Awareness, fields: Presence): void {
  const current: Record<string, unknown> = awareness.getLocalState() ?? {};
  const changed = Object.entries(fields).some(([key, value]) => JSON.stringify(current[key]) !== JSON.stringify(value));
  if (changed) awareness.setLocalState({ ...current, ...fields });
}

/** Sets this participant's name, which the other pages show by its cursor. */
export function setName(awareness: Awareness, name: string): void {
  updateLocal(awareness, { name });
}

/** The canvas that `bindPresence` shows the other participants on. */
export interface PresenceView {
  /** Shows the other participants: each one's name, pointer and selection. */
  show(collaborators: Map<string, Collaborator>): void;
  /** The elements this participant has selected, by id. */
  selection(): Readonly<Record<string, boolean>>;
  /** Calls `handler` after each change on the canvas, and returns a function that stops it. */
  onChange(handler: () => void): () => void;
  /** Calls `handler` as this participant's pointer moves or its button changes, and returns a function that stops it. */
  onPointer(handler: (pointer: Pointer, button: Button) => void): () => void;
}

/**
 * Keeps this participant's pointer and selection in `awareness`, and shows
 * every other participant's name, pointer and selection on `view`: the ones
 * `awareness` holds as it binds, and each change of theirs after that, a
 * participant that leaves among them. Each pointer move is shared as the
 * canvas reports it. Returns a function that stops the binding.
 */
export function bindPresence(awareness: Awareness, view: PresenceView): () => void {
  const show = () => view.show(collaboratorsFrom(awareness.getStates(), awareness.clientID));
  const onChange = ({ added, updated, removed }: AwarenessChanges) => {
    // A change of this participant's own state alone doesn't change what the canvas shows.
    if ([...added, ...updated, ...removed].some((client) => client !== awareness.clientID)) show();
  };
  const share = () => updateLocal(awareness, { selectedElementIds: selectedIds(view.selection()) });

  awareness.on('change', onChange);
  const stopChanges = view.onChange(share);
  const stopPointer = view.onPointer(({ x, y, tool }, button) =>
    updateLocal(awareness, { pointer: { x, y, tool }, button }),
  );
  share();
  show();
  return () => {
    awareness.off('change', onChange);
    stopChanges();
    stopPointer();
  };
}

/** Where the page keeps this browser's name between visits. */
export const NAME_KEY = 'chalkline.name';

/** The part of the browser's storage that keeps the name. */
export type NameStorage = Pick<Storage, 'getItem' | 'setItem'>;

function keptName(storage: NameStorage | undefined): string | null {
  try {
    return storage?.getItem(NAME_KEY) ?? null;
  } catch {
    return null;
  }
}

/** Keeps `name` for this browser's next visit, where the browser lets the page store it. */
export function keepName(storage: NameStorage | undefined, name: string): void {
  try {
    storage?.setItem(NAME_KEY, name);
  } catch {
    // A browser that refuses the page its storage keeps the name for this visit alone.
  }
}

/**
 * The name this browser kept, or else a new one, such as "Guest 4f2a", which
 * it keeps from then on.
 */
export function participantName(storage: NameStorage | undefined, random: () => number = Math.random): string {
  const kept = keptName(storage);
  if (kept !== null && kept.trim() !== '') return kept;
  const name = `Guest ${Math.floor(random() * 0x10000)
    .toString(16)
    .padStart(4, '0')}`;
  keepName(storage, name);
  return name;
}
