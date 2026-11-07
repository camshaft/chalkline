import type { Awareness } from '@chalkline/sync';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type * as Y from 'yjs';
import { answer, refusal } from './answer';
import { addShapes, ELEMENTS, FRAME_MARGIN, newId, readBoard, readFrames, ShapeError } from './board';
import { registerChanges } from './changes';
import type { Creator } from './creator';
import { connect, deleteShapes, moveGroup, reorderShapes, scaleShapes, updateShape } from './edit';
import { listedFeedback, listedFeedbackSchema, registerFeedback } from './feedback';
import { trackPresence } from './presence';
import { renderBoard, RenderError } from './render';
import { pendingRequests, RequestError, waitForRequest, writeMermaidRequest } from './requests';
import {
  boardFrameSchema,
  boardShapeSchema,
  changeSchema,
  connectionSchema,
  deletionSchema,
  frameSchema,
  LISTED_POINTS,
  placeSchema,
  reorderSchema,
  scalingSchema,
  shapeSchema,
} from './shapes';
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

/** The longest timeout render_board takes, in seconds: Node's setTimeout waits at most 2^31 - 1 milliseconds. */
const LONGEST_TIMEOUT = 2147483;

/**
 * chalkline-mcp's MCP server, whose tools read and draw on the board that `doc` holds. `awareness`
 * holds the room's participants, which tell the helper whether a page is in the room to convert a
 * Mermaid request, and the helper's own presence among them: its client's name, its status, and a
 * pointer at the shapes it last added or changed.
 */
export function createServer(doc: Y.Doc, awareness: Awareness): McpServer {
  const server = new McpServer({ name: 'chalkline', version: '0.0.0' });
  const elements = doc.getMap<unknown>(ELEMENTS);
  // Each tool call runs through the helper's presence, which shows the agent working while one runs.
  const presence = trackPresence(server, doc, awareness);
  // A call that adds, changes or deletes shapes, which answers a refusal where the work refuses them.
  const drawing = (work: () => Promise<CallToolResult>) => presence.run(() => refusing(work));

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
        `Reads the board: every shape on it, from back to front, with its id, kind, position, size and label, its stroke and background colors, each style field, font and alignment that isn't Excalidraw's default, for a shape in a group the ids of its groups, the innermost first, for an arrow the ids of the shapes it starts and ends at, for a line, an arrow or a freehand stroke its points, and for a shape an agent added, its creator; in pending, each Mermaid request that no page has converted yet; and, in feedback, each open feedback that people wrote on an area of the board, with its id, its writer as by, its text and its region, which read_feedback answers with the shapes the region meets, and answer_feedback answers; and, in frames, each frame from back to front, with its id, its name, its x, y, width and height, and as members the ids of the shapes in it, each shape's label going with its shape. A frame is among the shapes too, of kind frame, with its name as its label. An arrow's or a line's width and height say how far its last point lies right of and below its first, as add_shapes reads them. Of a stroke that holds more than ${LISTED_POINTS} points, it lists ${LISTED_POINTS} of them, evenly spaced from its first to its last, and their count in pointCount.`,
      outputSchema: {
        shapes: z.array(boardShapeSchema),
        pending: z.array(z.object({ id: z.string(), kind: z.literal('mermaid') })),
        feedback: z.array(listedFeedbackSchema),
        frames: z.array(boardFrameSchema),
      },
    },
    () =>
      presence.run(() =>
        answer({
          shapes: readBoard(elements.values()),
          pending: pendingRequests(doc),
          feedback: listedFeedback(doc),
          frames: readFrames(elements.values()),
        }),
      ),
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
        "It draws every text in DejaVu Sans, not in Excalidraw's hand-drawn font, and each character that DejaVu Sans lacks, such as most emoji and Chinese, Japanese or Korean characters, as a box; it leaves out a frame's name.",
        "On a board that doesn't hold a shape, it refuses a call that leaves region out.",
        `With timeout, in seconds, at most ${LONGEST_TIMEOUT}, it answers an error once the picture takes longer than that to draw, and it stops too where the client cancels the call.`,
        "resvg, which turns the board's SVG into the PNG, runs in a process of its own: where it fails or stops before it draws the picture, the call answers an error that says how, and the helper goes on.",
      ].join(' '),
      inputSchema: {
        region: regionSchema.optional(),
        max_width: z.number().int().positive().optional(),
        max_height: z.number().int().positive().optional(),
        timeout: z.number().positive().max(LONGEST_TIMEOUT).optional(),
      },
      outputSchema: { region: regionSchema, width: z.number().int(), height: z.number().int() },
    },
    ({ region, max_width, max_height, timeout }, extra) =>
      presence.run(async () => {
        try {
          const drawn = await renderBoard(doc, {
            region,
            maxWidth: max_width ?? PICTURE_SIZE,
            maxHeight: max_height ?? PICTURE_SIZE,
            timeout,
            signal: extra.signal,
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
      }),
  );

  server.registerTool(
    'add_shapes',
    {
      title: 'Add shapes to the board',
      description: [
        "Adds shapes to the board in Excalidraw's skeleton format, and answers each new shape's id, in the order of the call's shapes.",
        'Each shape sets its type (rectangle, ellipse, diamond, text, arrow, line or freedraw), its x and its y, and may set an id; an arrow that runs between two shapes, as below, may leave out its x and y.',
        'A rectangle, an ellipse or a diamond takes a width, a height and a label, and a text its text.',
        "A line's or an arrow's width and height say where it ends, from its x and y; or its points, each [x, y] from its x and y, say where it goes, so that one line or arrow draws a curve or a zigzag.",
        'A line that sets closed true goes back from its last point to its first, through three points or more, and its backgroundColor fills the shape it encloses.',
        'A freedraw is one stroke of the pen through its points, each [x, y] from its x and y.',
        "Where a shape's first point isn't [0, 0], its x and y move to that point.",
        "An arrow's start and end name shapes of the same call, which it binds to.",
        "An arrow that sets start and end and none of width, height and points runs between those two shapes, from the edge of start to the edge of end along the line between their centers, as connect draws an arrow.",
        'Every shape may set strokeColor, strokeWidth (1, 2 or 4), strokeStyle (solid, dashed or dotted), fillStyle (solid, hachure, cross-hatch or zigzag), roughness (0, 1 or 2) and opacity (0 to 100), and a rectangle, an ellipse, a diamond or a line its backgroundColor.',
        "A text and a label may set fontFamily (Excalifont, Nunito, Comic Shanns or another of Excalidraw's fonts) and textAlign (left, center or right).",
        'Each new shape records the agent as its creator, which get_board lists.',
        "With group true, the call's shapes go into one new group, whose id the answer holds: update_shape moves the group by that id, and delete_shapes deletes it with groups.",
        `With frame, {"name": name}, the call's shapes go into one new frame of that name, ${FRAME_MARGIN} outside their bounds on each side and just in front of them, whose id the answer holds as frame: get_board lists it among its frames with the ids of its shapes, the page's frames list shows the frame when a person chooses its name, and update_shape moves the frame with its shapes, or renames it, by that id.`,
        'The new shapes go in front of every shape on the board, each in front of the shapes before it in the call; place puts them at the back of the board instead, or just below or just above a shape that get_board lists, as {"below": id} or {"above": id}.',
        'To draw a background behind shapes on the board, set place to {"below": id}, with id the first of those shapes that get_board lists, since it lists the board from back to front.',
        'reorder_shapes moves shapes forward or back once they are on the board.',
      ].join(' '),
      inputSchema: {
        shapes: z.array(shapeSchema).min(1),
        group: z.boolean().nullish().describe("Whether the call's shapes go into one new group, whose id the answer holds."),
        place: placeSchema.nullish(),
        frame: frameSchema.nullish().describe("The frame the call's shapes go into, a new one with this name."),
      },
      outputSchema: {
        ids: z.array(z.string()),
        group: z.string().optional().describe("The id of the group the call's shapes went into, where the call asked for one."),
        frame: z.string().optional().describe("The id of the frame the call's shapes went into, where the call asked for one."),
      },
    },
    ({ shapes, group, place, frame }) =>
      drawing(async () => {
        const id = group === true ? newId() : undefined;
        const framed = frame === undefined || frame === null ? undefined : { id: newId(), name: frame.name };
        const ids = await addShapes(doc, shapes, creator(), id, place ?? undefined, framed);
        await presence.drew(framed === undefined ? ids : [...ids, framed.id]);
        return answer({
          ids,
          ...(id === undefined ? {} : { group: id }),
          ...(framed === undefined ? {} : { frame: framed.id }),
        });
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
    (connection) =>
      drawing(async () => {
        const id = await connect(doc, connection, creator());
        await presence.drew([id]);
        return answer({ id });
      }),
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
        "A frame, by its id, takes x and y, its new left and top edges, and name, its new name: every shape in it moves with it, each with its label, and each arrow bound to them follows them.",
      ].join(' '),
      inputSchema: changeSchema.shape,
      outputSchema: { shape: boardShapeSchema.optional(), shapes: z.array(boardShapeSchema).optional() },
    },
    (change) =>
      drawing(async () => {
        if (change.group === undefined || change.group === null) {
          const shape = await updateShape(doc, change, creator());
          await presence.drew([shape.id]);
          return answer({ shape });
        }
        const shapes = await moveGroup(doc, change, creator());
        await presence.drew(shapes.map((shape) => shape.id));
        return answer({ shapes });
      }),
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
    ({ ids, groups }) => drawing(async () => answer({ ids: deleteShapes(doc, ids ?? [], groups ?? [], creator()) })),
  );

  server.registerTool(
    'reorder_shapes',
    {
      title: 'Move shapes forward or back',
      description: [
        "Moves shapes forward or back in the board's stacking order, the order get_board lists the board in, from back to front, and answers their ids in their new order, back to front.",
        'ids are the shapes to move, as get_board lists them.',
        'place is where they go: "front", in front of every other shape; "back", behind every other shape; {"below": id}, just below the shape with that id; or {"above": id}, just above that shape and its label.',
        "The moved shapes keep their order among themselves, whatever order ids lists them in, and a shape's label moves with it.",
      ].join(' '),
      inputSchema: reorderSchema.shape,
      outputSchema: { ids: z.array(z.string()) },
    },
    ({ ids, place }) => drawing(async () => answer({ ids: reorderShapes(doc, ids, place, creator()) })),
  );

  server.registerTool(
    'scale_shapes',
    {
      title: 'Scale shapes on the board',
      description: [
        'Makes shapes on the board smaller or larger in one change, by their ids, as get_board lists them, by their groups, or both, and answers them as get_board lists them after the change.',
        'Each shape whose groups hold one of groups scales, and each shape scales with its label.',
        "factor is how many times its size each shape becomes, and about is the point the shapes scale around: each shape's distance from that point, its width and its height, the points of a line, an arrow or a freehand stroke, and the font size of a text or a label scale by factor.",
        "Where about is left out, the left and top edges of the shapes' bounds stay where they are.",
        "An arrow that scales stays bound to each shape that scales with it, and each straight arrow between a shape that scales and one that doesn't is laid out again between them.",
      ].join(' '),
      inputSchema: scalingSchema.shape,
      outputSchema: { shapes: z.array(boardShapeSchema) },
    },
    (scaling) =>
      drawing(async () => {
        const shapes = await scaleShapes(doc, scaling, creator());
        await presence.drew(shapes.map((shape) => shape.id));
        return answer({ shapes });
      }),
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
    ({ text, at }, extra) =>
      presence.run(async () => {
        // The request says who wrote it, and the page marks the diagram's shapes with that name.
        const id = writeMermaidRequest(doc, text, creator().name, at);
        // The helper points at the diagram's shapes once a page adds them, whether or not this call still waits.
        presence.wrote(id);
        // The time the call waits for a page doesn't count as working.
        return answer(await presence.waiting(waitForRequest(doc, awareness, id, extra.signal)));
      }),
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
    ({ id }, extra) =>
      presence.run(async () => {
        try {
          return answer(await presence.waiting(waitForRequest(doc, awareness, id, extra.signal)));
        } catch (error) {
          if (error instanceof RequestError) return refusal(error.message);
          throw error;
        }
      }),
  );

  // read_changes, which answers the shapes added, changed and deleted after a cursor.
  registerChanges(server, doc);

  // read_transcript, and the transcript as a resource with its notification.
  registerTranscript(server, doc);

  // read_feedback and answer_feedback, and the open feedback as a resource with its notification.
  registerFeedback(server, doc);

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
