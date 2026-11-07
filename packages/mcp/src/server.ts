import type { Awareness } from '@chalkline/sync';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type * as Y from 'yjs';
import { answer, refusal } from './answer';
import { addShapes, ELEMENTS, readBoard, ShapeError } from './board';
import { pendingRequests, RequestError, waitForRequest, writeMermaidRequest } from './requests';
import { boardShapeSchema, shapeSchema } from './shapes';
import { registerTranscript } from './transcript';

/** A Mermaid request's state, as add_mermaid and get_request answer it. */
const requestAnswerSchema = {
  id: z.string(),
  status: z.enum(['pending', 'done', 'failed']),
  ids: z.array(z.string()).optional(),
  error: z.string().optional(),
};

/**
 * chalkline-mcp's MCP server, whose tools read and draw on the board that `doc` holds. `awareness`
 * holds the room's participants, which tell the helper whether a page is in the room to convert a
 * Mermaid request.
 */
export function createServer(doc: Y.Doc, awareness: Awareness): McpServer {
  const server = new McpServer({ name: 'chalkline', version: '0.0.0' });
  const elements = doc.getMap<unknown>(ELEMENTS);

  server.registerTool(
    'get_board',
    {
      title: 'Read the board',
      description:
        'Reads the board: every shape on it, from back to front, with its id, kind, position, size and label, and for an arrow the ids of the shapes it starts and ends at; and, in pending, each Mermaid request that no page has converted yet.',
      outputSchema: {
        shapes: z.array(boardShapeSchema),
        pending: z.array(z.object({ id: z.string(), kind: z.literal('mermaid') })),
      },
    },
    () => answer({ shapes: readBoard(elements.values()), pending: pendingRequests(doc) }),
  );

  server.registerTool(
    'add_shapes',
    {
      title: 'Add shapes to the board',
      description: [
        "Adds shapes to the board in Excalidraw's skeleton format, above the shapes on it, and answers each new shape's id, in the order of the call's shapes.",
        'Each shape sets its type (rectangle, ellipse, diamond, text, arrow or line), its x and its y, and may set an id.',
        'A rectangle, an ellipse or a diamond takes a width, a height and a label, and a text its text.',
        "An arrow's width and height say where it ends, from its x and y, and its start and end name shapes of the same call, which it binds to.",
      ].join(' '),
      inputSchema: { shapes: z.array(shapeSchema).min(1) },
      outputSchema: { ids: z.array(z.string()) },
    },
    async ({ shapes }) => {
      try {
        return answer({ ids: await addShapes(doc, shapes) });
      } catch (error) {
        if (error instanceof ShapeError) return refusal(error.message);
        throw error;
      }
    },
  );

  server.registerTool(
    'add_mermaid',
    {
      title: 'Add a Mermaid diagram to the board',
      description: [
        'Asks a page of the board to convert the Mermaid text of a whole diagram into shapes, and to add them above the shapes on the board: the conversion runs in a browser, so a page that has the board open carries it out.',
        "It answers once a page has added the shapes, with status done and the new shapes' ids, or once a page couldn't convert the text, with status failed and the reason.",
        "Where the room doesn't hold a page, or every page leaves first, it answers status pending with the request's id: the request stays on the board, the first page that joins converts it, and get_request reads it by its id.",
        "`at` is where the diagram's top left corner goes; left out, the diagram goes below the board's shapes.",
      ].join(' '),
      inputSchema: {
        text: z.string().min(1),
        at: z.object({ x: z.number().finite(), y: z.number().finite() }).optional(),
      },
      outputSchema: requestAnswerSchema,
    },
    async ({ text, at }, extra) => {
      // The request says who wrote it: the agent's client, by the name it gave as it connected.
      const by = server.server.getClientVersion()?.name ?? 'chalkline-mcp';
      const id = writeMermaidRequest(doc, text, by, at);
      return answer(await waitForRequest(doc, awareness, id, extra.signal));
    },
  );

  server.registerTool(
    'get_request',
    {
      title: 'Read a Mermaid request',
      description:
        "Reads the Mermaid request whose id add_mermaid answered. It answers once a page has converted it, with status done and the new shapes' ids, or with status failed and the reason; and it answers status pending where the room doesn't hold a page, or once every page leaves.",
      inputSchema: { id: z.string().min(1) },
      outputSchema: requestAnswerSchema,
    },
    async ({ id }, extra) => {
      try {
        return answer(await waitForRequest(doc, awareness, id, extra.signal));
      } catch (error) {
        if (error instanceof RequestError) return refusal(error.message);
        throw error;
      }
    },
  );

  // read_transcript, and the transcript as a resource with its notification.
  registerTranscript(server, doc);

  return server;
}
