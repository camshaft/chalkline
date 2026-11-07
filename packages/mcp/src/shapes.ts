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

/** One shape on the board, as get_board answers it. */
export const boardShapeSchema = z.object({
  id: z.string(),
  kind: z.string().describe("Excalidraw's type of the shape, such as rectangle, ellipse, diamond, text, arrow or line."),
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number(),
  label: z.string().optional().describe("A text's text, or the text inside a shape or on an arrow."),
  start: z.string().optional().describe("The id of the shape an arrow's start is bound to."),
  end: z.string().optional().describe("The id of the shape an arrow's end is bound to."),
});

export type Shape = z.infer<typeof shapeSchema>;
export type BoardShape = z.infer<typeof boardShapeSchema>;
