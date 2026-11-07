import { z } from 'zod';

const id = z
  .string()
  .min(1)
  .describe("The shape's id, which an arrow's start or end names; chalkline-mcp makes one where it is left out.");
const coordinate = z.number().finite();
const size = z.number().finite().positive();
const color = z.string().min(1).describe('A CSS color, such as #1971c2 or transparent.');
const label = z.object({ text: z.string().min(1) }).describe('The text inside the shape.');
const endpoint = (which: string) =>
  z
    .string()
    .min(1)
    .describe(`The id of the rectangle, ellipse, diamond or text of the same call that the arrow ${which}.`);
const point = z.array(coordinate).length(2).describe("A point, as [x, y]: how far right of and below the shape's x and y it lies.");
/** The points of a line or an arrow, which say where it goes in place of its width and height. */
const points = (kind: 'line' | 'arrow') =>
  z
    .array(point)
    .min(2)
    .describe(
      `The points the ${kind} goes through, in order, each [x, y] from the ${kind}'s x and y, in place of its width and height, so that one ${kind} holds a whole curve or zigzag. Where the first point isn't [0, 0], the ${kind}'s x and y move to it.`,
    );

const box = {
  id: id.optional(),
  x: coordinate.describe("The shape's left edge."),
  y: coordinate.describe("The shape's top edge."),
  width: size.optional(),
  height: size.optional(),
  label: label.optional(),
  strokeColor: color.optional(),
  backgroundColor: color.optional(),
};

/** One shape that add_shapes adds, in Excalidraw's skeleton format. */
export const shapeSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('rectangle'), ...box }),
  z.object({ type: z.literal('ellipse'), ...box }),
  z.object({ type: z.literal('diamond'), ...box }),
  z.object({
    type: z.literal('text'),
    id: id.optional(),
    x: coordinate.describe("The text's left edge."),
    y: coordinate.describe("The text's top edge."),
    text: z.string().min(1),
    fontSize: size.optional(),
    strokeColor: color.optional(),
  }),
  z.object({
    type: z.literal('arrow'),
    id: id.optional(),
    x: coordinate.describe("The x of the arrow's first point."),
    y: coordinate.describe("The y of the arrow's first point."),
    width: coordinate.optional().describe('How far right of its first point the arrow ends, or left where negative.'),
    height: coordinate.optional().describe('How far below its first point the arrow ends, or above where negative.'),
    points: points('arrow').optional(),
    label: label.optional(),
    start: endpoint('starts at').optional(),
    end: endpoint('ends at').optional(),
    strokeColor: color.optional(),
  }),
  z.object({
    type: z.literal('line'),
    id: id.optional(),
    x: coordinate.describe("The x of the line's first point."),
    y: coordinate.describe("The y of the line's first point."),
    width: coordinate.optional().describe('How far right of its first point the line ends, or left where negative.'),
    height: coordinate.optional().describe('How far below its first point the line ends, or above where negative.'),
    points: points('line').optional(),
    closed: z
      .boolean()
      .optional()
      .describe(
        'Whether the line goes back from its last point to its first, enclosing a shape that its backgroundColor fills. A closed line needs points, three or more.',
      ),
    strokeColor: color.optional(),
    backgroundColor: z
      .string()
      .min(1)
      .optional()
      .describe('A CSS color, such as #ffc9c9, that fills the shape a closed line encloses.'),
  }),
  z.object({
    type: z.literal('freedraw'),
    id: id.optional(),
    x: coordinate.describe("The x of the stroke's first point."),
    y: coordinate.describe("The y of the stroke's first point."),
    points: z
      .array(point)
      .min(2)
      .describe(
        "The pen's path, in order, each point [x, y] from the stroke's x and y, drawn as one stroke by hand. Where the first point isn't [0, 0], the stroke's x and y move to it.",
      ),
    strokeColor: color.optional(),
  }),
]);

/** Who added a shape, where an agent did: the agent, by the name its MCP client gave as it connected. */
export const creatorSchema = z.object({
  kind: z.literal('agent'),
  name: z.string().describe("The name the agent's client gave as it connected."),
});

/** The most points of one stroke that get_board lists; of a stroke that holds more, it lists this many, evenly spaced. */
export const LISTED_POINTS = 100;

/** One shape on the board, as get_board answers it. */
export const boardShapeSchema = z.object({
  id: z.string(),
  kind: z
    .string()
    .describe("Excalidraw's type of the shape, such as rectangle, ellipse, diamond, text, arrow, line or freedraw."),
  x: z.number(),
  y: z.number(),
  width: z
    .number()
    .describe("The shape's width, or for an arrow or a line how far right of its first point it ends, or left where negative."),
  height: z
    .number()
    .describe("The shape's height, or for an arrow or a line how far below its first point it ends, or above where negative."),
  label: z.string().optional().describe("A text's text, or the text inside a shape or on an arrow."),
  start: z.string().optional().describe("The id of the shape an arrow's start is bound to."),
  end: z.string().optional().describe("The id of the shape an arrow's end is bound to."),
  creator: creatorSchema
    .optional()
    .describe('The agent that added the shape; a shape that a person drew, or a page added for them, has none.'),
  points: z
    .array(z.array(z.number()).length(2))
    .optional()
    .describe(
      `A line's, an arrow's or a freehand stroke's points, each [x, y] from the shape's x and y. Of a stroke that holds more than ${LISTED_POINTS} points, ${LISTED_POINTS} of them, evenly spaced from its first to its last.`,
    ),
  pointCount: z
    .number()
    .int()
    .optional()
    .describe('How many points the stroke holds, where points lists only some of them.'),
});

/** The arrow that connect draws between two shapes on the board. */
export const connectionSchema = z.object({
  start: z
    .string()
    .min(1)
    .describe('The id of the shape the arrow starts at: a rectangle, an ellipse, a diamond, a text, an image or a frame.'),
  end: z.string().min(1).describe('The id of the shape the arrow ends at, of the same kinds as start.'),
  id: z.string().min(1).nullish().describe("The arrow's id; chalkline-mcp makes one where it is left out."),
  label: label.nullish().describe('The text on the arrow.'),
  strokeColor: color.nullish(),
});

/**
 * The change update_shape makes to one shape on the board. A field left out, or given as null,
 * stays as it is.
 */
export const changeSchema = z.object({
  id: z.string().min(1).describe('The id of the shape to change, as get_board lists it.'),
  x: coordinate.nullish().describe("The shape's new left edge, or the new x of an arrow's or a line's first point."),
  y: coordinate.nullish().describe("The shape's new top edge, or the new y of an arrow's or a line's first point."),
  width: coordinate
    .nullish()
    .describe(
      "A rectangle's, an ellipse's or a diamond's new width, above 0; or how far right of its first point a straight arrow or line now ends, or left where negative.",
    ),
  height: coordinate
    .nullish()
    .describe(
      "A rectangle's, an ellipse's or a diamond's new height, above 0; or how far below its first point a straight arrow or line now ends, or above where negative.",
    ),
  label: z
    .object({ text: z.string() })
    .nullish()
    .describe("The new text inside a rectangle, an ellipse or a diamond, or on an arrow; an empty text removes the label."),
  text: z.string().min(1).nullish().describe("A text's new text."),
  fontSize: size.nullish().describe("A text's new font size."),
  strokeColor: color.nullish().describe('The new color of the shape and its label, a CSS color such as #1971c2.'),
  backgroundColor: color.nullish().describe("The new fill of a rectangle, an ellipse or a diamond, a CSS color such as #a5d8ff."),
});

/** The shapes that delete_shapes deletes. */
export const deletionSchema = z.object({
  ids: z.array(z.string().min(1)).min(1).describe('The ids of the shapes to delete, as get_board lists them.'),
});

export type Shape = z.infer<typeof shapeSchema>;
export type BoardShape = z.infer<typeof boardShapeSchema>;
export type Connection = z.infer<typeof connectionSchema>;
export type ShapeChange = z.infer<typeof changeSchema>;
