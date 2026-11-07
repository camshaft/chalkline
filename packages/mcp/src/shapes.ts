import { z } from 'zod';

const id = z
  .string()
  .min(1)
  .describe("The shape's id, which an arrow's start or end names; chalkline-mcp makes one where it is left out.");
const coordinate = z.number().finite();
const size = z.number().finite().positive();
const color = z.string().min(1).describe('A CSS color, such as #1971c2 or transparent.');
const label = z.object({ text: z.string().min(1) }).describe('The text inside the shape.');

/** Excalidraw's stroke widths: thin, bold and extra bold. */
export const STROKE_WIDTH = { thin: 1, bold: 2, extraBold: 4 } as const;
/** Excalidraw's roughness: architect (clean lines), artist and cartoonist. */
export const ROUGHNESS = { architect: 0, artist: 1, cartoonist: 2 } as const;
/** Excalidraw's stroke styles. */
export const STROKE_STYLES = ['solid', 'dashed', 'dotted'] as const;
/** Excalidraw's fill styles, which say how a background color fills a shape. */
export const FILL_STYLES = ['solid', 'hachure', 'cross-hatch', 'zigzag'] as const;
/** Excalidraw's text alignments. */
export const TEXT_ALIGNS = ['left', 'center', 'right'] as const;
/** Excalidraw's fonts by name, each with the number an element's fontFamily holds, as Excalidraw's FONT_FAMILY lists them. */
export const FONT_FAMILY = {
  Virgil: 1,
  Helvetica: 2,
  Cascadia: 3,
  Excalifont: 5,
  Nunito: 6,
  'Lilita One': 7,
  'Comic Shanns': 8,
  'Liberation Sans': 9,
} as const;
export type FontName = keyof typeof FONT_FAMILY;

/** The value Excalidraw sets for each style field that a shape leaves out, which get_board doesn't report. */
export const DEFAULT_STYLE = { strokeWidth: 2, strokeStyle: 'solid', fillStyle: 'solid', roughness: 1, opacity: 100 } as const;
/** The font Excalidraw sets for a text or a label that doesn't set one. */
export const DEFAULT_FONT: FontName = 'Excalifont';

/** The style fields that every shape add_shapes adds may set, each to one of the values Excalidraw offers. */
const style = {
  strokeWidth: z
    .nativeEnum(STROKE_WIDTH)
    .optional()
    .describe('The width of its strokes: 1 (thin), 2 (bold, the default) or 4 (extra bold).'),
  strokeStyle: z.enum(STROKE_STYLES).optional().describe('Its strokes: solid (the default), dashed or dotted.'),
  fillStyle: z
    .enum(FILL_STYLES)
    .optional()
    .describe('How its background color fills it: solid (the default), hachure, cross-hatch or zigzag.'),
  roughness: z
    .nativeEnum(ROUGHNESS)
    .optional()
    .describe('How hand-drawn its strokes look: 0 (clean lines), 1 (the default) or 2 (rough).'),
  opacity: z
    .number()
    .int()
    .min(0)
    .max(100)
    .optional()
    .describe('How opaque it is, from 0 (invisible) to 100 (opaque, the default).'),
};
const fontFamily = z
  .enum(Object.keys(FONT_FAMILY) as [FontName, ...FontName[]])
  .optional()
  .describe("Its font: Excalifont (hand-drawn, the default), Nunito (plain), Comic Shanns (code), or another of Excalidraw's fonts.");
const textAlign = (fallback: (typeof TEXT_ALIGNS)[number]) =>
  z
    .enum(TEXT_ALIGNS)
    .optional()
    .describe(`How its lines align: left, center or right, and ${fallback} where it is left out.`);
/** The label of a shape that add_shapes adds, which may set its font and alignment. */
const shapeLabel = z
  .object({ text: z.string().min(1), fontFamily, textAlign: textAlign('center') })
  .describe('The text inside the shape.');
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
  label: shapeLabel.optional(),
  strokeColor: color.optional(),
  backgroundColor: color.optional(),
  ...style,
};

/** One shape that add_shapes adds, in Excalidraw's skeleton format. */
export const shapeSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('rectangle'), ...box }),
  z.object({ type: z.literal('ellipse'), ...box }),
  z.object({ type: z.literal('diamond'), ...box }),
  z.object({
    type: z.literal('text'),
    id: id.optional(),
    x: coordinate.describe("The text's left edge, or its center or right edge where textAlign is center or right."),
    y: coordinate.describe("The text's top edge."),
    text: z.string().min(1),
    fontSize: size.optional(),
    fontFamily,
    textAlign: textAlign('left'),
    strokeColor: color.optional(),
    ...style,
  }),
  z.object({
    type: z.literal('arrow'),
    id: id.optional(),
    x: coordinate.optional().describe("The x of the arrow's first point, which an arrow that runs between its start and end may leave out."),
    y: coordinate.optional().describe("The y of the arrow's first point, which an arrow that runs between its start and end may leave out."),
    width: coordinate.optional().describe('How far right of its first point the arrow ends, or left where negative.'),
    height: coordinate.optional().describe('How far below its first point the arrow ends, or above where negative.'),
    points: points('arrow').optional(),
    label: shapeLabel.optional(),
    start: endpoint('starts at').optional(),
    end: endpoint('ends at').optional(),
    strokeColor: color.optional(),
    ...style,
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
    ...style,
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
    ...style,
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
  label: z.string().optional().describe("A text's text, the text inside a shape or on an arrow, or a frame's name."),
  start: z.string().optional().describe("The id of the shape an arrow's start is bound to."),
  end: z.string().optional().describe("The id of the shape an arrow's end is bound to."),
  strokeColor: z.string().optional().describe("The shape's stroke color."),
  backgroundColor: z.string().optional().describe("The shape's background color, transparent where it has none."),
  strokeWidth: z.number().optional().describe('Its stroke width, where it is not 2, the default.'),
  strokeStyle: z.string().optional().describe('Its stroke style, where it is not solid, the default.'),
  fillStyle: z.string().optional().describe('Its fill style, where it is not solid, the default.'),
  roughness: z.number().optional().describe('Its roughness, where it is not 1, the default.'),
  opacity: z.number().optional().describe('Its opacity, where it is not 100, the default.'),
  fontFamily: z
    .string()
    .optional()
    .describe('The font of a text, or of the label inside a shape or on an arrow, where it is not Excalifont, the default.'),
  textAlign: z
    .string()
    .optional()
    .describe('How the lines of a text or a label align, where it is not the default: left for a text, and center for a label.'),
  groups: z
    .array(z.string())
    .optional()
    .describe('The ids of the groups the shape is in, the innermost first; a shape in no group has none.'),
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

/** A frame on the board, as get_board lists it among its frames. */
export const boardFrameSchema = z.object({
  id: z.string().describe("The frame's id, which update_shape moves or renames it by."),
  name: z.string().optional().describe("The frame's name, which the page shows above it; a frame without a name has none."),
  x: z.number().describe("The frame's left edge."),
  y: z.number().describe("The frame's top edge."),
  width: z.number(),
  height: z.number(),
  members: z
    .array(z.string())
    .describe("The ids of the shapes in the frame, from back to front, as get_board lists them in shapes; a shape's label goes with its shape."),
});

/** The frame that add_shapes puts a call's shapes into. */
export const frameSchema = z.object({
  name: z.string().min(1).describe("The frame's name, which the page shows above it and lists in its frames list."),
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
 * The change update_shape makes to one shape on the board, by its id, or to every shape of a group,
 * which it moves, by the group's id. A field left out, or given as null, stays as it is.
 */
export const changeSchema = z.object({
  id: z
    .string()
    .min(1)
    .nullish()
    .describe('The id of the shape to change, as get_board lists it; leave it out to move a group.'),
  group: z
    .string()
    .min(1)
    .nullish()
    .describe(
      "The id of a group to move, as get_board lists it in a shape's groups, instead of id: x and y say where the group's left and top edges go.",
    ),
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
  name: z.string().min(1).nullish().describe("A frame's new name."),
});

/** The shapes that delete_shapes deletes: by their ids, by their groups, or both. */
export const deletionSchema = z.object({
  ids: z.array(z.string().min(1)).min(1).nullish().describe('The ids of the shapes to delete, as get_board lists them.'),
  groups: z
    .array(z.string().min(1))
    .min(1)
    .nullish()
    .describe("The ids of groups to delete with every shape in them, as get_board lists them in a shape's groups."),
});

/** Where shapes go in the board's stacking order, which get_board lists from back to front. */
export const placeSchema = z
  .union([
    z.enum(['front', 'back']),
    z.object({ below: z.string().min(1) }).strict(),
    z.object({ above: z.string().min(1) }).strict(),
  ])
  .describe(
    'Where the shapes go in the order get_board lists, from back to front: "front", in front of every shape; "back", behind every shape; {"below": id}, just below the shape with that id; or {"above": id}, just above that shape and its label.',
  );

/** The shapes that reorder_shapes moves, and where it moves them. */
export const reorderSchema = z.object({
  ids: z
    .array(z.string().min(1))
    .min(1)
    .describe('The ids of the shapes to move, as get_board lists them; they keep their order among themselves.'),
  place: placeSchema,
});

/** The shapes that scale_shapes scales, by their ids, by their groups, or both, and by how much. */
export const scalingSchema = z.object({
  ids: z.array(z.string().min(1)).min(1).nullish().describe('The ids of the shapes to scale, as get_board lists them.'),
  groups: z
    .array(z.string().min(1))
    .min(1)
    .nullish()
    .describe("The ids of groups to scale with every shape in them, as get_board lists them in a shape's groups."),
  factor: size.describe('How many times its size each shape becomes, above 0: 0.5 halves it, and 2 doubles it.'),
  about: z
    .object({ x: coordinate, y: coordinate })
    .nullish()
    .describe(
      "The point the shapes scale around, which stays where it is; where it is left out, the left and top edges of the shapes' bounds stay where they are.",
    ),
});

/** The picture that add_image places on the board, and where it places it. */
export const imageSchema = z.object({
  path: z
    .string()
    .min(1)
    .nullish()
    .describe('The path of a PNG, JPEG or SVG file on the machine that runs chalkline-mcp; give path or data_url.'),
  data_url: z
    .string()
    .min(1)
    .nullish()
    .describe('The picture as a data URL, such as data:image/png;base64,...; give path or data_url.'),
  x: coordinate.describe("The x of the picture's top left corner, in the units get_board reads."),
  y: coordinate.describe("The y of the picture's top left corner, in the units get_board reads."),
  width: size.describe("The picture's width on the board, in the units get_board reads."),
  height: size
    .nullish()
    .describe("The picture's height on the board; where it is left out, the height that keeps the picture's proportions."),
  place: placeSchema.nullish(),
});

/** The shapes that flatten turns into one picture: by their ids, by their groups, by a region, or by the ids and the groups together. */
export const flattenSchema = z.object({
  ids: z.array(z.string().min(1)).min(1).nullish().describe('The ids of the shapes to turn into the picture, as get_board lists them.'),
  groups: z
    .array(z.string().min(1))
    .min(1)
    .nullish()
    .describe("The ids of groups whose shapes turn into the picture, as get_board lists them in a shape's groups."),
  region: z
    .object({ x: coordinate, y: coordinate, width: size, height: size })
    .nullish()
    .describe('A part of the board, in the units get_board reads: each shape that lies wholly inside it turns into the picture.'),
  scale: size
    .nullish()
    .describe("How many pixels the picture holds for each of the board's units, across and down; 2 where it is left out."),
});

export type Shape = z.infer<typeof shapeSchema>;
export type BoardShape = z.infer<typeof boardShapeSchema>;
export type BoardFrame = z.infer<typeof boardFrameSchema>;
export type Connection = z.infer<typeof connectionSchema>;
export type ShapeChange = z.infer<typeof changeSchema>;
export type Place = z.infer<typeof placeSchema>;
export type Scaling = z.infer<typeof scalingSchema>;
export type ImageRequest = z.infer<typeof imageSchema>;
export type FlattenRequest = z.infer<typeof flattenSchema>;
