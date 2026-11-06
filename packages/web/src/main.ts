import '@excalidraw/excalidraw/index.css';
import { Awareness, connectAwareness, connectDoc, trysteroTransport } from '@chalkline/sync';
import { CaptureUpdateAction, Excalidraw } from '@excalidraw/excalidraw';
import type { OrderedExcalidrawElement } from '@excalidraw/excalidraw/element/types';
import type { Collaborator, ExcalidrawImperativeAPI, SocketId } from '@excalidraw/excalidraw/types';
import { joinRoom, selfId } from '@trystero-p2p/nostr';
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import * as Y from 'yjs';
import { bindElements } from './binding';
import { joinErrorText, loadSettings, roomOptions, type ConnectionSettings, type SettingsStorage } from './connection';
import { bindPresence, keepName, participantName, setName, type Button, type NameStorage, type Pointer } from './presence';
import { connectionReport, type ConnectionReport } from './report';
import { newRoomSecrets, parseRoomFragment, roomFragment, type RoomSecrets } from './room';
import { connectSettingsButton } from './settings-panel';

/** What the page shows on `window.chalkline`, for the live probe and for debugging. */
export interface ChalklineHandle {
  room: string;
  selfId: string;
  doc: Y.Doc;
  /** Each participant's name, pointer and selection, which the page shares outside `doc`. */
  awareness: Awareness;
  api: ExcalidrawImperativeAPI;
  /** The connection settings the page joined the room with. */
  settings: ConnectionSettings;
  peers(): string[];
  onPeerLeave(handler: (peerId: string) => void): () => void;
  /** The connection to each peer, by peer id. */
  connectionReports(): Promise<Record<string, ConnectionReport>>;
  leave(): Promise<void>;
}

declare global {
  interface Window {
    chalkline?: ChalklineHandle;
    chalklineReady?: Promise<ChalklineHandle>;
  }
}

function pageElement(id: string): HTMLElement {
  const found = document.getElementById(id);
  if (found === null) throw new Error(`the page lacks #${id}`);
  return found;
}

function pageInput(id: string): HTMLInputElement {
  const found = pageElement(id);
  if (!(found instanceof HTMLInputElement)) throw new Error(`the page's #${id} isn't an input`);
  return found;
}

/** The room the link names, or a new room, whose link then replaces the page's address. */
function roomFromLink(): RoomSecrets {
  const secrets = parseRoomFragment(window.location.hash);
  if (secrets !== null) return secrets;
  const fresh = newRoomSecrets();
  window.history.replaceState(null, '', roomFragment(fresh));
  return fresh;
}

/** The browser's `localStorage`, or null where the browser doesn't let the page use it. */
function browserStorage(): SettingsStorage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/**
 * Shows this participant's name in the name field, and shares each name typed
 * there. A field left empty keeps the last name, and shows it again once the
 * person leaves the field.
 */
function bindNameField(field: HTMLInputElement, awareness: Awareness, storage: NameStorage | undefined): void {
  let name = participantName(storage);
  setName(awareness, name);
  field.value = name;
  field.addEventListener('input', () => {
    const typed = field.value.trim();
    if (typed === '') return;
    name = typed;
    keepName(storage, name);
    setName(awareness, name);
  });
  field.addEventListener('change', () => {
    if (field.value.trim() === '') field.value = name;
  });
}

async function start(): Promise<ChalklineHandle> {
  const status = pageElement('status');
  const secrets = roomFromLink();
  const storage = browserStorage();
  const settings = loadSettings(storage);
  connectSettingsButton(pageElement('settings-button'), pageElement('settings'), {
    settings,
    storage,
    reload: () => window.location.reload(),
  });
  const doc = new Y.Doc();
  const awareness = new Awareness(doc);
  bindNameField(pageInput('name'), awareness, storage ?? undefined);
  const room = joinRoom(roomOptions(secrets, settings), secrets.room, {
    onJoinError: ({ peerId, error }) => {
      console.warn(`chalkline: peer ${peerId} couldn't connect: ${error}`);
      status.textContent = joinErrorText(settings);
    },
  });
  const transport = trysteroTransport(room);
  // Connect the document and the awareness before anything awaits, so that a peer's first messages find their handlers.
  const onSendError = (error: unknown) => console.warn('chalkline: a send failed', error);
  connectDoc(doc, transport, { onSendError });
  connectAwareness(awareness, transport, { onSendError });

  const showPeers = () => {
    const count = transport.peers().length;
    status.textContent =
      count === 0
        ? "No one else is here yet. Share this page's link to invite people."
        : `${count} other ${count === 1 ? 'person is' : 'people are'} on this board.`;
  };
  transport.onPeerJoin(showPeers);
  transport.onPeerLeave(showPeers);
  showPeers();

  const pointerHandlers = new Set<(pointer: Pointer, button: Button) => void>();
  const api = await new Promise<ExcalidrawImperativeAPI>((resolve) => {
    createRoot(pageElement('app')).render(
      createElement(Excalidraw, {
        excalidrawAPI: resolve,
        onPointerUpdate: ({ pointer, button }) => {
          for (const handler of pointerHandlers) handler(pointer, button);
        },
      }),
    );
  });
  bindElements(doc.getMap<OrderedExcalidrawElement>('elements'), {
    elements: () => api.getSceneElementsIncludingDeleted(),
    replace: (elements) => api.updateScene({ elements, captureUpdate: CaptureUpdateAction.NEVER }),
    onChange: (handler) => api.onChange(() => handler()),
  });
  bindPresence(awareness, {
    // Excalidraw draws each collaborator's cursor, name and selection, and lists them in its user list.
    show: (collaborators) =>
      api.updateScene({
        collaborators: new Map(
          [...collaborators].map(([id, collaborator]): [SocketId, Collaborator] => [id as SocketId, collaborator]),
        ),
      }),
    selection: () => api.getAppState().selectedElementIds,
    onChange: (handler) => api.onChange(() => handler()),
    onPointer: (handler) => {
      pointerHandlers.add(handler);
      return () => {
        pointerHandlers.delete(handler);
      };
    },
  });

  const handle: ChalklineHandle = {
    room: secrets.room,
    selfId,
    doc,
    awareness,
    api,
    settings,
    peers: () => transport.peers(),
    onPeerLeave: (handler) => transport.onPeerLeave(handler),
    connectionReports: async () => {
      const reports: Record<string, ConnectionReport> = {};
      for (const [peerId, connection] of Object.entries(room.getPeers())) {
        reports[peerId] = await connectionReport(connection);
      }
      return reports;
    },
    leave: () => room.leave(),
  };
  window.chalkline = handle;
  return handle;
}

window.chalklineReady = start();
window.chalklineReady.catch((error: unknown) => {
  const status = document.getElementById('status');
  if (status !== null) {
    status.textContent = `The board couldn't start: ${error instanceof Error ? error.message : String(error)}`;
  }
  console.error(error);
});
