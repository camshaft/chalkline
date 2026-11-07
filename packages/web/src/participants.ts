// The participants list (designs/chalkline A2, A6): each other participant of the room by name,
// among the page's controls. An agent shows with the Agent badge beside its name, "<name> is
// drawing..." while one of its tool calls runs, and a Go to button that scrolls and zooms the canvas
// to the shapes it last added or changed.
import type { Awareness } from '@chalkline/sync';
import { readPresence } from './presence';

/** Another participant of the room, as the participants list shows it. */
export interface Participant {
  /** The participant's awareness client id. */
  client: number;
  name: string;
  /** Whether the participant is an agent's helper. */
  agent: boolean;
  /** Whether the participant is an agent whose tool call runs. */
  working: boolean;
  /** The ids of the shapes an agent last added or changed, and none for a person. */
  shapes: string[];
}

/** Every participant of `states` but `self` that has a name, in the order of their client ids. */
export function participantsFrom(states: ReadonlyMap<number, unknown>, self: number): Participant[] {
  const participants: Participant[] = [];
  for (const [client, state] of states) {
    if (client === self) continue;
    const presence = readPresence(state);
    if (presence?.name === undefined) continue;
    const agent = presence.agent === true;
    participants.push({
      client,
      name: presence.name,
      agent,
      working: agent && presence.status === 'working',
      shapes: agent ? (presence.shapes ?? []) : [],
    });
  }
  return participants.sort((a, b) => a.client - b.client);
}

/** The words the list shows for `participant`: its name, or that it is drawing while an agent works. */
export function participantLine(participant: Participant): string {
  return participant.working ? `${participant.name} is drawing...` : participant.name;
}

/** What the participants list reads of the board and does on its canvas. */
export interface ParticipantsView {
  /** Whether the board holds the shape `id`, and it isn't deleted. */
  holds(id: string): boolean;
  /** Scrolls and zooms the canvas to show the shapes `ids`. */
  goTo(ids: readonly string[]): void;
  /** Calls `handler` after each change of the board's shapes, and returns a function that stops it. */
  onShapes(handler: () => void): () => void;
}

/**
 * Fills `list` with an item for each other participant of `awareness` that has a name, and fills it
 * again after each awareness change, and each change of the board's shapes, that changes what it
 * shows. An agent's item holds the Agent badge, reads "<name> is drawing..." while the agent works,
 * and holds a Go to button while the board holds a shape that the agent last added or changed, which
 * shows those shapes. The list hides while it doesn't hold anyone. Returns a function that stops it.
 */
export function bindParticipants(list: HTMLElement, awareness: Awareness, view: ParticipantsView): () => void {
  let shown: string | undefined;
  const fill = (): void => {
    const participants = participantsFrom(awareness.getStates(), awareness.clientID).map((participant) => ({
      ...participant,
      shapes: participant.shapes.filter((id) => view.holds(id)),
    }));
    // A pointer's move changes a peer's state without changing the list, which then stays as it is.
    const key = JSON.stringify(participants);
    if (key === shown) return;
    shown = key;
    list.replaceChildren(...participants.map((participant) => item(list.ownerDocument, participant, view)));
    list.hidden = participants.length === 0;
  };
  awareness.on('change', fill);
  const stopShapes = view.onShapes(fill);
  fill();
  return () => {
    awareness.off('change', fill);
    stopShapes();
  };
}

function item(document: Document, participant: Participant, view: ParticipantsView): HTMLLIElement {
  const entry = document.createElement('li');
  entry.className = 'chalkline-participant';
  entry.dataset.client = String(participant.client);
  const line = document.createElement('span');
  line.className = 'chalkline-participant-name';
  line.textContent = participantLine(participant);
  entry.append(line);
  if (participant.agent) {
    const badge = document.createElement('span');
    badge.className = 'chalkline-participant-badge';
    badge.textContent = 'Agent';
    entry.append(badge);
  }
  const { shapes } = participant;
  if (shapes.length > 0) {
    const go = document.createElement('button');
    go.type = 'button';
    go.className = 'chalkline-button chalkline-participant-go';
    go.textContent = 'Go to';
    go.title = `Show the shapes ${participant.name} last drew`;
    go.addEventListener('click', () => view.goTo(shapes));
    entry.append(go);
  }
  return entry;
}
