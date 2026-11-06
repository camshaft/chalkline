import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { bindElements, LOCAL, localChanges, mergeShared, wins, type Canvas } from './binding';

interface Shape {
  id: string;
  version: number;
  versionNonce: number;
  index: string | null;
  label?: string;
}

function shape(id: string, version: number, versionNonce = 1, index: string | null = 'a0', label?: string): Shape {
  return label === undefined ? { id, version, versionNonce, index } : { id, version, versionNonce, index, label };
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

function bound() {
  const doc = new Y.Doc();
  const shared = doc.getMap<Shape>('elements');
  const canvas = new FakeCanvas();
  const stop = bindElements(shared, canvas);
  const origins: unknown[] = [];
  doc.on('update', (_update: Uint8Array, origin: unknown) => origins.push(origin));
  return { doc, shared, canvas, stop, origins };
}

function fromPeer(doc: Y.Doc, ...shapes: Shape[]): void {
  const peer = new Y.Doc();
  Y.applyUpdate(peer, Y.encodeStateAsUpdate(doc));
  for (const element of shapes) peer.getMap<Shape>('elements').set(element.id, element);
  Y.applyUpdate(doc, Y.encodeStateAsUpdate(peer, Y.encodeStateVector(doc)), 'peer');
}

describe('wins', () => {
  it('prefers the higher version', () => {
    expect(wins(shape('a', 3, 9), shape('a', 2, 1))).toBe(true);
    expect(wins(shape('a', 2, 1), shape('a', 3, 9))).toBe(false);
  });

  it('of two equal versions, prefers the lower nonce', () => {
    expect(wins(shape('a', 2, 1), shape('a', 2, 9))).toBe(true);
    expect(wins(shape('a', 2, 9), shape('a', 2, 1))).toBe(false);
  });

  it('keeps the current copy where both are the same', () => {
    expect(wins(shape('a', 2, 5), shape('a', 2, 5))).toBe(false);
  });
});

describe('localChanges', () => {
  it('lists the elements the shared map lacks or holds an older copy of', () => {
    const shared = new Y.Doc().getMap<Shape>('elements');
    shared.set('same', shape('same', 1));
    shared.set('older', shape('older', 1));
    shared.set('newer', shape('newer', 3));

    const local = [shape('same', 1), shape('older', 2), shape('newer', 2), shape('new', 1)];

    expect(localChanges(shared, local).map((element) => element.id)).toEqual(['older', 'new']);
  });
});

describe('mergeShared', () => {
  it('keeps the winning copy of each element, ordered by fractional index', () => {
    const local = [shape('b', 2, 1, 'a1'), shape('c', 1, 1, 'a2')];
    const shared = [shape('c', 2, 1, 'a2'), shape('a', 1, 1, 'a0'), shape('b', 1, 1, 'a1')];

    const { elements, keep } = mergeShared(local, shared);

    expect(elements.map((element) => `${element.id}@${element.version}`)).toEqual(['a@1', 'b@2', 'c@2']);
    expect(keep.map((element) => element.id)).toEqual(['b']);
  });

  it('puts elements without an index last, and orders equal indices by id', () => {
    const { elements } = mergeShared([], [shape('z', 1, 1, null), shape('y', 1, 1, 'a0'), shape('x', 1, 1, 'a0')]);

    expect(elements.map((element) => element.id)).toEqual(['x', 'y', 'z']);
  });
});

describe('bindElements', () => {
  it('writes a copy of each local edit to the shared map', () => {
    const { shared, canvas, origins } = bound();
    const edited = shape('box', 1, 7, 'a0', 'first');

    canvas.edit([edited]);

    expect(shared.get('box')).toEqual(edited);
    expect(shared.get('box')).not.toBe(edited);
    expect(origins).toEqual([LOCAL]);
  });

  it("shows a peer's change on the canvas without writing it back", () => {
    const { doc, canvas, origins } = bound();

    fromPeer(doc, shape('box', 1, 3, 'a0', 'from the peer'));
    // Excalidraw reports a change after the scene is replaced, as after a person's edit.
    canvas.edit(canvas.current);

    expect(canvas.current).toEqual([shape('box', 1, 3, 'a0', 'from the peer')]);
    expect(origins).toEqual(['peer']);
  });

  it("keeps a newer local copy over a peer's older one, and shares it back", () => {
    const { doc, shared, canvas, origins } = bound();
    canvas.edit([shape('box', 1, 1, 'a0', 'first')]);
    // The canvas changes again before its change event runs.
    canvas.current = [shape('box', 3, 1, 'a0', 'third')];

    fromPeer(doc, shape('box', 2, 1, 'a0', 'second'));

    expect(canvas.current).toEqual([shape('box', 3, 1, 'a0', 'third')]);
    expect(shared.get('box')).toEqual(shape('box', 3, 1, 'a0', 'third'));
    expect(origins).toEqual([LOCAL, 'peer', LOCAL]);
  });

  it('adds the elements a peer added beside the local ones', () => {
    const { doc, shared, canvas } = bound();
    canvas.edit([shape('mine', 1, 1, 'a1')]);

    fromPeer(doc, shape('theirs', 1, 1, 'a0'));

    expect(canvas.current.map((element) => element.id)).toEqual(['theirs', 'mine']);
    expect([...shared.keys()].sort()).toEqual(['mine', 'theirs']);
  });

  it('stops following both sides once stopped', () => {
    const { doc, shared, canvas, stop } = bound();
    stop();

    canvas.edit([shape('mine', 1)]);
    fromPeer(doc, shape('theirs', 1));

    expect(shared.has('mine')).toBe(false);
    expect(canvas.current.map((element) => element.id)).toEqual(['mine']);
  });
});
