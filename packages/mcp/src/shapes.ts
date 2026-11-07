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
    strokeColor: color.optional(),
  }),
]);

/** Who added a shape, where an agent did: the agent, by the name its MCP client gave as it connected. */
export const creatorSchema = z.object({
  kind: z.literal('agent'),
  name: z.string().describe("The name the agent's client gave as it connected."),
});

/** One shape on the board, as get_board answers it. */
export const boardShapeSchema = z.object({
  id: z.string(),
  kind: z.string().describe("Excalidraw's type of the shape, such as rectangle, ellipse, diamond, text, arrow or line."),
  x: z.number().describe("The shape's left edge, or the x of an arrow's or a line's first point."),
  y: z.number().describe("The shape's top edge, or the y of an arrow's or a line's first point."),
  width: z
    .number()
    .describe("The shape's width, or how far right of its first point an arrow or a line ends, or left where negative."),
  height: z
    .number()
    .describe("The shape's height, or how far below its first point an arrow or a line ends, or above where negative."),
  label: z.string().optional().describe("A text's text, or the text inside a shape or on an arrow."),
  start: z.string().optional().describe("The id of the shape an arrow's start is bound to."),
  end: z.string().optional().describe("The id of the shape an arrow's end is bound to."),
  creator: creatorSchema
    .optional()
    .describe('The agent that added the shape; a shape that a person drew, or a page added for them, has none.'),
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
