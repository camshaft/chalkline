/**
 * The drawing space a person chooses for their own browser: the canvas's background color and whether
 * its grid shows, which they set in Excalidraw's main menu. The page keeps them in the browser's storage,
 * as it keeps the person's name, and passes them to Excalidraw as it opens the board, so that they stay
 * across visits. They are this browser's, and don't reach the board's other pages.
 */

/** The key the drawing space has in the browser's storage. */
export const DRAWING_SPACE_KEY = 'chalkline.drawingSpace';

/** The part of a browser's storage that the drawing space reads and writes. */
export type DrawingSpaceStorage = Pick<Storage, 'getItem' | 'setItem'>;

/** The drawing space, as Excalidraw's app state holds it. */
export interface DrawingSpace {
  /** The canvas's background color. */
  viewBackgroundColor: string;
  /** Whether the canvas shows its grid. */
  gridModeEnabled: boolean;
}

/**
 * The drawing space `storage` keeps, as the part of Excalidraw's app state it sets: each kept value of the
 * right type, and neither where the browser doesn't keep a drawing space, keeps one that isn't JSON, or
 * refuses the read.
 */
export function keptDrawingSpace(storage: DrawingSpaceStorage | undefined): Partial<DrawingSpace> {
  if (storage === undefined) return {};
  let kept: unknown;
  try {
    const text = storage.getItem(DRAWING_SPACE_KEY);
    if (text === null) return {};
    kept = JSON.parse(text);
  } catch {
    return {};
  }
  if (typeof kept !== 'object' || kept === null) return {};
  const { viewBackgroundColor, gridModeEnabled } = kept as Record<string, unknown>;
  const space: Partial<DrawingSpace> = {};
  if (typeof viewBackgroundColor === 'string' && viewBackgroundColor !== '') space.viewBackgroundColor = viewBackgroundColor;
  if (typeof gridModeEnabled === 'boolean') space.gridModeEnabled = gridModeEnabled;
  return space;
}

/** Keeps `space` in `storage`. A browser that refuses the write keeps the drawing space it held. */
export function keepDrawingSpace(storage: DrawingSpaceStorage | undefined, space: DrawingSpace): void {
  if (storage === undefined) return;
  try {
    storage.setItem(DRAWING_SPACE_KEY, JSON.stringify(space));
  } catch {
    // The browser refuses to keep it, as a private window can; the drawing space still holds this visit.
  }
}

/** Where `keepDrawingSpaceChanges` reads the drawing space and its changes. */
export interface DrawingSpaceSource {
  /** The drawing space now. */
  current(): DrawingSpace;
  /** Calls `listener` on each change of Excalidraw's scene or app state; returns the call that stops it. */
  onChange(listener: () => void): () => void;
}

/**
 * Keeps the drawing space in `storage` each time it changes. It writes only where the background color or
 * the grid changed since the last write, or since it started, so that a drawing's many changes don't each
 * write. Returns `stop`, which stops following the changes.
 */
export function keepDrawingSpaceChanges(storage: DrawingSpaceStorage | undefined, source: DrawingSpaceSource): () => void {
  let last = source.current();
  return source.onChange(() => {
    const now = source.current();
    if (now.viewBackgroundColor === last.viewBackgroundColor && now.gridModeEnabled === last.gridModeEnabled) return;
    last = now;
    keepDrawingSpace(storage, now);
  });
}
