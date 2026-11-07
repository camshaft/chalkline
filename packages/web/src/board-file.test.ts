// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { bindElements, type Canvas } from './binding';
import {
  addOpened,
  boardFileName,
  connectFileControls,
  EXCALIDRAW_TYPE,
  OPENED,
  type FileActions,
  type ObjectUrls,
} from './board-file';

interface Shape {
  id: string;
  version: number;
  versionNonce: number;
  index: string | null;
  isDeleted?: boolean;
  label?: string;
}

function shape(id: string, version: number, versionNonce = 1, label?: string): Shape {
  return label === undefined ? { id, version, versionNonce, index: 'a0' } : { id, version, versionNonce, index: 'a0', label };
}

/** A board's shared map, and the origin of each transaction that changes it. */
function board(...shapes: Shape[]) {
  const doc = new Y.Doc();
  const shared = doc.getMap<Shape>('elements');
  for (const element of shapes) shared.set(element.id, element);
  const origins: unknown[] = [];
  doc.on('update', (_update: Uint8Array, origin: unknown) => origins.push(origin));
  return { doc, shared, origins };
}

class FakeCanvas implements Canvas<Shape> {
  current: Shape[] = [];
  private readonly handlers = new Set<() => void>();

  elements(): readonly Shape[] {
    return this.current;
  }

  replace(elements: Shape[]): void {
    this.current = elements;
  }

  onChange(handler: () => void): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  /** A person's edit: the canvas changes, then tells its listeners. */
  edit(elements: Shape[]): void {
    this.current = elements;
    for (const handler of this.handlers) handler();
  }
}

describe('addOpened', () => {
  it("adds the shapes the board lacks as the file holds them, in one transaction, and leaves the board's other shapes", () => {
    const { shared, origins } = board(shape('kept', 1, 1, 'on the board'));
    const opened = shape('new', 3, 5, 'from the file');

    const written = addOpened(shared, [opened]);

    expect(shared.get('new')).toEqual(opened);
    expect(shared.get('new')).not.toBe(opened);
    expect(shared.get('kept')).toEqual(shape('kept', 1, 1, 'on the board'));
    expect(written).toEqual([opened]);
    expect(origins).toEqual([OPENED]);
  });

  it("gives the file's copy of a shape the version after the board's newer copy", () => {
    const { shared } = board(shape('box', 7, 1, 'on the board'));

    addOpened(shared, [shape('box', 2, 9, 'from the file')]);

    expect(shared.get('box')).toEqual(shape('box', 8, 9, 'from the file'));
  });

  it("gives the file's copy the next version where both copies have one version and the board's would win", () => {
    const { shared } = board(shape('box', 4, 1, 'on the board'));

    addOpened(shared, [shape('box', 4, 9, 'from the file')]);

    expect(shared.get('box')).toEqual(shape('box', 5, 9, 'from the file'));
  });

  it("keeps the file's copy as it is where it wins already", () => {
    const { shared } = board(shape('box', 2, 1, 'on the board'));

    addOpened(shared, [shape('box', 3, 1, 'from the file')]);

    expect(shared.get('box')).toEqual(shape('box', 3, 1, 'from the file'));
  });

  it('leaves out the shapes the file marks as deleted, and the copies the board holds already', () => {
    const { shared, origins } = board(shape('same', 2, 4, 'on the board'));

    const written = addOpened(shared, [{ ...shape('gone', 1), isDeleted: true }, shape('same', 2, 4, 'on the board')]);

    expect(written).toEqual([]);
    expect(shared.has('gone')).toBe(false);
    expect(origins).toEqual([]);
  });

  it('shows the opened shapes on the canvas beside its own, and sends them to a peer', () => {
    const { doc, shared } = board();
    const canvas = new FakeCanvas();
    bindElements(shared, canvas);
    canvas.edit([shape('mine', 1)]);
    const peer = new Y.Doc();
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(doc));
    doc.on('update', (update: Uint8Array) => Y.applyUpdate(peer, update));

    addOpened(shared, [shape('opened', 1, 1, 'from the file')]);

    expect(canvas.current.map((element) => element.id).sort()).toEqual(['mine', 'opened']);
    expect([...peer.getMap<Shape>('elements').keys()].sort()).toEqual(['mine', 'opened']);
  });
});

describe('boardFileName', () => {
  it("names the file after the room, and writes each character a file name can't hold as -", () => {
    expect(boardFileName('4f2a9c1e00b3d5f7')).toBe('chalkline-4f2a9c1e00b3d5f7.excalidraw');
    expect(boardFileName('team / stand_up?')).toBe('chalkline-team---stand_up-.excalidraw');
  });
});

class FakeUrls implements ObjectUrls {
  readonly blobs = new Map<string, Blob>();
  readonly revoked: string[] = [];

  createObjectURL(blob: Blob): string {
    const url = `blob:test/${this.blobs.size + 1}`;
    this.blobs.set(url, blob);
    return url;
  }

  revokeObjectURL(url: string): void {
    this.revoked.push(url);
  }
}

function readText(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(blob);
  });
}

function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (found === null) throw new Error(`the page lacks #${id}`);
  return found as T;
}

/** The board's file controls, connected to `actions`, with a canvas inside the drop target, and the menu's commands. */
function connected(actions: Partial<FileActions> = {}) {
  document.body.innerHTML = '<input id="file" type="file" /><div id="app"><div id="canvas"></div></div>';
  const urls = new FakeUrls();
  const all: FileActions = {
    save: () => '{"type":"excalidraw"}',
    fileName: () => 'chalkline-room.excalidraw',
    open: vi.fn<(file: File) => Promise<void>>(() => Promise.resolve()),
    onError: vi.fn<(file: File, error: unknown) => void>(),
    ...actions,
  };
  const input = element<HTMLInputElement>('file');
  const commands = connectFileControls({ input, dropTarget: element('app') }, all, urls);
  return { actions: all, urls, input, commands };
}

function choose(input: HTMLInputElement, file: File): void {
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  input.dispatchEvent(new Event('change'));
}

function dropped(file: File): Event {
  const event = new Event('drop', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'dataTransfer', { value: { files: [file] } });
  return event;
}

afterEach(() => {
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe('connectFileControls', () => {
  it('downloads the board as an .excalidraw file on Save', async () => {
    const clicked: HTMLAnchorElement[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      clicked.push(this);
    });
    const { urls, commands } = connected({ save: () => '{"type":"excalidraw","elements":[]}' });

    commands.save();

    expect(clicked).toHaveLength(1);
    expect(clicked[0]?.download).toBe('chalkline-room.excalidraw');
    expect(clicked[0]?.getAttribute('href')).toBe('blob:test/1');
    expect(document.querySelector('a')).toBeNull();
    const blob = urls.blobs.get('blob:test/1');
    expect(blob?.type).toBe(EXCALIDRAW_TYPE);
    expect(blob === undefined ? null : await readText(blob)).toBe('{"type":"excalidraw","elements":[]}');
  });

  it('revokes the object URL of each save at the next one', () => {
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const { urls, commands } = connected();

    commands.save();
    expect(urls.revoked).toEqual([]);
    commands.save();

    expect(urls.revoked).toEqual(['blob:test/1']);
  });

  it('asks for a file on Open, opens the file chosen, and clears the input for the next choice', () => {
    const { actions, input, commands } = connected();
    const asked = vi.spyOn(input, 'click').mockImplementation(() => {});
    const file = new File(['{}'], 'board.excalidraw');

    commands.open();
    choose(input, file);

    expect(asked).toHaveBeenCalledTimes(1);
    expect(actions.open).toHaveBeenCalledWith(file);
    expect(input.value).toBe('');
  });

  it("passes a file that couldn't be opened, and why, to onError", async () => {
    const failure = new Error("the file doesn't hold a board");
    let failed: (reported: [File, unknown]) => void = () => {};
    const reported = new Promise<[File, unknown]>((resolve) => {
      failed = resolve;
    });
    const { input } = connected({
      open: () => Promise.reject(failure),
      onError: (file, error) => failed([file, error]),
    });
    const file = new File(['not a board'], 'notes.txt');

    choose(input, file);

    expect(await reported).toEqual([file, failure]);
  });

  it('opens a board file dropped on the canvas before the canvas takes it', () => {
    const { actions } = connected();
    const canvasDrops: Event[] = [];
    element('canvas').addEventListener('drop', (event) => canvasDrops.push(event));
    const file = new File(['{}'], 'board.excalidraw');
    const event = dropped(file);

    element('canvas').dispatchEvent(event);

    expect(actions.open).toHaveBeenCalledWith(file);
    expect(event.defaultPrevented).toBe(true);
    expect(canvasDrops).toEqual([]);
  });

  it('leaves a dropped image to the canvas', () => {
    const { actions } = connected();
    const canvasDrops: Event[] = [];
    element('canvas').addEventListener('drop', (event) => canvasDrops.push(event));
    const event = dropped(new File(['png'], 'cat.png', { type: 'image/png' }));

    element('canvas').dispatchEvent(event);

    expect(actions.open).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
    expect(canvasDrops).toEqual([event]);
  });
});
