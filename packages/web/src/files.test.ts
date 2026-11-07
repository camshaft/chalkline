import 'fake-indexeddb/auto';
import { connectDoc, MemoryNetwork } from '@chalkline/sync';
import { afterEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { addOpened, OPENED } from './board-file';
import { bindFiles, LOCAL_FILES, replacesFile, writeFiles, type FileCanvas } from './files';
import { keepBoard, type KeptBoard } from './keep';

interface Picture {
  id: string;
  mimeType: string;
  dataURL: string;
  created: number;
  version?: number;
}

function picture(id: string, version?: number, data = id): Picture {
  const file = { id, mimeType: 'image/png', dataURL: `data:image/png;base64,${btoa(data)}`, created: 1 };
  return version === undefined ? file : { ...file, version };
}

interface Shape {
  id: string;
  type: string;
  version: number;
  versionNonce: number;
  index: string | null;
  fileId?: string;
}

function image(id: string, fileId: string): Shape {
  return { id, type: 'image', version: 1, versionNonce: 1, index: 'a0', fileId };
}

class FakeFileCanvas implements FileCanvas<Picture> {
  current: Record<string, Picture> = {};
  readonly added: Picture[][] = [];
  private readonly handlers = new Set<() => void>();

  files(): Readonly<Record<string, Picture>> {
    return this.current;
  }

  /** Adds the files, then reports a change, as a canvas that redraws once it holds new files does. */
  add(files: Picture[]): void {
    this.added.push(files);
    this.current = { ...this.current, ...Object.fromEntries(files.map((file) => [file.id, file])) };
    this.changed();
  }

  onChange(handler: () => void): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  /** A person pastes or drops a picture: the canvas gains its file, then tells its listeners. */
  paste(file: Picture): void {
    this.current = { ...this.current, [file.id]: file };
    this.changed();
  }

  private changed(): void {
    for (const handler of this.handlers) handler();
  }
}

/** A board's shared map of files, bound to a canvas, and the origin of each transaction that changes the board. */
function bound(doc = new Y.Doc(), canvas = new FakeFileCanvas()) {
  const shared = doc.getMap<Picture>('files');
  const stop = bindFiles(shared, canvas);
  const origins: unknown[] = [];
  doc.on('update', (_update: Uint8Array, origin: unknown) => origins.push(origin));
  return { doc, shared, canvas, stop, origins };
}

function fromPeer(doc: Y.Doc, ...files: Picture[]): void {
  const peer = new Y.Doc();
  Y.applyUpdate(peer, Y.encodeStateAsUpdate(doc));
  for (const file of files) peer.getMap<Picture>('files').set(file.id, file);
  Y.applyUpdate(doc, Y.encodeStateAsUpdate(peer, Y.encodeStateVector(doc)), 'peer');
}

describe('replacesFile', () => {
  it('takes a file where there is no current copy, or where its version is later', () => {
    expect(replacesFile(picture('cat'), undefined)).toBe(true);
    expect(replacesFile(picture('cat', 2), picture('cat', 1))).toBe(true);
    expect(replacesFile(picture('cat', 2), picture('cat'))).toBe(true);
  });

  it('keeps a current copy of the same or a later version, and counts a file without a version as version 1', () => {
    expect(replacesFile(picture('cat', 3, 'other'), picture('cat', 3))).toBe(false);
    expect(replacesFile(picture('cat', 1), picture('cat'))).toBe(false);
    expect(replacesFile(picture('cat'), picture('cat', 2))).toBe(false);
  });
});

describe('writeFiles', () => {
  it('writes a copy of each file the map lacks or holds an earlier version of, in one transaction', () => {
    const doc = new Y.Doc();
    const shared = doc.getMap<Picture>('files');
    shared.set('same', picture('same'));
    shared.set('older', picture('older'));
    const origins: unknown[] = [];
    doc.on('update', (_update: Uint8Array, origin: unknown) => origins.push(origin));
    const later = picture('older', 2, 'redrawn');
    const added = picture('new');

    const written = writeFiles(shared, [picture('same'), later, added], OPENED);

    expect(written).toEqual([later, added]);
    expect(shared.get('older')).toEqual(later);
    expect(shared.get('new')).toEqual(added);
    expect(shared.get('new')).not.toBe(added);
    expect(shared.get('same')).toEqual(picture('same'));
    expect(origins).toEqual([OPENED]);
  });

  it("doesn't change the board where the map holds each file already", () => {
    const doc = new Y.Doc();
    const shared = doc.getMap<Picture>('files');
    shared.set('cat', picture('cat', 2));
    const origins: unknown[] = [];
    doc.on('update', (_update: Uint8Array, origin: unknown) => origins.push(origin));

    expect(writeFiles(shared, [picture('cat', 2), picture('cat')], OPENED)).toEqual([]);
    expect(origins).toEqual([]);
  });
});

describe('bindFiles', () => {
  it('shares a copy of the picture of an image that a person pastes or drops', () => {
    const { shared, canvas, origins } = bound();
    const cat = picture('cat');

    canvas.paste(cat);

    expect(shared.get('cat')).toEqual(cat);
    expect(shared.get('cat')).not.toBe(cat);
    expect(origins).toEqual([LOCAL_FILES]);
  });

  it("adds a peer's picture to the canvas without writing it back", () => {
    const { doc, canvas, origins } = bound();
    const cat = picture('cat');

    fromPeer(doc, cat);

    expect(canvas.added).toEqual([[cat]]);
    expect(canvas.current).toEqual({ cat });
    expect(origins).toEqual(['peer']);
  });

  it("takes a peer's later version of a picture in place of the canvas's", () => {
    const { doc, shared, canvas } = bound();
    canvas.paste(picture('cat', 1, 'first'));

    fromPeer(doc, picture('cat', 2, 'second'));

    expect(canvas.current).toEqual({ cat: picture('cat', 2, 'second') });
    expect(shared.get('cat')).toEqual(picture('cat', 2, 'second'));
  });

  it("adds the map's files to the canvas and the canvas's files to the map as it starts, the later version of each", () => {
    const doc = new Y.Doc();
    const shared = doc.getMap<Picture>('files');
    shared.set('kept', picture('kept'));
    shared.set('cat', picture('cat', 1, 'first'));
    const canvas = new FakeFileCanvas();
    canvas.current = { mine: picture('mine'), cat: picture('cat', 2, 'second') };

    bound(doc, canvas);

    expect(canvas.current).toEqual({ mine: picture('mine'), cat: picture('cat', 2, 'second'), kept: picture('kept') });
    expect(shared.toJSON()).toEqual({ mine: picture('mine'), cat: picture('cat', 2, 'second'), kept: picture('kept') });
  });

  it('stops following both sides once stopped', () => {
    const { doc, shared, canvas, stop } = bound();
    stop();

    canvas.paste(picture('mine'));
    fromPeer(doc, picture('theirs'));

    expect(shared.has('mine')).toBe(false);
    expect(canvas.current).toEqual({ mine: picture('mine') });
  });
});

let names = 0;
/** A database name that no other test uses. */
function freshName(): string {
  names += 1;
  return `test-files-${names}`;
}

const kept = new Set<KeptBoard>();
afterEach(async () => {
  await Promise.all([...kept].map((board) => board.stop()));
  kept.clear();
});

/** A page: its board's shared maps, and a canvas whose files the binding keeps in step with the board's. */
function page(doc = new Y.Doc()) {
  const canvas = new FakeFileCanvas();
  const files = doc.getMap<Picture>('files');
  bindFiles(files, canvas);
  return { doc, canvas, files, elements: doc.getMap<Shape>('elements') };
}

/** A page that keeps its board in the database `name`, as the page does, once the copy kept there has loaded. */
async function keptPage(name: string, doc = new Y.Doc()) {
  const shown = page(doc);
  const board = keepBoard(doc, name);
  kept.add(board);
  await board.loaded;
  return { ...shown, kept: board };
}

/** The page closes: its database closes once each change it kept is written. */
async function close(board: KeptBoard): Promise<void> {
  kept.delete(board);
  await board.stop();
}

describe("an image's picture", () => {
  it("opened on one page shows on a peer's page, and on the page again after a reload from the kept copy", async () => {
    const name = freshName();
    const network = new MemoryNetwork();
    const adaDoc = new Y.Doc();
    connectDoc(adaDoc, network.join('ada'));
    const ada = await keptPage(name, adaDoc);
    const graceDoc = new Y.Doc();
    connectDoc(graceDoc, network.join('grace'));
    const grace = page(graceDoc);
    network.flush();

    // Ada opens a file that holds an image and its picture, and the page writes both to the board, as Open file does.
    const cat = picture('cat-picture');
    addOpened(ada.elements, [image('cat', 'cat-picture')]);
    writeFiles(ada.files, [cat], OPENED);
    network.flush();

    expect(ada.canvas.current).toEqual({ 'cat-picture': cat });
    expect(grace.elements.get('cat')?.fileId).toBe('cat-picture');
    expect(grace.canvas.current).toEqual({ 'cat-picture': cat });

    // Ada reloads the page with no one else connected: the picture comes back from the copy the browser kept.
    network.leave('ada');
    await close(ada.kept);
    const back = await keptPage(name);

    expect(back.elements.get('cat')?.fileId).toBe('cat-picture');
    expect(back.canvas.current).toEqual({ 'cat-picture': cat });
  });

  it("pasted on one page shows on a peer's page, and on the page again after a reload from the kept copy", async () => {
    const name = freshName();
    const network = new MemoryNetwork();
    const adaDoc = new Y.Doc();
    connectDoc(adaDoc, network.join('ada'));
    const ada = await keptPage(name, adaDoc);
    const graceDoc = new Y.Doc();
    connectDoc(graceDoc, network.join('grace'));
    const grace = page(graceDoc);
    network.flush();

    const dog = picture('dog-picture');
    ada.canvas.paste(dog);
    network.flush();

    expect(grace.canvas.current).toEqual({ 'dog-picture': dog });

    network.leave('ada');
    await close(ada.kept);
    const back = await keptPage(name);

    expect(back.canvas.current).toEqual({ 'dog-picture': dog });
  });
});
