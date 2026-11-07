// The part of global-jsdom that skeleton.ts calls.
declare module 'global-jsdom' {
  export default function globalJsdom(html?: string, options?: Record<string, unknown>): () => void;
}
