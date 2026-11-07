import { withWordsChanged, wordsChangedOf } from '@chalkline/mcp/creator';
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { bindElements, LOCAL, localChanges, mergeShared, wins, type Canvas } from './binding';

interface Shape {
  id: string;
  version: number;
  versionNonce: number;
  index: string | null;
  label?: string;
  isDeleted?: boolean;
  type?: string;
  text?: string;
  originalText?: string;
  updated?: number;
  x?: number;
  customData?: Record<string, unknown>;
}

function shape(id: string, version: number, versionNonce = 1, index: string | null = 'a0', label?: string): Shape {
  return label === undefined ? { id, version, versionNonce, index } : { id, version, versionNonce, index, label };
}

class FakeCanvas implements Canvas<Shape> {
  current: Shape[] = [];
  /** How many times the binding replaced the canvas's elements. */
  replacements = 0;
  private readonly handlers = new Set<() => void>();

  elements(): readonly Shape[] {
    return this.current;
  }

  replace(elements: Shape[]): void {
    this.current = elements;
    this.replacements += 1;
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

  it("keeps the canvas's own object where the shared map holds the same copy, and lists the shared copies that won", () => {
    const same = shape('same', 1, 1, 'a0');
    const mine = shape('mine', 3, 1, 'a1');
    const older = shape('older', 1, 1, 'a2');
    const newer = shape('older', 2, 1, 'a2');
    const added = shape('added', 1, 1, 'a3');

    const { elements, keep, taken } = mergeShared(
      [same, mine, older],
      [shape('same', 1, 1, 'a0'), shape('mine', 2, 1, 'a1'), newer, added],
    );

    expect(elements).toHaveLength(4);
    expect(elements[0]).toBe(same);
    expect(elements[1]).toBe(mine);
    expect(elements[2]).toBe(newer);
    expect(elements[3]).toBe(added);
    expect(keep).toHaveLength(1);
    expect(keep[0]).toBe(mine);
    expect(taken).toHaveLength(2);
    expect(taken[0]).toBe(newer);
    expect(taken[1]).toBe(added);
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

  it("keeps the canvas's own object of each element a peer didn't change, and a copy of the one it changed", () => {
    const { doc, shared, canvas } = bound();
    canvas.edit([shape('still', 1, 1, 'a0'), shape('moved', 1, 1, 'a1')]);
    const [still] = canvas.current;

    fromPeer(doc, shape('moved', 2, 1, 'a1', 'moved by the peer'));

    expect(canvas.current).toHaveLength(2);
    expect(canvas.current[0]).toBe(still);
    expect(canvas.current[1]).toEqual(shape('moved', 2, 1, 'a1', 'moved by the peer'));
    expect(canvas.current[1]).not.toBe(shared.get('moved'));
  });

  it("leaves the canvas as it is where a peer's copies are the same as its own, or older", () => {
    const { doc, shared, canvas, origins } = bound();
    canvas.edit([shape('same', 1, 1, 'a0'), shape('newer', 1, 1, 'a1')]);
    // The canvas changes again before its change event runs.
    const current = [canvas.current[0], shape('newer', 3, 1, 'a1', 'third')];
    canvas.current = current;
    const replacements = canvas.replacements;

    fromPeer(doc, shape('same', 1, 1, 'a0'), shape('newer', 2, 1, 'a1', 'second'));

    expect(canvas.replacements).toBe(replacements);
    expect(canvas.current).toBe(current);
    expect(shared.get('newer')).toEqual(shape('newer', 3, 1, 'a1', 'third'));
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

/** Sends `to` each update of `from` that `to` lacks, as the connection between two pages does. */
function deliver(from: Y.Doc, to: Y.Doc): void {
  Y.applyUpdate(to, Y.encodeStateAsUpdate(from, Y.encodeStateVector(to)), 'peer');
}

/**
 * What Excalidraw's Reset the canvas does to the scene of the page that chooses it: in one change, it
 * marks each element deleted, one version later and with a new nonce, and keeps it in the scene
 * (actionClearCanvas calls newElementWith with isDeleted on each element).
 */
function resetCanvas(canvas: FakeCanvas): void {
  canvas.edit(
    canvas.current.map((element) => ({
      ...element,
      version: element.version + 1,
      versionNonce: element.versionNonce + 100,
      isDeleted: true,
    })),
  );
}

/** The ids of the elements a canvas shows, which are those that aren't deleted. */
function shown(canvas: FakeCanvas): string[] {
  return canvas.current.filter((element) => element.isDeleted !== true).map((element) => element.id);
}

describe("Excalidraw's Reset the canvas", () => {
  it('clears every page: each deleted copy goes to the shared map, and wins on the other page', () => {
    const first = bound();
    const second = bound();
    first.canvas.edit([shape('box', 1, 1, 'a0'), shape('text', 3, 1, 'a1')]);
    deliver(first.doc, second.doc);
    expect(shown(second.canvas)).toEqual(['box', 'text']);

    resetCanvas(first.canvas);
    deliver(first.doc, second.doc);

    const copies = [...first.shared.values()].map((element) => `${element.id}@${element.version}:${element.isDeleted}`);
    expect(copies.sort()).toEqual(['box@2:true', 'text@4:true']);
    expect(shown(first.canvas)).toEqual([]);
    expect(shown(second.canvas)).toEqual([]);
    expect(second.canvas.current).toEqual(first.canvas.current);
  });

  it("doesn't bring the shapes back with a peer's next change, made before or after the reset reaches it", () => {
    const first = bound();
    const second = bound();
    first.canvas.edit([shape('box', 1, 1, 'a0')]);
    deliver(first.doc, second.doc);

    resetCanvas(first.canvas);
    // The other page adds a shape before the reset reaches it, and another once it has.
    second.canvas.edit([...second.canvas.current, shape('note', 1, 1, 'a1')]);
    deliver(second.doc, first.doc);
    deliver(first.doc, second.doc);
    second.canvas.edit([...second.canvas.current, shape('later', 1, 1, 'a2')]);
    deliver(second.doc, first.doc);

    expect(shown(first.canvas)).toEqual(['note', 'later']);
    expect(shown(second.canvas)).toEqual(['note', 'later']);
    expect(first.canvas.current).toEqual(second.canvas.current);
  });
});

/** A text of `words`, as a page last changed it at `updated`. */
function text(id: string, version: number, words: string, updated: number): Shape {
  return { id, version, versionNonce: 1, index: 'a0', type: 'text', text: words, originalText: words, updated };
}

describe("the map's copy of a text", () => {
  it("keeps when the text's words last changed across a local change that leaves them as they are, and sets it at a change of the words", () => {
    const { shared, canvas } = bound();
    canvas.edit([text('note', 1, 'first words', 1000)]);
    expect(wordsChangedOf(shared.get('note'))).toBe(1000);

    // The person moves the text, and the page measures it again: each a new version, with the same words.
    canvas.edit([{ ...text('note', 2, 'first words', 2000), x: 40 }]);
    canvas.edit([{ ...text('note', 3, 'first words', 3000), x: 40, text: 'first\nwords' }]);
    expect(shared.get('note')).toMatchObject({ version: 3, updated: 3000, text: 'first\nwords' });
    expect(wordsChangedOf(shared.get('note'))).toBe(1000);
    // The canvas keeps its own object, which doesn't hold the mark.
    expect(canvas.current[0].customData).toBeUndefined();

    canvas.edit([text('note', 4, 'other words', 4000)]);
    expect(wordsChangedOf(shared.get('note'))).toBe(4000);
  });

  it("keeps the time of a peer's copy that the canvas took, across a local move", () => {
    const { doc, shared, canvas } = bound();
    fromPeer(doc, withWordsChanged(text('note', 1, 'first words', 1000), undefined));

    canvas.edit([{ ...canvas.current[0], version: 2, versionNonce: 5, updated: 2000, x: 40 }]);

    expect(shared.get('note')).toMatchObject({ version: 2, x: 40 });
    expect(wordsChangedOf(shared.get('note'))).toBe(1000);
  });

  it("records the time of the map's copy where that copy holds the same words without recording when they changed", () => {
    const { doc, shared, canvas } = bound();
    // A page that doesn't write the mark wrote the text.
    fromPeer(doc, text('note', 1, 'first words', 1000));

    // The page measures the text again, with the same words.
    canvas.edit([{ ...canvas.current[0], version: 2, versionNonce: 5, updated: 2000 }]);

    expect(shared.get('note')?.version).toBe(2);
    expect(wordsChangedOf(shared.get('note'))).toBe(1000);

    // A change of the words records its own time.
    canvas.edit([{ ...canvas.current[0], version: 3, versionNonce: 6, updated: 3000, text: 'other words', originalText: 'other words' }]);
    expect(wordsChangedOf(shared.get('note'))).toBe(3000);
  });
});
