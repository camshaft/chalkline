import type { Awareness } from '@chalkline/sync';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type * as Y from 'yjs';
import { answer, refusal } from './answer';
import { addShapes, ELEMENTS, newId, readBoard, ShapeError } from './board';
import type { Creator } from './creator';
import { connect, deleteShapes, moveGroup, updateShape } from './edit';
import { renderBoard, RenderError } from './render';
import { pendingRequests, RequestError, waitForRequest, writeMermaidRequest } from './requests';
import { boardShapeSchema, changeSchema, connectionSchema, deletionSchema, LISTED_POINTS, shapeSchema } from './shapes';
import { registerTranscript } from './transcript';

/** A Mermaid request's state, as add_mermaid and get_request answer it. */
const requestAnswerSchema = {
  id: z.string(),
  status: z.enum(['pending', 'done', 'failed']),
  ids: z.array(z.string()).optional(),
  error: z.string().optional(),
};

/** A part of the board, in the board's units, as render_board reads and answers it. */
const regionSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  width: z.number().finite().positive(),
  height: z.number().finite().positive(),
});

/** How many pixels wide and high render_board's picture is at most, where the call leaves its size out. */
const PICTURE_SIZE = 1024;

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
        `Reads the board: every shape on it, from back to front, with its id, kind, position, size and label, its stroke and background colors, each style field, font and alignment that isn't Excalidraw's default, for a shape in a group the ids of its groups, the innermost first, for an arrow the ids of the shapes it starts and ends at, for a line, an arrow or a freehand stroke its points, and for a shape an agent added, its creator; and, in pending, each Mermaid request that no page has converted yet. An arrow's or a line's width and height say how far its last point lies right of and below its first, as add_shapes reads them. Of a stroke that holds more than ${LISTED_POINTS} points, it lists ${LISTED_POINTS} of them, evenly spaced from its first to its last, and their count in pointCount.`,
      outputSchema: {
        shapes: z.array(boardShapeSchema),
        pending: z.array(z.object({ id: z.string(), kind: z.literal('mermaid') })),
      },
    },
    () => answer({ shapes: readBoard(elements.values()), pending: pendingRequests(doc) }),
  );

  server.registerTool(
    'render_board',
    {
      title: 'Draw the board as a picture',
      description: [
        "Draws the board as a PNG picture, as Excalidraw exports it on white: its shapes, their labels and its images, from the helper's copy of the board, so it needs no page.",
        'Where the call leaves region out, it draws the bounds of every shape with a margin of 10; a region, with its x, y, width and height in the units get_board reads, draws that part of the board.',
        "The picture keeps the region's shape, and is at most max_width pixels wide and max_height pixels high, 1024 each when left out.",
        "It answers the picture, then region, width and height: the part of the board it drew and the picture's size in pixels, where the pixel (px, py) shows the board's point (region.x + px * region.width / width, region.y + py * region.height / height).",
        "It draws text in a font of the helper's machine, not in Excalidraw's hand-drawn font, and leaves out a frame's name.",
        "On a board that doesn't hold a shape, it refuses a call that leaves region out.",
      ].join(' '),
      inputSchema: {
        region: regionSchema.optional(),
        max_width: z.number().int().positive().optional(),
        max_height: z.number().int().positive().optional(),
      },
      outputSchema: { region: regionSchema, width: z.number().int(), height: z.number().int() },
    },
    async ({ region, max_width, max_height }) => {
      try {
        const drawn = await renderBoard(doc, {
          region,
          maxWidth: max_width ?? PICTURE_SIZE,
          maxHeight: max_height ?? PICTURE_SIZE,
        });
        const content = { region: drawn.region, width: drawn.width, height: drawn.height };
        const result: CallToolResult = {
          content: [
            { type: 'image', data: drawn.png.toString('base64'), mimeType: 'image/png' },
            { type: 'text', text: JSON.stringify(content) },
          ],
          structuredContent: content,
        };
        return result;
      } catch (error) {
        if (error instanceof RenderError) return refusal(error.message);
        throw error;
      }
    },
  );

  server.registerTool(
    'add_shapes',
    {
      title: 'Add shapes to the board',
      description: [
        "Adds shapes to the board in Excalidraw's skeleton format, above the shapes on it, and answers each new shape's id, in the order of the call's shapes.",
        'Each shape sets its type (rectangle, ellipse, diamond, text, arrow, line or freedraw), its x and its y, and may set an id.',
        'A rectangle, an ellipse or a diamond takes a width, a height and a label, and a text its text.',
        "A line's or an arrow's width and height say where it ends, from its x and y; or its points, each [x, y] from its x and y, say where it goes, so that one line or arrow draws a curve or a zigzag.",
        'A line that sets closed true goes back from its last point to its first, through three points or more, and its backgroundColor fills the shape it encloses.',
        'A freedraw is one stroke of the pen through its points, each [x, y] from its x and y.',
        "Where a shape's first point isn't [0, 0], its x and y move to that point.",
        "An arrow's start and end name shapes of the same call, which it binds to.",
        'Every shape may set strokeColor, strokeWidth (1, 2 or 4), strokeStyle (solid, dashed or dotted), fillStyle (solid, hachure, cross-hatch or zigzag), roughness (0, 1 or 2) and opacity (0 to 100), and a rectangle, an ellipse, a diamond or a line its backgroundColor.',
        "A text and a label may set fontFamily (Excalifont, Nunito, Comic Shanns or another of Excalidraw's fonts) and textAlign (left, center or right).",
        'Each new shape records the agent as its creator, which get_board lists.',
        "With group true, the call's shapes go into one new group, whose id the answer holds: update_shape moves the group by that id, and delete_shapes deletes it with groups.",
      ].join(' '),
      inputSchema: {
        shapes: z.array(shapeSchema).min(1),
        group: z.boolean().nullish().describe("Whether the call's shapes go into one new group, whose id the answer holds."),
      },
      outputSchema: {
        ids: z.array(z.string()),
        group: z.string().optional().describe("The id of the group the call's shapes went into, where the call asked for one."),
      },
    },
    ({ shapes, group }) =>
      refusing(async () => {
        const id = group === true ? newId() : undefined;
        const ids = await addShapes(doc, shapes, creator(), id);
        return answer(id === undefined ? { ids } : { ids, group: id });
      }),
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
        "To move a group, give group, the id get_board lists in its shapes' groups, instead of id, with x, y or both: the group's left and top edges go there, every shape of it moves with its label, each arrow bound to it follows it, and the answer holds the group's shapes.",
      ].join(' '),
      inputSchema: changeSchema.shape,
      outputSchema: { shape: boardShapeSchema.optional(), shapes: z.array(boardShapeSchema).optional() },
    },
    (change) =>
      refusing(async () =>
        change.group === undefined || change.group === null
          ? answer({ shape: await updateShape(doc, change, creator()) })
          : answer({ shapes: await moveGroup(doc, change) }),
      ),
  );

  server.registerTool(
    'delete_shapes',
    {
      title: 'Delete shapes from the board',
      description: [
        'Deletes shapes from the board by their ids, as get_board lists them, by their groups, or both, and answers the ids it deleted.',
        'Each shape whose groups hold one of groups goes, with its label.',
        "A shape's label goes with it, and each arrow bound to a deleted shape stays on the board, no longer bound at that end.",
      ].join(' '),
      inputSchema: deletionSchema.shape,
      outputSchema: { ids: z.array(z.string()) },
    },
    ({ ids, groups }) => refusing(async () => answer({ ids: deleteShapes(doc, ids ?? [], groups ?? []) })),
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

  // read_transcript, and the transcript as a resource with its notification.
  registerTranscript(server, doc);

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
