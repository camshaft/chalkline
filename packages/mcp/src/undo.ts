// undo_change, which undoes one of the agent's own changes of the board: the tools that change the
// board record each of their calls on the board's list of the agent's changes (agent-changes.ts),
// and answer the change's id, which undo_change takes.
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type * as Y from 'yjs';
import { agentChangesOf, listAgentChanges, undoAgentChange, UndoError } from './agent-changes';
import { answer, refusal } from './answer';
import { ELEMENTS } from './board';
import type { Creator } from './creator';

/** Registers undo_change on `server`, for the board that `doc` holds; `creator` is the agent whose calls the server answers. */
export function registerUndo(server: McpServer, doc: Y.Doc, creator: () => Creator): void {
  const elements = doc.getMap<unknown>(ELEMENTS);
  const changes = agentChangesOf(doc);
  server.registerTool(
    'undo_change',
    {
      title: "Undo one of the agent's changes",
      description: [
        "Undoes one of this agent's own changes of the board, by the id that the call that made it answered as change.",
        'add_shapes, connect, update_shape, delete_shapes, reorder_shapes, scale_shapes, add_image and flatten each record their change on the board, and each page lists the changes, newest first, with an Undo button.',
        'It writes each element the change wrote back as it was before the change, for everyone on the board, and deletes each element the change added; restored lists their ids.',
        'An element that someone changed after the change, such as a shape a person moved, relabelled or deleted since, stays as it is, and kept lists it with its name.',
        "It refuses an id that the board doesn't record, another agent's change, and a change that someone undid already.",
      ].join(' '),
      inputSchema: {
        id: z.string().min(1).describe('The id of the change to undo, as the call that made it answered it in change.'),
      },
      outputSchema: {
        id: z.string().describe("The undo's id."),
        change: z.string().describe('The id of the change it undid.'),
        restored: z.array(z.string()).describe('The ids of the elements it wrote back as they were before the change.'),
        kept: z
          .array(z.object({ id: z.string(), name: z.string() }))
          .describe('The elements it left as they are, since someone changed them after the change, each with its name.'),
      },
    },
    ({ id }) => {
      const agent = creator();
      const change = listAgentChanges(changes).find((listed) => listed.id === id);
      if (change !== undefined && change.by.name !== agent.name) {
        return refusal(
          `The change ${id}, "${change.summary}", is ${change.by.name}'s: undo_change undoes this agent's own changes, and a person undoes another agent's change from the page.`,
        );
      }
      try {
        const undo = undoAgentChange(elements, changes, id, { by: agent.name, agent });
        return answer({ id: undo.id, change: undo.change, restored: undo.restored, kept: undo.kept });
      } catch (error) {
        if (error instanceof UndoError) return refusal(error.message);
        throw error;
      }
    },
  );
}
