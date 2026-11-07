/**
 * Ends a press on the board whose release the page didn't receive, so that the next press acts. Excalidraw counts each
 * pointer pressed on its canvas from its `pointerdown` until its `pointerup` or `pointercancel`. While it counts more
 * than one, a press on the canvas doesn't draw or select, and two counted pointers pan and zoom the canvas as they
 * move, as two fingers do. Where the page doesn't receive a press's release, as Excalidraw's issue #8476 reports for a
 * Wacom pen in Chrome on a Mac, Excalidraw goes on counting that pointer: from then on a press of another pointer
 * pans the canvas instead of drawing or selecting, and once two releases are missed, a press doesn't act at all.
 */

/** A press of a pen or a mouse that reached the board, whose release or cancel the page hasn't received yet. */
interface Pressed {
  pointerId: number;
  pointerType: string;
  /** The element the press reached first, which receives the cancel. */
  target: EventTarget;
}

/** The events that end a press. */
const RELEASES = ['pointerup', 'pointercancel'] as const;

/**
 * Makes each press of a pen or a mouse end the press of another pointer on `element` whose release or cancel the
 * page didn't receive. As the new press starts on its way to the board, before the page's other listeners, it sends
 * the earlier pointer's `pointercancel` to the element its press reached, as a browser does where it ends a press, so
 * that Excalidraw stops counting that pointer. A pen and a mouse press one pointer at a time, while fingers press
 * several at once to pinch, so a touch neither ends a press nor counts as one. It counts a press that reached
 * `element`, and not one the page stopped before it, such as a press of the pen's side button that sets a tool, and a
 * release or a cancel that went through the page to the window. Returns `stop`, which stops it.
 */
export function bindMissedReleases(element: Element): () => void {
  const view = element.ownerDocument.defaultView;
  if (view === null) throw new Error("the board's element isn't in a window's document");
  let pressed: Pressed | null = null;
  const end = (event: Event) => {
    const press = event as PointerEvent;
    if (press.pointerType === 'touch' || pressed === null || pressed.pointerId === press.pointerId) return;
    const { pointerId, pointerType, target } = pressed;
    pressed = null;
    target.dispatchEvent(new view.PointerEvent('pointercancel', { pointerId, pointerType, bubbles: true, composed: true }));
  };
  const count = (event: Event) => {
    const press = event as PointerEvent;
    if (press.pointerType === 'touch' || event.target === null) return;
    pressed = { pointerId: press.pointerId, pointerType: press.pointerType, target: event.target };
  };
  const release = (event: Event) => {
    if (pressed !== null && (event as PointerEvent).pointerId === pressed.pointerId) pressed = null;
  };
  view.addEventListener('pointerdown', end, true);
  element.addEventListener('pointerdown', count, true);
  for (const type of RELEASES) view.addEventListener(type, release);
  return () => {
    view.removeEventListener('pointerdown', end, true);
    element.removeEventListener('pointerdown', count, true);
    for (const type of RELEASES) view.removeEventListener(type, release);
  };
}
