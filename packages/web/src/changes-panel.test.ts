// @vitest-environment jsdom
import { agentChangesOf, recordAgentChange, undoAgentChange } from '@chalkline/mcp/agent-changes';
import { afterEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { bindChangesPanel, joined } from './changes-panel';

type Element = Record<string, unknown>;

const AGENT = { kind: 'agent' as const, name: 'Claude' };

afterEach(() => {
  document.body.replaceChildren();
});

/** A board with a panel bound to it, whose undos Ada makes. */
function board() {
  const doc = new Y.Doc();
  const elements = doc.getMap<unknown>('elements');
  const changes = agentChangesOf(doc);
  const panel = document.createElement('aside');
  document.body.append(panel);
  const bound = bindChangesPanel(panel, elements, changes, {
    undoer: () => 'Ada',
    now: () => new Date('2026-11-07T10:30:00Z'),
  });
  return { doc, elements, changes, panel, bound };
}

/** A rectangle as the page draws it. */
function rectangle(fields: Element = {}): Element {
  return { id: 'box', type: 'rectangle', x: 0, y: 0, width: 100, height: 50, index: 'a0', isDeleted: false, version: 1, versionNonce: 1, ...fields };
}

/** Records that Claude added the rectangle, which `elements` then holds, and returns the change's id. */
function added(elements: Y.Map<unknown>, changes: Y.Array<unknown>, at = '2026-11-07T10:00:00Z'): string {
  elements.set('box', rectangle());
  const id = recordAgentChange(changes, {
    by: AGENT,
    tool: 'add_shapes',
    summary: 'Claude added 1 shape',
    elements: [{ id: 'box', before: null, after: rectangle() }],
    now: new Date(at),
  });
  expect(id).not.toBeNull();
  return String(id);
}

function item(panel: HTMLElement, id: string): HTMLLIElement {
  const found = panel.querySelector<HTMLLIElement>(`li[data-id="${id}"]`);
  expect(found).not.toBeNull();
  return found as HTMLLIElement;
}

function undoButton(panel: HTMLElement, id: string): HTMLButtonElement {
  const found = item(panel, id).querySelector<HTMLButtonElement>('button.changes-undo');
  expect(found).not.toBeNull();
  return found as HTMLButtonElement;
}

describe("the panel of the agent's changes", () => {
  it('starts closed and empty, lists the changes newest first, and opens and closes', () => {
    const { elements, changes, panel, bound } = board();
    expect(panel.hidden).toBe(true);
    expect(panel.querySelector<HTMLElement>('.changes-empty')?.hidden).toBe(false);

    const first = added(elements, changes, '2026-11-07T10:00:00Z');
    const second = recordAgentChange(changes, {
      by: AGENT,
      tool: 'update_shape',
      summary: 'Claude changed a rectangle',
      elements: [{ id: 'box', before: rectangle(), after: rectangle({ x: 40, version: 2 }) }],
      now: new Date('2026-11-07T10:05:00Z'),
    });
    // While the panel is closed, a change doesn't render its list: the list renders as the panel opens.
    expect(panel.querySelectorAll('li.changes-item')).toHaveLength(0);

    bound.toggle();
    expect(panel.hidden).toBe(false);
    expect(document.activeElement?.textContent).toBe('Close');
    const items = [...panel.querySelectorAll<HTMLLIElement>('li.changes-item')];
    expect(items.map((listed) => listed.dataset.id)).toEqual([second, first]);
    expect(items.map((listed) => listed.querySelector('.changes-summary')?.textContent)).toEqual([
      'Claude changed a rectangle',
      'Claude added 1 shape',
    ]);
    expect(items.map((listed) => listed.querySelector('time')?.dateTime)).toEqual([
      '2026-11-07T10:05:00.000Z',
      '2026-11-07T10:00:00.000Z',
    ]);
    expect(items.every((listed) => listed.dataset.state === 'undoable')).toBe(true);
    expect(panel.querySelector<HTMLElement>('.changes-empty')?.hidden).toBe(true);
    panel.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(panel.hidden).toBe(true);

    // A change made while the panel is closed shows once the panel opens again.
    const third = recordAgentChange(changes, {
      by: AGENT,
      tool: 'delete_shapes',
      summary: 'Claude deleted 1 shape',
      elements: [{ id: 'box', before: rectangle({ x: 40, version: 2 }), after: rectangle({ x: 40, version: 3, isDeleted: true }) }],
      now: new Date('2026-11-07T10:10:00Z'),
    });
    bound.open(true);
    expect([...panel.querySelectorAll<HTMLLIElement>('li.changes-item')].map((listed) => listed.dataset.id)).toEqual([
      third,
      second,
      first,
    ]);
    panel.querySelector<HTMLButtonElement>('.changes-close')?.click();
    expect(panel.hidden).toBe(true);
    bound.stop();
  });

  it('undoes an addition with Undo, which deletes the shape, and says who undid it', () => {
    const { elements, changes, panel, bound } = board();
    const id = added(elements, changes);
    bound.open(true);
    undoButton(panel, id).click();

    expect(elements.get('box')).toMatchObject({ type: 'rectangle', isDeleted: true });
    const undone = item(panel, id);
    expect(undone.dataset.state).toBe('undone');
    expect(undone.querySelector('button.changes-undo')).toBeNull();
    expect(undone.querySelector('.changes-undone')?.textContent).toMatch(/^Undone by Ada at /);
    expect(undone.querySelector('.changes-undone time')?.getAttribute('datetime')).toBe('2026-11-07T10:30:00.000Z');
    expect(undone.querySelector('.changes-kept')).toBeNull();
  });

  it('leaves a shape that someone changed after the change as it is, and names it', () => {
    const { elements, changes, panel, bound } = board();
    const id = added(elements, changes);
    bound.open(true);
    elements.set('box', rectangle({ x: 300, version: 2, versionNonce: 7 }));
    undoButton(panel, id).click();

    expect(elements.get('box')).toMatchObject({ x: 300, isDeleted: false, version: 2 });
    expect(item(panel, id).querySelector('.changes-kept')?.textContent).toBe(
      'Left a rectangle as it is, since someone changed it after this change.',
    );
  });

  it('says why an Undo pressed after someone else undid the change does nothing', () => {
    const { elements, changes, panel, bound } = board();
    const id = added(elements, changes);
    bound.open(true);
    const stale = undoButton(panel, id);
    undoAgentChange(elements, changes, id, { by: 'Bo' });
    expect(elements.get('box')).toMatchObject({ isDeleted: true });
    elements.set('box', rectangle({ version: 9 }));

    stale.click();
    const status = panel.querySelector<HTMLElement>('.changes-status');
    expect(status?.hidden).toBe(false);
    expect(status?.textContent).toContain('Bo undid the change');
    expect(elements.get('box')).toMatchObject({ isDeleted: false, version: 9 });
  });

  it("drops a change once the board no longer shows what it wrote, says that older changes can't be undone, and undoes the newest", () => {
    const { elements, changes, panel, bound } = board();
    const first = added(elements, changes);
    bound.open(true);
    expect(panel.querySelector<HTMLElement>('.changes-older')?.hidden).toBe(true);

    elements.set('box', rectangle({ x: 40, version: 2 }));
    const second = recordAgentChange(changes, {
      by: AGENT,
      tool: 'update_shape',
      summary: 'Claude changed a rectangle',
      elements: [{ id: 'box', before: rectangle(), after: rectangle({ x: 40, version: 2 }) }],
      now: new Date('2026-11-07T10:05:00Z'),
      board: elements,
    });
    expect([...panel.querySelectorAll<HTMLLIElement>('li.changes-item')].map((listed) => listed.dataset.id)).toEqual([second]);
    expect(panel.querySelector(`li[data-id="${first}"]`)).toBeNull();
    const older = panel.querySelector<HTMLElement>('.changes-older');
    expect(older?.hidden).toBe(false);
    expect(older?.textContent).toBe("Older changes can't be undone here: a change leaves this list once the board no longer shows what it wrote.");
    expect(panel.querySelector<HTMLElement>('.changes-empty')?.hidden).toBe(true);

    undoButton(panel, String(second)).click();
    expect(elements.get('box')).toMatchObject({ x: 0, isDeleted: false, version: 3 });
    expect(item(panel, String(second)).dataset.state).toBe('undone');
  });

  it('joins names into one phrase', () => {
    expect(joined(['a rectangle'])).toBe('a rectangle');
    expect(joined(['a rectangle', 'an arrow'])).toBe('a rectangle and an arrow');
    expect(joined(['a', 'b', 'c'])).toBe('a, b and c');
  });
});
