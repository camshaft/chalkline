// The frames list: a menu of the board's frames, in the board's order, beside the page's other
// controls. Choosing a frame scrolls and zooms the canvas to show it whole, so that a board that
// holds several drawings, each in a frame of its own, is quick to move around.

/** A frame of the board, as the frames list shows it: its id, its name and its bounds. */
export interface ListedFrame {
  id: string;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The fields of a scene's element that the frames list reads. */
export interface SceneElement {
  readonly id: string;
  readonly type: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly isDeleted?: boolean;
  readonly name?: string | null;
}

/** The name the list shows for a frame without one, as Excalidraw shows such a frame on the canvas. */
export const UNNAMED_FRAME = 'Frame';

/** The list's first option, which it shows while no frame is chosen. */
export const LIST_PROMPT = 'Go to a frame';

/** The frames of `elements`, the scene's elements in the board's order, each frame that isn't deleted. */
export function framesOf(elements: readonly SceneElement[]): ListedFrame[] {
  return elements.flatMap((element) =>
    element.type === 'frame' && element.isDeleted !== true
      ? [
          {
            id: element.id,
            name: typeof element.name === 'string' && element.name !== '' ? element.name : UNNAMED_FRAME,
            x: element.x,
            y: element.y,
            width: element.width,
            height: element.height,
          },
        ]
      : [],
  );
}

/** What the frames list reads and does. */
export interface FramesBoard {
  /** The board's frames, in the board's order. */
  frames(): ListedFrame[];
  /** Scrolls and zooms the canvas to show `frame` whole. */
  show(frame: ListedFrame): void;
  /** Calls `handler` after each change of the board. */
  onChange(handler: () => void): void;
}

/**
 * Fills `select` with its prompt and an option for each frame of `board`, by its name, in the
 * board's order, and fills it again after each change of the board that adds, removes, renames or
 * reorders a frame; the list hides while the board doesn't hold a frame. Choosing a frame shows it
 * where it lies at that moment, and the list goes back to its prompt, so that a person can choose
 * the same frame again.
 */
export function bindFramesList(select: HTMLSelectElement, board: FramesBoard): void {
  let listed: string[] | undefined;
  const fill = (): void => {
    const frames = board.frames();
    const entries = frames.map((frame) => `${frame.id}\n${frame.name}`);
    if (listed !== undefined && entries.length === listed.length && entries.every((entry, place) => entry === listed?.[place])) {
      return;
    }
    listed = entries;
    const options = [option(select, LIST_PROMPT, ''), ...frames.map((frame) => option(select, frame.name, frame.id))];
    select.replaceChildren(...options);
    select.value = '';
    select.hidden = frames.length === 0;
  };
  select.addEventListener('change', () => {
    const frame = board.frames().find((candidate) => candidate.id === select.value);
    select.value = '';
    if (frame !== undefined) board.show(frame);
  });
  board.onChange(fill);
  fill();
}

function option(select: HTMLSelectElement, text: string, value: string): HTMLOptionElement {
  const created = select.ownerDocument.createElement('option');
  created.textContent = text;
  created.value = value;
  return created;
}
