import type * as Y from 'yjs';
import { wins, type VersionedElement } from './binding';
import type { FileCommands } from './menu';

/** The transaction origin of the elements that an opened file adds to the shared map. */
export const OPENED = Symbol('chalkline.opened');

/** The type of an `.excalidraw` file, as Excalidraw writes it. */
export const EXCALIDRAW_TYPE = 'application/vnd.excalidraw+json';

/** The fields of an opened file's element that `addOpened` reads. */
export interface FileElement extends VersionedElement {
  readonly isDeleted?: boolean;
}

/**
 * Adds the elements of an opened file to the board's shared map, in one
 * transaction. An element that the map lacks goes in as the file holds it. An
 * element that the map holds already takes the file's copy: where the map's
 * copy would win, the file's copy goes in with the version after the map's, so
 * that every copy of the board shows the file's. The board's other elements
 * stay as they are. An element that the file marks as deleted, and one whose
 * copy the map holds already, are left out. Returns the elements written.
 */
export function addOpened<T extends FileElement>(shared: Y.Map<T>, elements: readonly T[]): T[] {
  const doc = shared.doc;
  if (doc === null) throw new Error('addOpened needs a map that belongs to a Y.Doc');
  const written = new Map<string, T>();
  for (const element of elements) {
    if (element.isDeleted === true) continue;
    const current = shared.get(element.id);
    if (current === undefined || wins(element, current)) {
      written.set(element.id, structuredClone(element));
    } else if (current.version !== element.version || current.versionNonce !== element.versionNonce) {
      written.set(element.id, { ...structuredClone(element), version: current.version + 1 });
    }
  }
  if (written.size > 0) {
    doc.transact(() => {
      for (const element of written.values()) shared.set(element.id, element);
    }, OPENED);
  }
  return [...written.values()];
}

/**
 * The name of a saved board's file: `chalkline-`, the room's name with each
 * character other than a letter, a digit, `.`, `_` and `-` written as `-`, and
 * `.excalidraw`.
 */
export function boardFileName(room: string): string {
  return `chalkline-${room.replace(/[^A-Za-z0-9._-]/g, '-')}.excalidraw`;
}

/** Makes and revokes the object URLs that Save file's downloads read, as `URL` does. */
export interface ObjectUrls {
  createObjectURL(blob: Blob): string;
  revokeObjectURL(url: string): void;
}

/** What the main menu's Save file and Open file items do with the board. */
export interface FileActions {
  /** The board, as the text of an `.excalidraw` file. */
  save(): string;
  /** The name that Save gives the file. */
  fileName(): string;
  /** Adds the elements of `file` to the board. */
  open(file: File): Promise<void>;
  /** Called where `open` fails, such as for a file that doesn't hold a board. */
  onError(file: File, error: unknown): void;
}

/** The page's parts that open the board's files. */
export interface FileControls {
  /** The file input that Open file asks for a file with. */
  input: HTMLInputElement;
  /** Where a person may drop a file to open it: the canvas. */
  dropTarget: HTMLElement;
}

/**
 * Connects the board's files, and returns the commands of the main menu's
 * Save file and Open file items. Save downloads the board as an
 * `.excalidraw` file, and revokes the object URL of the save before it. Open
 * asks for a file with the file input, and opens the file chosen. A file
 * dropped on the canvas opens the same way, unless it is an image, which the
 * canvas adds as a shape.
 */
export function connectFileControls(controls: FileControls, actions: FileActions, urls: ObjectUrls = URL): FileCommands {
  let previous: string | null = null;
  const save = () => {
    const page = controls.input.ownerDocument;
    const url = urls.createObjectURL(new Blob([actions.save()], { type: EXCALIDRAW_TYPE }));
    if (previous !== null) urls.revokeObjectURL(previous);
    previous = url;
    const link = page.createElement('a');
    link.href = url;
    link.download = actions.fileName();
    link.hidden = true;
    page.body.append(link);
    link.click();
    link.remove();
  };

  const open = (file: File) => {
    actions.open(file).catch((error: unknown) => actions.onError(file, error));
  };
  controls.input.addEventListener('change', () => {
    const file = controls.input.files?.[0];
    // Clear the input, so that choosing the same file again opens it again.
    controls.input.value = '';
    if (file !== undefined) open(file);
  });
  // Excalidraw replaces its whole scene with a board file dropped on it, which would leave the
  // board's other shapes off this page alone, so the page takes the drop before the canvas does.
  controls.dropTarget.addEventListener(
    'drop',
    (event) => {
      const file = event.dataTransfer?.files[0];
      if (file === undefined || file.type.startsWith('image/')) return;
      event.preventDefault();
      event.stopPropagation();
      open(file);
    },
    { capture: true },
  );
  return { save, open: () => controls.input.click() };
}
