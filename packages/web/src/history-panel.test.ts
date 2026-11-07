// @vitest-environment jsdom
import { connectDoc, getSnapshotMark, MemoryNetwork, snapshotsOf, writeSnapshotMark } from '@chalkline/sync';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { RESTORED, restoreElements } from './board-file';
import { historyOpener, historyPanel, snapshotReason, type HistoryOptions, type HistoryPanel } from './history-panel';
import type { SnapshotSummary } from './snapshots';

interface Shape {
  id: string;
  type: string;
  version: number;
  versionNonce: number;
  index: string;
  isDeleted: boolean;
  containerId?: string | null;
}

function shape(id: string, version = 1, fields: Partial<Shape> = {}): Shape {
  return { id, type: 'rectangle', version, versionNonce: 1, index: `a${id}`, isDeleted: false, ...fields };
}

const START = Date.parse('2026-11-07T17:00:00.000Z');
const MINUTE = 60_000;
const iso = (at: number) => new Date(at).toISOString();

/** This browser's snapshots, kept in memory, as the History panel reads them, which a test adds to. */
class FakeKeeper {
  private readonly kept = new Map<number, { summary: SnapshotSummary; elements: Shape[] }>();
  private readonly listeners = new Set<() => void>();
  private next = 1;
  private failed = false;

  list(): SnapshotSummary[] {
    return [...this.kept.values()].map((each) => each.summary).reverse();
  }

  elements(id: number): Promise<Shape[] | null> {
    const held = this.kept.get(id);
    return Promise.resolve(held === undefined ? null : structuredClone(held.elements));
  }

  lost(): boolean {
    return this.failed;
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** How many listeners the keeper calls on each write. */
  get listening(): number {
    return this.listeners.size;
  }

  /** Keeps a snapshot of `elements`, as the keeper writes one, and returns its id. */
  add(summary: Partial<Omit<SnapshotSummary, 'id'>>, elements: Shape[]): number {
    const id = this.next++;
    this.kept.set(id, {
      summary: {
        id,
        at: START,
        reason: 'interval',
        label: null,
        mark: null,
        shapes: elements.length,
        deleted: null,
        ...summary,
      },
      elements: structuredClone(elements),
    });
    this.changed();
    return id;
  }

  /** Removes the snapshot `id` from the store without notifying the panel, as another tab could. */
  forget(id: number): void {
    this.kept.delete(id);
  }

  /** Marks the newest snapshot as lost, as a store whose storage refused it. */
  lose(): void {
    this.failed = true;
    this.changed();
  }

  private changed(): void {
    for (const listener of [...this.listeners]) listener();
  }
}

/** A preview that draws an empty SVG, whose `data-elements` holds the ids of the elements it was asked to draw. */
const drawing = () =>
  vi.fn((elements: Shape[]) => {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('data-elements', elements.map((element) => element.id).join(' '));
    return Promise.resolve(svg);
  });

const panels: HistoryPanel[] = [];

afterEach(() => {
  for (const panel of panels.splice(0)) panel.stop();
  document.body.replaceChildren();
});

function open(options: Partial<HistoryOptions<Shape>> & { snapshots: FakeKeeper }): HistoryPanel {
  const panel = historyPanel<Shape>(document, {
    mark: () => null,
    preview: drawing(),
    restore: () => [],
    time: iso,
    onClose: () => {},
    ...options,
  });
  panels.push(panel);
  document.body.append(panel.element);
  return panel;
}

/** The text of each snapshot the panel lists, from the top. */
const listed = (panel: HistoryPanel): string[] =>
  [...panel.element.querySelectorAll('.history-list button')].map((button) => button.textContent ?? '');

function button(panel: HistoryPanel, text: string): HTMLButtonElement {
  const found = [...panel.element.querySelectorAll('button')].find((each) => each.textContent === text);
  if (found === undefined) throw new Error(`the panel doesn't show the button ${text}`);
  return found;
}

/** Chooses the snapshot the panel lists at `position`, from the top, and waits for its preview. */
async function choose(panel: HistoryPanel, position: number): Promise<void> {
  const item = panel.element.querySelectorAll<HTMLButtonElement>('.history-list button')[position];
  if (item === undefined) throw new Error(`the panel doesn't list a snapshot at ${position}`);
  item.click();
  await panel.idle();
}

const status = (panel: HistoryPanel) => panel.element.querySelector('.history-status')?.textContent;
const shown = (panel: HistoryPanel, selector: string) => panel.element.querySelector<HTMLElement>(selector)?.hidden === false;

describe('snapshotReason', () => {
  it('says why the browser took each kind of snapshot', () => {
    const summary = (fields: Partial<SnapshotSummary>): SnapshotSummary => ({
      id: 1,
      at: START,
      reason: 'interval',
      label: null,
      mark: null,
      shapes: 1,
      deleted: null,
      ...fields,
    });
    const saved = { id: 'm', by: 'claude-code', at: iso(START), label: 'before the redesign', shapes: 1 };

    expect(snapshotReason(summary({}), null)).toBe('Every 10 minutes');
    expect(snapshotReason(summary({ reason: 'deletion', deleted: 51 }), null)).toBe('Before 51 shapes were deleted');
    expect(snapshotReason(summary({ reason: 'deletion' }), null)).toBe('Before a large deletion');
    expect(snapshotReason(summary({ reason: 'mark', mark: 'm', label: 'before the redesign' }), saved)).toBe(
      'Saved by claude-code: before the redesign',
    );
    expect(snapshotReason(summary({ reason: 'mark', mark: 'm' }), saved)).toBe('Saved by claude-code');
    expect(snapshotReason(summary({ reason: 'mark', mark: 'gone' }), null)).toBe('Saved by the agent');
  });
});

describe('historyPanel', () => {
  it("lists this browser's snapshots newest first, with the time, the shape count and why each was taken", () => {
    const marks = snapshotsOf(new Y.Doc());
    writeSnapshotMark(marks, { id: 'saved', by: 'claude-code', at: iso(START), label: 'before the redesign', shapes: 3 });
    const snapshots = new FakeKeeper();
    snapshots.add({ at: START }, [shape('a')]);
    snapshots.add({ at: START + MINUTE, reason: 'deletion', deleted: 51 }, Array.from({ length: 60 }, (_, n) => shape(`d${n}`)));
    snapshots.add({ at: START + 2 * MINUTE, reason: 'mark', mark: 'saved', label: 'before the redesign' }, [shape('a'), shape('b'), shape('c')]);
    snapshots.add({ at: START + 3 * MINUTE, reason: 'mark', mark: 'unknown' }, [shape('a'), shape('b')]);

    const panel = open({ snapshots, mark: (id) => getSnapshotMark(marks, id) });

    expect(listed(panel)).toEqual([
      `${iso(START + 3 * MINUTE)} - 2 shapes - Saved by the agent`,
      `${iso(START + 2 * MINUTE)} - 3 shapes - Saved by claude-code: before the redesign`,
      `${iso(START + MINUTE)} - 60 shapes - Before 51 shapes were deleted`,
      `${iso(START)} - 1 shape - Every 10 minutes`,
    ]);
    expect(shown(panel, '.history-empty')).toBe(false);
    expect(shown(panel, '.history-lost')).toBe(false);
    expect(button(panel, 'Restore').disabled).toBe(true);
  });

  it('lists the snapshots again on each write to the store, says when it holds none or lost one, and stops listening once stopped', () => {
    const snapshots = new FakeKeeper();
    const panel = open({ snapshots });
    expect(listed(panel)).toEqual([]);
    expect(shown(panel, '.history-empty')).toBe(true);
    expect(panel.element.querySelector('.history-empty')?.textContent).toBe("This browser hasn't kept a snapshot of this board yet.");

    snapshots.add({ at: START }, [shape('a')]);
    expect(listed(panel)).toEqual([`${iso(START)} - 1 shape - Every 10 minutes`]);
    expect(shown(panel, '.history-empty')).toBe(false);

    snapshots.lose();
    expect(shown(panel, '.history-lost')).toBe(true);
    expect(panel.element.querySelector('.history-lost')?.getAttribute('role')).toBe('alert');

    panel.stop();
    expect(snapshots.listening).toBe(0);
    snapshots.add({ at: START + MINUTE }, [shape('a', 2)]);
    expect(listed(panel)).toHaveLength(1);
  });

  it('previews the chosen snapshot, and Restore brings back each of its elements for every peer as one change', async () => {
    const network = new MemoryNetwork();
    const ada = new Y.Doc();
    const grace = new Y.Doc();
    connectDoc(ada, network.join('ada'));
    connectDoc(grace, network.join('grace'));
    const adaMap = ada.getMap<Shape>('elements');
    const graceMap = grace.getMap<Shape>('elements');
    const label = shape('a-label', 1, { type: 'text', containerId: 'a' });
    const board = [shape('a'), label, shape('b'), shape('c')];
    grace.transact(() => {
      for (const element of board) graceMap.set(element.id, element);
    });
    network.flush();
    const snapshots = new FakeKeeper();
    snapshots.add({ at: START, shapes: 3 }, board);

    // Since the snapshot, Grace deleted a, its label and b, moved c, and added d.
    grace.transact(() => {
      for (const element of [shape('a'), label, shape('b')]) graceMap.set(element.id, { ...element, version: 2, isDeleted: true });
      graceMap.set('c', shape('c', 2, { index: 'a9' }));
      graceMap.set('d', shape('d'));
    });
    network.flush();

    let restores = 0;
    ada.on('afterTransaction', (transaction: Y.Transaction) => {
      if (transaction.origin === RESTORED) restores += 1;
    });
    const preview = drawing();
    const panel = open({ snapshots, preview, restore: (elements) => restoreElements(adaMap, elements) });

    await choose(panel, 0);
    expect(preview).toHaveBeenCalledTimes(1);
    expect(preview).toHaveBeenCalledWith(board);
    expect(panel.element.querySelector('.history-preview svg')?.getAttribute('data-elements')).toBe('a a-label b c');
    expect(panel.element.querySelector('.history-list button')?.getAttribute('aria-pressed')).toBe('true');
    expect(button(panel, 'Restore').disabled).toBe(false);

    button(panel, 'Restore').click();
    expect(status(panel)).toBe('Restored 3 shapes.');
    expect(restores).toBe(1);
    network.flush();

    // Each element of the snapshot is back on Grace's board as the snapshot holds it, at a version after the
    // board's, so that every copy shows it; d, which Grace added since, stays.
    for (const map of [adaMap, graceMap]) {
      expect(map.get('a')).toEqual(shape('a', 3));
      expect(map.get('a-label')).toEqual({ ...label, version: 3 });
      expect(map.get('b')).toEqual(shape('b', 3));
      expect(map.get('c')).toEqual(shape('c', 3));
      expect(map.get('d')).toEqual(shape('d'));
    }
  });

  it('says that the board already holds a snapshot whose every element it holds, and writes nothing', async () => {
    const doc = new Y.Doc();
    const shared = doc.getMap<Shape>('elements');
    const board = [shape('a'), shape('b')];
    for (const element of board) shared.set(element.id, element);
    let restores = 0;
    doc.on('afterTransaction', (transaction: Y.Transaction) => {
      if (transaction.origin === RESTORED) restores += 1;
    });
    const snapshots = new FakeKeeper();
    snapshots.add({ at: START }, board);
    const panel = open({ snapshots, restore: (elements) => restoreElements(shared, elements) });

    await choose(panel, 0);
    button(panel, 'Restore').click();

    expect(status(panel)).toBe('The board already holds this snapshot.');
    expect(restores).toBe(0);
  });

  it("says that the browser doesn't hold a snapshot any longer, or that its preview couldn't be drawn", async () => {
    const snapshots = new FakeKeeper();
    const older = snapshots.add({ at: START }, [shape('a')]);
    snapshots.add({ at: START + MINUTE }, [shape('a', 2)]);
    const preview = vi.fn((elements: Shape[]) =>
      elements[0]?.version === 2 ? Promise.reject(new Error('the canvas failed')) : Promise.resolve(document.createElement('div')),
    );
    const panel = open({ snapshots, preview });

    snapshots.forget(older);
    await choose(panel, 1);
    expect(status(panel)).toBe("This browser doesn't hold this snapshot any longer.");
    expect(preview).not.toHaveBeenCalled();
    expect(button(panel, 'Restore').disabled).toBe(true);

    await choose(panel, 0);
    expect(status(panel)).toBe("The preview couldn't be drawn: the canvas failed");
    expect(button(panel, 'Restore').disabled).toBe(true);
  });
});

describe('historyOpener', () => {
  it('opens the panel in its holder, and Close closes it and stops its listing', () => {
    const holder = document.createElement('div');
    holder.hidden = true;
    document.body.append(holder);
    const snapshots = new FakeKeeper();
    const opener = historyOpener<Shape>(holder, { snapshots, mark: () => null, preview: drawing(), restore: () => [], time: iso });

    const first = opener();
    expect(holder.hidden).toBe(false);
    expect(holder.firstElementChild).toBe(first.element);
    expect(first.element.getAttribute('aria-label')).toBe('History');
    expect(snapshots.listening).toBe(1);

    // Opening it again replaces the panel, and the first one stops listening.
    const second = opener();
    expect(holder.firstElementChild).toBe(second.element);
    expect(snapshots.listening).toBe(1);

    button(second, 'Close').click();
    expect(holder.hidden).toBe(true);
    expect(holder.childElementCount).toBe(0);
    expect(snapshots.listening).toBe(0);
  });
});
