import type { Awareness } from '@chalkline/sync';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type * as Y from 'yjs';
import { addShapes, ELEMENTS, readBoard, ShapeError } from './board';
import type { Creator } from './creator';
import { connect, deleteShapes, updateShape } from './edit';
import { pendingRequests, RequestError, waitForRequest, writeMermaidRequest } from './requests';
import { boardShapeSchema, changeSchema, connectionSchema, deletionSchema, shapeSchema } from './shapes';

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

  // The agent whose shapes these are: its client, by the name it gave as it connected.
  const creator = (): Creator => ({
    kind: 'agent',
    name: server.server.getClientVersion()?.name ?? 'chalkline-mcp',
  });

  server.registerTool(
    'get_board',
    {
      title: 'Read the board',
      description:
        'Reads the board: every shape on it, from back to front, with its id, kind, position, size and label, for an arrow the ids of the shapes it starts and ends at, and for a shape an agent added, its creator; and, in pending, each Mermaid request that no page has converted yet.',
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
        'Each new shape records the agent as its creator, which get_board lists.',
      ].join(' '),
      inputSchema: { shapes: z.array(shapeSchema).min(1) },
      outputSchema: { ids: z.array(z.string()) },
    },
    ({ shapes }) => refusing(async () => answer({ ids: await addShapes(doc, shapes, creator()) })),
  );

  server.registerTool(
    'connect',
    {
      title: 'Connect two shapes with an arrow',
      description: [
        'Draws an arrow from one shape on the board to another, bound to both, above the shapes on the board, and answers its id.',
        "The arrow runs along the line between the two shapes' centers, from the edge of start to the edge of end, and it follows the shapes when either moves.",
        'start and end are ids that get_board lists: a rectangle, an ellipse, a diamond, a text, an image or a frame.',
        'The arrow records the agent as its creator.',
      ].join(' '),
      inputSchema: connectionSchema.shape,
      outputSchema: { id: z.string() },
    },
    (connection) => refusing(async () => answer({ id: await connect(doc, connection, creator()) })),
  );

  server.registerTool(
    'update_shape',
    {
      title: 'Change a shape on the board',
      description: [
        'Moves, resizes, relabels or recolors one shape on the board, a rectangle, an ellipse, a diamond, a text, an arrow or a line, and answers the shape as get_board lists it.',
        'A field left out, or given as null, stays as it is.',
        "A shape's label moves with it, and each arrow bound to it follows it.",
        "A straight arrow's or line's width and height say where it ends from its first point; an arrow bound to a shape follows that shape, so move the shape in its place.",
        'An empty label removes the label.',
      ].join(' '),
      inputSchema: changeSchema.shape,
      outputSchema: { shape: boardShapeSchema },
    },
    (change) => refusing(async () => answer({ shape: await updateShape(doc, change, creator()) })),
  );

  server.registerTool(
    'delete_shapes',
    {
      title: 'Delete shapes from the board',
      description: [
        'Deletes shapes from the board by their ids, as get_board lists them, and answers the ids it deleted.',
        "A shape's label goes with it, and each arrow bound to a deleted shape stays on the board, no longer bound at that end.",
      ].join(' '),
      inputSchema: deletionSchema.shape,
      outputSchema: { ids: z.array(z.string()) },
    },
    ({ ids }) => refusing(async () => answer({ ids: deleteShapes(doc, ids) })),
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
        'Each shape of the diagram records the agent as its creator.',
      ].join(' '),
      inputSchema: {
        text: z.string().min(1),
        at: z.object({ x: z.number().finite(), y: z.number().finite() }).optional(),
      },
      outputSchema: requestAnswerSchema,
    },
    async ({ text, at }, extra) => {
      // The request says who wrote it, and the page marks the diagram's shapes with that name.
      const id = writeMermaidRequest(doc, text, creator().name, at);
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

  return server;
}

/** Runs a tool's work, and answers a refusal where the work refuses the call's shapes. */
async function refusing(work: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof ShapeError) return refusal(error.message);
    throw error;
  }
}

/** A tool's answer: its structured content, and the same JSON as text for clients that read text alone. */
function answer(content: Record<string, unknown>): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(content) }], structuredContent: content };
}

/** A tool's refusal, whose text says what to change. */
function refusal(message: string): CallToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}
