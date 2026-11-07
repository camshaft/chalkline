// The part of global-jsdom that @chalkline/mcp's skeleton.ts calls, which draw-box imports.
declare module 'global-jsdom' {
  export default function globalJsdom(html?: string, options?: Record<string, unknown>): () => void;
}
