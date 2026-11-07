import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type * as Y from 'yjs';
import { answer, refusal } from './answer';
import { ELEMENTS, readBoard } from './board';
import { boardShapeSchema, type BoardShape } from './shapes';

/** One shape's change, as read_changes answers it: the shape as get_board lists it, with what changed. */
export const boardChangeSchema = boardShapeSchema.extend({
  change: z
    .enum(['added', 'changed', 'deleted'])
    .describe(
      'Whether the shape was added, changed or deleted after the cursor. A deleted shape is listed as it was before its deletion.',
    ),
});

export type BoardChange = z.infer<typeof boardChangeSchema>;

/** What read_changes answers. */
export type ChangesRead = {
  /** Each shape added, changed or deleted after the read's cursor, once, in the order of its last change. */
  changes: BoardChange[];
  /** The cursor after them: the next read passes it to read the changes after these. */
  cursor: number;
};

/**
 * The changes of the board's shapes as this run of the helper saw them. Each time the log compares
 * the board with the board it compared before, it adds an entry for each shape added, changed or
 * deleted between the two, with the shape as get_board lists it, and a cursor counts these
 * entries. The log compares the board where a read needs it, and on each change of the board while
 * a read waits, so a change of what get_board doesn't list, such as an element's version, doesn't
 * add an entry.
 */
export class ChangeLog {
  readonly #elements: Y.Map<unknown>;
  /** The shapes of the last comparison, by id, each with its JSON. */
  #shapes = new Map<string, { shape: BoardShape; json: string }>();
  readonly #entries: BoardChange[] = [];
  /** Whether the board changed since the last comparison. */
  #stale = true;
  /** The reads that wait for a change. */
  readonly #waiting = new Set<() => void>();

  constructor(doc: Y.Doc) {
    this.#elements = doc.getMap<unknown>(ELEMENTS);
    this.#elements.observe(() => {
      this.#stale = true;
      for (const check of [...this.#waiting]) check();
    });
  }

  /** How many entries the log holds: the cursor after the board's last change. */
  get length(): number {
    this.#compare();
    return this.#entries.length;
  }

  /** How many reads wait for a change. */
  get waiting(): number {
    return this.#waiting.size;
  }

  /** The changes after `cursor`, and the cursor after them. */
  after(cursor: number): ChangesRead {
    this.#compare();
    return { changes: changesOf(this.#entries.slice(cursor)), cursor: this.#entries.length };
  }

  /**
   * The changes after `cursor`: at once where a shape changed after it, else on the change of the
   * board that changes a shape, or with no changes once `signal` aborts.
   */
  next(cursor: number, signal: AbortSignal): Promise<ChangesRead> {
    const read = this.after(cursor);
    if (read.changes.length > 0 || signal.aborted) return Promise.resolve(read);
    return new Promise((resolve) => {
      const check = (): void => {
        const now = this.after(cursor);
        if (now.changes.length === 0 && !signal.aborted) return;
        this.#waiting.delete(check);
        signal.removeEventListener('abort', check);
        resolve(now);
      };
      this.#waiting.add(check);
      signal.addEventListener('abort', check);
    });
  }

  /** Compares the board with the shapes of the last comparison, where it changed since then. */
  #compare(): void {
    if (!this.#stale) return;
    this.#stale = false;
    const shapes = new Map<string, { shape: BoardShape; json: string }>();
    for (const shape of readBoard(this.#elements.values())) {
      const json = JSON.stringify(shape);
      shapes.set(shape.id, { shape, json });
      const before = this.#shapes.get(shape.id);
      if (before === undefined) this.#entries.push({ change: 'added', ...shape });
      else if (before.json !== json) this.#entries.push({ change: 'changed', ...shape });
    }
    for (const [id, { shape }] of this.#shapes) {
      if (!shapes.has(id)) this.#entries.push({ change: 'deleted', ...shape });
    }
    this.#shapes = shapes;
  }
}

/**
 * The changes that `entries` make, one for each shape, in the order of each shape's last entry, as
 * its last entry lists the shape: a shape the board held before the entries and holds after them
 * is changed, one it holds only after them is added, and one it held only before them is deleted.
 * A shape added and deleted within the entries is left out.
 */
function changesOf(entries: readonly BoardChange[]): BoardChange[] {
  const first = new Map<string, BoardChange>();
  const last = new Map<string, BoardChange>();
  for (const entry of entries) {
    if (!first.has(entry.id)) first.set(entry.id, entry);
    // Set again, so that the map's order is the order of each shape's last entry.
    last.delete(entry.id);
    last.set(entry.id, entry);
  }
  const changes: BoardChange[] = [];
  for (const [id, entry] of last) {
    const held = first.get(id)?.change !== 'added';
    const holds = entry.change !== 'deleted';
    if (held && holds) changes.push({ ...entry, change: 'changed' });
    else if (held) changes.push({ ...entry, change: 'deleted' });
    else if (holds) changes.push({ ...entry, change: 'added' });
  }
  return changes;
}

/** Adds read_changes to `server`, which reads the changes of the board that `doc` holds. */
export function registerChanges(server: McpServer, doc: Y.Doc): ChangeLog {
  const log = new ChangeLog(doc);

  server.registerTool(
    'read_changes',
    {
      title: "Read the board's changes",
      description: [
        'Reads what changed on the board: each shape added, changed or deleted after `cursor`, once, as get_board lists it, with `change` saying which, and the cursor to give the next call.',
        "A deleted shape is listed as it was before its deletion, and a change of a shape's label is a change of the shape.",
        "A shape an agent added lists the agent as its creator, so a shape without a creator is a person's.",
        'Where no shape changed after the cursor, it answers on the next change of a shape, or with no changes once the client cancels the call.',
        'Left out, the cursor is 0, and the call lists each shape on the board as added.',
        'A cursor counts the changes this run of the helper has read, so it holds within one run of the helper.',
      ].join(' '),
      inputSchema: { cursor: z.number().int().min(0).optional() },
      outputSchema: { changes: z.array(boardChangeSchema), cursor: z.number().int().min(0) },
    },
    async ({ cursor = 0 }, extra) => {
      if (cursor > log.length) {
        return refusal(
          `cursor is ${cursor}, and the board's changes end at cursor ${log.length} in this run of the helper: give a cursor that read_changes answered, or 0 to read from the start.`,
        );
      }
      return answer(await log.next(cursor, extra.signal));
    },
  );

  return log;
}
