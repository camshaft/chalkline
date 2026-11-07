import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type * as Y from 'yjs';
import { addShapes, ELEMENTS, readBoard, ShapeError } from './board';
import { boardShapeSchema, shapeSchema } from './shapes';

/** chalkline-mcp's MCP server, whose tools read and draw on the board that `doc` holds. */
export function createServer(doc: Y.Doc): McpServer {
  const server = new McpServer({ name: 'chalkline', version: '0.0.0' });
  const elements = doc.getMap<unknown>(ELEMENTS);

  server.registerTool(
    'get_board',
    {
      title: 'Read the board',
      description:
        'Reads the board: every shape on it, from back to front, with its id, kind, position, size and label, and for an arrow the ids of the shapes it starts and ends at.',
      outputSchema: { shapes: z.array(boardShapeSchema) },
    },
    () => answer({ shapes: readBoard(elements.values()) }),
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

  return server;
}

/** A tool's answer: its structured content, and the same JSON as text for clients that read text alone. */
function answer(content: Record<string, unknown>): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(content) }], structuredContent: content };
}

/** A tool's refusal, whose text says what to change. */
function refusal(message: string): CallToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}
