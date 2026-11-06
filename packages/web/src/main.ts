import '@excalidraw/excalidraw/index.css';
import { connectDoc, trysteroTransport } from '@chalkline/sync';
import { CaptureUpdateAction, Excalidraw } from '@excalidraw/excalidraw';
import type { OrderedExcalidrawElement } from '@excalidraw/excalidraw/element/types';
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';
import { joinRoom, selfId } from '@trystero-p2p/nostr';
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import * as Y from 'yjs';
import { bindElements } from './binding';
import { connectionReport, type ConnectionReport } from './report';
import { APP_ID, newRoomSecrets, parseRoomFragment, roomFragment, type RoomSecrets } from './room';

/** What the page shows on `window.chalkline`, for the live probe and for debugging. */
export interface ChalklineHandle {
  room: string;
  selfId: string;
  doc: Y.Doc;
  api: ExcalidrawImperativeAPI;
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

/** The room the link names, or a new room, whose link then replaces the page's address. */
function roomFromLink(): RoomSecrets {
  const secrets = parseRoomFragment(window.location.hash);
  if (secrets !== null) return secrets;
  const fresh = newRoomSecrets();
  window.history.replaceState(null, '', roomFragment(fresh));
  return fresh;
}

async function start(): Promise<ChalklineHandle> {
  const status = pageElement('status');
  const secrets = roomFromLink();
  const doc = new Y.Doc();
  const room = joinRoom({ appId: APP_ID, password: secrets.key }, secrets.room, {
    onJoinError: ({ error }) => {
      status.textContent = `A peer couldn't connect: ${error}`;
    },
  });
  const transport = trysteroTransport(room);
  // Connect the document before anything awaits, so that a peer's first messages find their handler.
  connectDoc(doc, transport, { onSendError: (error) => console.warn('chalkline: a send failed', error) });

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

  const api = await new Promise<ExcalidrawImperativeAPI>((resolve) => {
    createRoot(pageElement('app')).render(createElement(Excalidraw, { excalidrawAPI: resolve }));
  });
  bindElements(doc.getMap<OrderedExcalidrawElement>('elements'), {
    elements: () => api.getSceneElementsIncludingDeleted(),
    replace: (elements) => api.updateScene({ elements, captureUpdate: CaptureUpdateAction.NEVER }),
    onChange: (handler) => api.onChange(() => handler()),
  });

  const handle: ChalklineHandle = {
    room: secrets.room,
    selfId,
    doc,
    api,
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
