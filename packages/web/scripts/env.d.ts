// The part of global-jsdom that the scripts call.
declare module 'global-jsdom' {
  export default function globalJsdom(html?: string, options?: Record<string, unknown>): () => void;
}
