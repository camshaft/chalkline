import type * as Y from 'yjs';

/** The fields of an Excalidraw file, such as the picture of an image, that the board reads. */
export interface BoardFile {
  readonly id: string;
  /** The file's data, as a data URL. */
  readonly dataURL: string;
  /** The version of the file's data, where Excalidraw set one. A file without one is version 1. */
  readonly version?: number;
}

/** The transaction origin of the files binding's writes to the shared map. */
export const LOCAL_FILES = Symbol('chalkline.local-files');

/** Whether `candidate` takes the place of `current`: where there isn't a current copy, or `candidate`'s version is later. */
export function replacesFile(candidate: BoardFile, current: BoardFile | undefined): boolean {
  return current === undefined || (candidate.version ?? 1) > (current.version ?? 1);
}

/**
 * Writes a copy of each of `files` that the shared map lacks, or holds an
 * earlier version of, to the map, in one transaction with `origin`. Returns
 * the files written.
 */
export function writeFiles<T extends BoardFile>(shared: Y.Map<T>, files: Iterable<T>, origin: unknown): T[] {
  const doc = shared.doc;
  if (doc === null) throw new Error('writeFiles needs a map that belongs to a Y.Doc');
  const written = [...files].filter((file) => replacesFile(file, shared.get(file.id))).map((file) => ({ ...file }));
  if (written.length > 0) {
    doc.transact(() => {
      for (const file of written) shared.set(file.id, file);
    }, origin);
  }
  return written;
}

/** The canvas's files, which `bindFiles` keeps in step with the shared map. */
export interface FileCanvas<T> {
  /** Each file the canvas holds, by its id. */
  files(): Readonly<Record<string, T>>;
  /** Adds `files` to the canvas, as Excalidraw's `addFiles` does. */
  add(files: T[]): void;
  /** Calls `handler` after each change on the canvas, and returns a function that stops it. */
  onChange(handler: () => void): () => void;
}

/**
 * Keeps the canvas's files and the board's shared map of files in step. Each
 * file the canvas gains, such as the picture of an image that a person pastes
 * or drops on the board, goes to the map, and from there to every peer and to
 * the copy of the board that the browser keeps. Each file the map gains from
 * elsewhere, such as a peer, an opened file or the kept copy, goes to the
 * canvas. A file goes either way where the other side lacks it or holds an
 * earlier version of it, and the canvas then adds it as its `add` does.
 * Returns a function that stops the binding.
 */
export function bindFiles<T extends BoardFile>(shared: Y.Map<T>, canvas: FileCanvas<T>): () => void {
  if (shared.doc === null) throw new Error('bindFiles needs a map that belongs to a Y.Doc');

  const push = () => {
    writeFiles(shared, Object.values(canvas.files()), LOCAL_FILES);
  };
  const pull = () => {
    const held = canvas.files();
    const missing = [...shared.values()].filter((file) => replacesFile(file, held[file.id]));
    if (missing.length > 0) canvas.add(missing.map((file) => ({ ...file })));
  };
  const observer = (_event: Y.YMapEvent<T>, transaction: Y.Transaction) => {
    if (transaction.origin !== LOCAL_FILES) pull();
  };

  shared.observe(observer);
  const stop = canvas.onChange(push);
  pull();
  push();
  return () => {
    shared.unobserve(observer);
    stop();
  };
}
