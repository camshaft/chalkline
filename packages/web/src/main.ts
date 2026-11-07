import '@excalidraw/excalidraw/index.css';
import { Awareness, connectAwareness, connectDoc, relaysFromAddress, transcriptOf, trysteroTransport } from '@chalkline/sync';
import { joinBoardRoom } from '@chalkline/sync/join';
import {
  CaptureUpdateAction,
  convertToExcalidrawElements,
  Excalidraw,
  loadFromBlob,
  serializeAsJSON,
} from '@excalidraw/excalidraw';
import type { OrderedExcalidrawElement } from '@excalidraw/excalidraw/element/types';
import type { BinaryFileData, Collaborator, ExcalidrawImperativeAPI, SocketId } from '@excalidraw/excalidraw/types';
import { selfId } from '@trystero-p2p/nostr';
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import * as Y from 'yjs';
import { bindElements } from './binding';
import { addOpened, boardFileName, connectFileControls, OPENED } from './board-file';
import { loadSettings, roomOptions, type ConnectionSettings, type SettingsStorage } from './connection';
import { bindStatusBadge, connectControlsToggle, controlsAttacher, followKeyboard } from './controls';
import { keepDrawingSpaceChanges, keptDrawingSpace } from './drawing-space';
import { bindFiles, writeFiles } from './files';
import { keepBoard, storeName, type KeptBoard } from './keep';
import { Followed } from './followed';
import { ChalklineMenu, type FileCommands } from './menu';
import { bindRequests, mermaidConverter } from './mermaid';
import {
  bindPresence,
  keepName,
  participantName,
  readPresence,
  setName,
  type Button,
  type NameStorage,
  type Pointer,
} from './presence';
import { connectionReport, type ConnectionReport } from './report';
import type { RoomSecrets } from './room';
import {
  boardInAddress,
  chooseRoom,
  newBoardFragment,
  reloadOnRoomChange,
  windowAddress,
  type PageAddress,
} from './room-links';
import { connectSettingsButton, settingsOpener } from './settings-panel';
import { recognitionClass, recognitionLanguage, speechControl, type Speech } from './speech';
import { statusLine, watchedPeerConnection } from './status';
import { bindTranscriptPanel } from './transcript-panel';

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
  /** The copy of the board that this browser keeps, or null where the browser doesn't let the page keep one. */
  kept: KeptBoard | null;
  /** The board's transcript, which the page shows as its chat: each final speech result, typed message and agent's post, in order. */
  transcript: Y.Array<unknown>;
  /** This browser's speech, which the microphone button turns on and off. */
  speech: Speech;
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

function pageButton(id: string): HTMLButtonElement {
  const found = pageElement(id);
  if (!(found instanceof HTMLButtonElement)) throw new Error(`the page's #${id} isn't a button`);
  return found;
}

/** Shows the join screen in the board's place until a person chooses a board. */
async function boardFromJoinScreen(address: PageAddress, status: HTMLElement): Promise<RoomSecrets> {
  status.textContent = 'Start a new board, or join one from its link.';
  const secrets = await chooseRoom(pageElement('app'), address);
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

/** Keeps the room's board in this browser's IndexedDB, or returns null where the browser doesn't let the page. */
async function keepInBrowser(doc: Y.Doc, secrets: RoomSecrets): Promise<KeptBoard | null> {
  try {
    return keepBoard(doc, await storeName(secrets));
  } catch (error) {
    console.warn("chalkline: this browser doesn't keep a copy of the board", error);
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
  bindStatusBadge(pageButton('status-badge'), status);
  connectControlsToggle(pageButton('controls-toggle'), pageElement('controls'));
  // The chat's sheet on a phone sits above the on-screen keyboard, which the page reads from the visual viewport.
  followKeyboard(window, document.documentElement);
  const storage = browserStorage();
  const settings = loadSettings(storage);
  const line = statusLine(status, settings);
  const settingsOptions = { settings, storage, reload: () => window.location.reload() };
  // The controls' Connection settings button opens the settings on the join screen, and the main menu's
  // item opens them once the board is open.
  connectSettingsButton(pageElement('settings-button'), pageElement('settings'), settingsOptions);
  const openSettings = settingsOpener(pageElement('settings'), settingsOptions);
  const address = windowAddress(window);
  const doc = new Y.Doc();
  const awareness = new Awareness(doc);
  bindNameField(pageInput('name'), awareness, storage ?? undefined);
  const secrets = boardInAddress(address) ?? (await boardFromJoinScreen(address, status));
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
  // The copy this browser kept goes into the document as it loads, and the sync adapter sends the
  // peers each of its changes they lack, such as the shapes drawn while offline.
  const kept = await keepInBrowser(doc, secrets);

  const showPeers = () => line.showPeers(transport.peers().length);
  transport.onPeerJoin(showPeers);
  transport.onPeerLeave(showPeers);
  showPeers();

  const pointerHandlers = new Set<(pointer: Pointer, button: Button) => void>();
  // The menu's Save file and Open file items show once the board's file controls are connected, below.
  const fileCommands = new Followed<FileCommands | null>(null);
  let mounted: ExcalidrawImperativeAPI | null = null;
  const attachControls = controlsAttacher(pageElement('controls'));
  const api = await new Promise<ExcalidrawImperativeAPI>((resolve) => {
    createRoot(pageElement('app')).render(
      createElement(Excalidraw, {
        excalidrawAPI: (excalidraw) => {
          mounted = excalidraw;
          resolve(excalidraw);
        },
        onPointerUpdate: ({ pointer, button }) => {
          for (const handler of pointerHandlers) handler(pointer, button);
        },
        // The canvas's background and grid are this browser's, kept as the name is, and not the board's.
        initialData: { appState: keptDrawingSpace(storage ?? undefined) },
        // The page's controls go in the space Excalidraw keeps for its top-right area: below that area's
        // buttons on a desktop, and on the screen's left edge on a phone.
        renderTopRightUI: (isMobile) =>
          createElement('div', {
            className: isMobile ? 'chalkline-host chalkline-host--mobile' : 'chalkline-host',
            ref: attachControls,
          }),
        // The main menu's Save file and Open file items save and open the board. Excalidraw's own Open
        // replaces the whole scene on this page alone, so the menu leaves out Excalidraw's Open and Save.
        UIOptions: { canvasActions: { loadScene: false, export: false, saveToActiveFile: false } },
        children: createElement(ChalklineMenu, {
          actions: {
            // Setting the fragment adds a history entry, so the Back button returns to the board before.
            newBoard: () => {
              window.location.hash = newBoardFragment();
            },
            connectionSettings: openSettings,
            files: fileCommands,
            grid: () => mounted?.getAppState().gridModeEnabled ?? false,
            setGrid: (shown) =>
              mounted?.updateScene({
                appState: { gridModeEnabled: shown },
                captureUpdate: CaptureUpdateAction.EVENTUALLY,
              }),
          },
        }),
      }),
    );
  });
  // Each change of the canvas's background or grid is kept for this browser's next visit.
  keepDrawingSpaceChanges(storage ?? undefined, {
    current: () => {
      const { viewBackgroundColor, gridModeEnabled } = api.getAppState();
      return { viewBackgroundColor, gridModeEnabled };
    },
    onChange: (handler) => api.onChange(() => handler()),
  });
  const shared = doc.getMap<OrderedExcalidrawElement>('elements');
  bindElements(shared, {
    elements: () => api.getSceneElementsIncludingDeleted(),
    replace: (elements) => api.updateScene({ elements, captureUpdate: CaptureUpdateAction.NEVER }),
    onChange: (handler) => api.onChange(() => handler()),
  });
  // Each image's picture goes in the board's map of files, which reaches every peer and the kept copy
  // as the shapes do, so that an image opened, dropped or pasted on one page shows on every page.
  const files = doc.getMap<BinaryFileData>('files');
  bindFiles(files, {
    files: () => api.getFiles(),
    add: (added) => api.addFiles(added),
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
  // The page converts each Mermaid request that the agent's helper writes, since the conversion
  // runs in a browser. mermaid-to-excalidraw loads with the first request, so a board without one
  // doesn't load it.
  bindRequests(
    doc,
    awareness,
    mermaidConverter(
      async (text) => (await import('@excalidraw/mermaid-to-excalidraw')).parseMermaidToExcalidraw(text),
      (skeletons) =>
        convertToExcalidrawElements(skeletons as Parameters<typeof convertToExcalidrawElements>[0], {
          regenerateIds: true,
        }),
    ),
  );
  fileCommands.set(
    connectFileControls(
      { input: pageInput('open-file'), dropTarget: pageElement('app') },
      {
        save: () => serializeAsJSON(api.getSceneElements(), api.getAppState(), api.getFiles(), 'local'),
        fileName: () => boardFileName(secrets.room),
        open: async (file) => {
          // Excalidraw reads its own files, and files of its older versions, and checks that each holds a board.
          const scene = await loadFromBlob(file, null, null);
          const added = addOpened(shared, scene.elements);
          writeFiles(files, Object.values(scene.files), OPENED);
          status.textContent = `Opened ${file.name}: ${added.length} ${added.length === 1 ? 'shape' : 'shapes'} added to the board.`;
        },
        onError: (file, error) => {
          console.warn(`chalkline: couldn't open ${file.name}`, error);
          status.textContent = `${file.name} couldn't be opened: ${error instanceof Error ? error.message : String(error)}`;
        },
      },
    ),
  );
  // The board's transcript, which the page shows as its chat, holds each participant's final speech results and
  // typed messages, and the agent's posts. Speech stays off until the person presses the microphone button, and
  // each final result, as each typed message, goes on the transcript under the name the others see.
  const transcript = transcriptOf(doc);
  const speaker = () => readPresence(awareness.getLocalState())?.name ?? 'Someone';
  const speech = speechControl({
    Class: recognitionClass(window),
    lang: recognitionLanguage(navigator.language),
    transcript,
    speaker,
  });
  const panel = bindTranscriptPanel(
    { mic: pageButton('mic'), opener: pageButton('transcript-button'), panel: pageElement('transcript') },
    transcript,
    { toggle: () => void speech.toggle(), agree: () => void speech.agree(), decline: () => speech.decline() },
    { speaker },
  );
  panel.show(speech.state());
  speech.onState((state) => panel.show(state));
  // The microphone and Chat buttons show once the board they act on is open, and stay hidden on the
  // join screen, as the menu's Save file and Open file items do.
  pageElement('mic').hidden = false;
  pageElement('transcript-button').hidden = false;

  const handle: ChalklineHandle = {
    room: secrets.room,
    selfId,
    doc,
    awareness,
    api,
    settings,
    kept,
    transcript,
    speech,
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
