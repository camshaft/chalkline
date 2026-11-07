import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

/** A tool's answer: its structured content, and the same JSON as text for clients that read text alone. */
export function answer(content: Record<string, unknown>): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(content) }], structuredContent: content };
}

/** A tool's refusal, whose text says what to change. */
export function refusal(message: string): CallToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}
