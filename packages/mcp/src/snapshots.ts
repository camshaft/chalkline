import { listSnapshotMarks, shapeCount, snapshotsOf, writeSnapshotMark, type SnapshotMark } from '@chalkline/sync';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type * as Y from 'yjs';
import { answer, refusal } from './answer';
import { ELEMENTS, newId } from './board';
import { running } from './presence';
import { agentName } from './transcript';

/** The line list_snapshots answers beside the marks: where the snapshots themselves are, and how a person restores one. */
export const BROWSER_SNAPSHOTS =
  "Each browser on the board keeps its snapshots in its own storage, which this helper can't read: one for each mark, one each 10 minutes while the board changes, and one before a change deletes more than 50 shapes. A person previews and restores a snapshot from the History panel in the page's main menu.";

const markSchema = z.object({
  id: z.string(),
  by: z.string(),
  at: z.string(),
  label: z.string().nullable(),
  shapes: z.number().int().min(0),
});

/**
 * Adds save_snapshot and list_snapshots to `server` (designs/chalkline A14). save_snapshot writes a snapshot mark,
 * which asks each browser on the board to keep a snapshot of its board as it stands, and list_snapshots lists the
 * board's marks.
 */
export function registerSnapshots(server: McpServer, doc: Y.Doc): void {
  const marks = snapshotsOf(doc);

  server.registerTool(
    'save_snapshot',
    {
      title: 'Save a snapshot of the board',
      description: [
        "Asks each browser on the board to keep a snapshot of the board as it stands, such as before a large edit: it writes a snapshot mark with a new id, the agent's name as `by`, the time now (ISO 8601), the label and the count of shapes the helper's copy of the board holds, and answers the mark.",
        "Each browser keeps the snapshot in its own storage, and a person previews and restores it from the History panel in the page's main menu.",
        "It refuses where the board doesn't have any shapes.",
      ].join(' '),
      inputSchema: {
        label: z
          .string()
          .optional()
          .describe('What the snapshot is for, in a short text, such as "before the redesign"; left out or blank, the mark has no label.'),
      },
      outputSchema: { mark: markSchema },
    },
    ({ label }) =>
      running(server, () => {
        const shapes = shapeCount(doc.getMap<unknown>(ELEMENTS).values());
        if (shapes === 0) {
          return refusal("the board doesn't have any shapes: a snapshot of it would hold nothing to restore.");
        }
        const words = label?.trim() ?? '';
        const mark: SnapshotMark = {
          id: newId(),
          by: agentName(server),
          at: new Date().toISOString(),
          label: words === '' ? null : words,
          shapes,
        };
        writeSnapshotMark(marks, mark);
        return answer({ mark });
      }),
  );

  server.registerTool(
    'list_snapshots',
    {
      title: "List the board's snapshot marks",
      description: [
        'Lists the snapshot marks that save_snapshot wrote on the board, oldest first by time and then by id, each with its id, its time, the agent that saved it as `by`, its label and its count of shapes.',
        `It answers a note beside them: ${BROWSER_SNAPSHOTS}`,
      ].join(' '),
      inputSchema: {},
      outputSchema: { marks: z.array(markSchema), note: z.string() },
    },
    () => running(server, () => answer({ marks: listSnapshotMarks(marks), note: BROWSER_SNAPSHOTS })),
  );
}
