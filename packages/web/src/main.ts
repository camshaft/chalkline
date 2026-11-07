import '@excalidraw/excalidraw/index.css';
import { Awareness, connectAwareness, connectDoc, relaysFromAddress, trysteroTransport } from '@chalkline/sync';
import { joinBoardRoom } from '@chalkline/sync/join';
import { CaptureUpdateAction, Excalidraw } from '@excalidraw/excalidraw';
import type { OrderedExcalidrawElement } from '@excalidraw/excalidraw/element/types';
import type { Collaborator, ExcalidrawImperativeAPI, SocketId } from '@excalidraw/excalidraw/types';
import { selfId } from '@trystero-p2p/nostr';
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import * as Y from 'yjs';
import { bindElements } from './binding';
import { loadSettings, roomOptions, type ConnectionSettings, type SettingsStorage } from './connection';
import { bindPresence, keepName, participantName, setName, type Button, type NameStorage, type Pointer } from './presence';
import { connectionReport, type ConnectionReport } from './report';
import type { RoomSecrets } from './room';
import {
  boardInAddress,
  chooseRoom,
  connectNewBoardButton,
  reloadOnRoomChange,
  windowAddress,
  type PageAddress,
} from './room-links';
import { connectSettingsButton } from './settings-panel';
import { statusLine, watchedPeerConnection } from './status';

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

/**
 * Shows the join screen in the board's place until a person chooses a board,
 * and hides the bar's New board button meanwhile, since the screen holds one.
 */
async function boardFromJoinScreen(address: PageAddress, status: HTMLElement, newBoard: HTMLElement): Promise<RoomSecrets> {
  newBoard.hidden = true;
  status.textContent = 'Start a new board, or join one from its link.';
  const secrets = await chooseRoom(pageElement('app'), address);
  newBoard.hidden = false;
  status.textContent = 'Joining the room...';
  return secrets;
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
  const storage = browserStorage();
  const settings = loadSettings(storage);
  const line = statusLine(status, settings);
  connectSettingsButton(pageElement('settings-button'), pageElement('settings'), {
    settings,
    storage,
    reload: () => window.location.reload(),
  });
  const address = windowAddress(window);
  const newBoard = pageElement('new-board');
  // Setting the fragment adds a history entry, so the Back button returns to the board before.
  connectNewBoardButton(newBoard, (fragment) => {
    window.location.hash = fragment;
  });
  const doc = new Y.Doc();
  const awareness = new Awareness(doc);
  bindNameField(pageInput('name'), awareness, storage ?? undefined);
  const secrets = boardInAddress(address) ?? (await boardFromJoinScreen(address, status, newBoard));
  // The page joins its board only as it loads, so an address that names another board, or none, loads it again.
  reloadOnRoomChange(address, secrets, () => window.location.reload());
  // A page that the local-network mode serves names that machine's relay in its address, and finds
  // the other participants through it in place of the Nostr relays.
  const relays = relaysFromAddress(window.location.href);
  // Trystero makes each connection to a peer with `rtcPolyfill`. This class says as soon as one can't open,
  // where Trystero's onJoinError says so only once one of its own timers runs out.
  const rtcPolyfill = watchedPeerConnection(RTCPeerConnection, (failure) => {
    console.warn("chalkline: a connection to a peer can't open", failure);
    line.showFailure();
  });
  const room = joinBoardRoom({ ...roomOptions(secrets, settings), rtcPolyfill }, secrets.room, relays, {
    onJoinError: ({ peerId, error }) => {
      console.warn(`chalkline: peer ${peerId} couldn't connect: ${error}`);
      line.showFailure();
    },
  });
  const transport = trysteroTransport(room);
  // Connect the document and the awareness before anything awaits after the join, so that a peer's first messages find their handlers.
  const onSendError = (error: unknown) => console.warn('chalkline: a send failed', error);
  connectDoc(doc, transport, { onSendError });
  connectAwareness(awareness, transport, { onSendError });

  const showPeers = () => line.showPeers(transport.peers().length);
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
