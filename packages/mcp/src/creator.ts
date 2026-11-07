// The creator mark and the change mark: each shape that chalkline-mcp adds, through its tools or
// through a Mermaid request that a page converts, records the agent in the element's `customData`,
// so that the agent can tell the shapes it added, and change them, from the shapes the people drew.
// Each element that chalkline-mcp adds or changes also records the agent as the author of the
// element's version, so that a person's later change of a shape an agent added, which sets a new
// version on the element, reads as the person's. A text's change mark also records the words the
// agent wrote, which stay the agent's after a later change that leaves them as they are, such as a
// person's move of the text. Each page's binding also records on the board's copy of each text the
// words mark: its words, and when they last changed, and on the board's copy of each freehand
// stroke the drawing mark: a digest of its place and points, and when they last changed. This
// module reads and writes the four marks, and runs in Node and in the browser alike.

/** The member of an element's `customData` that holds Chalkline's fields. */
export const CUSTOM_DATA = 'chalkline';

/** Who added a shape: an agent, by the name its MCP client gave as it connected. */
export interface Creator {
  kind: 'agent';
  name: string;
}

/**
 * The change mark: the agent that wrote a version of an element, and that version, by the
 * element's `version` and `versionNonce`. Each later change of the element, such as a person's,
 * sets a new version and a new nonce on it and keeps its `customData`, so that the mark then
 * records a version the element no longer has.
 */
export interface Change {
  by: Creator;
  version: number;
  versionNonce: number;
  /**
   * The words of the version, where the element is a text, as Excalidraw keeps them unwrapped:
   * they stay the agent's words after a later change of the element that leaves them as they are.
   */
  words?: string;
}

/**
 * A copy of `element` whose `customData` records `creator` as the shape's creator, and as the
 * author of the element's version where the element holds one. The other members of the element,
 * of its `customData` and of Chalkline's member there stay as they are, and `element` itself
 * doesn't change.
 */
export function withCreator<T extends object>(element: T, creator: Creator): T {
  return withChange(withFields(element, { creator: agentOf(creator) }), creator);
}

/**
 * A copy of `element` whose `customData` records `agent` as the author of the element's version,
 * by its `version` and its `versionNonce`, and, where `element` is a text, the words it holds. The
 * other members of the element, of its `customData` and of Chalkline's member there stay as they
 * are, and `element` itself doesn't change. Where `element` doesn't hold a version and a nonce, it
 * answers `element` itself, since a mark without a version would match any later version.
 */
export function withChange<T extends object>(element: T, agent: Creator): T {
  const { version, versionNonce } = element as { version?: unknown; versionNonce?: unknown };
  if (!finite(version) || !finite(versionNonce)) return element;
  const change: Change = { by: agentOf(agent), version, versionNonce };
  const words = wordsOf(element);
  if (words !== undefined) change.words = words;
  return withFields(element, { change });
}

/** The creator that the `customData` of `element` records, or undefined where it doesn't hold a mark of this form. */
export function creatorOf(element: unknown): Creator | undefined {
  return agentIn(fieldsOf(element)?.creator);
}

/**
 * The agent that wrote the version `element` holds: the agent of its change mark, where the
 * mark's version and nonce are the element's. An element that holds a creator mark and no change
 * mark, as chalkline-mcp wrote each shape before it wrote change marks, reads as its creator's.
 * Undefined for any other element, such as one whose last change a person made.
 */
export function changerOf(element: unknown): Creator | undefined {
  const fields = fieldsOf(element);
  const change = recordOf(fields?.change);
  if (change === undefined) return agentIn(fields?.creator);
  const current = recordOf(element);
  const by = agentIn(change.by);
  if (by === undefined || change.version !== current?.version || change.versionNonce !== current?.versionNonce) {
    return undefined;
  }
  return by;
}

/**
 * The words that the change mark of `element` records its agent wrote, whatever version the
 * element holds now, where the mark records words: a later change that leaves the element's words
 * as they are, such as a person's move of an agent's text, leaves them the agent's words.
 * Undefined for any other element.
 */
export function agentWordsOf(element: unknown): string | undefined {
  const change = recordOf(fieldsOf(element)?.change);
  if (change === undefined || agentIn(change.by) === undefined) return undefined;
  return typeof change.words === 'string' ? change.words : undefined;
}

/**
 * The words mark: the words of a text, as Excalidraw keeps them unwrapped, and when a page last
 * changed them, in milliseconds since the epoch. Each page's binding records it on the board's
 * copy of each text it writes, so that a reader that receives only the newest copy of a text, as a
 * peer's copy of the board holds it, tells a change of its words from a change that leaves them as
 * they are, such as a person's move of the text.
 */
export interface WordsChanged {
  words: string;
  at: number;
}

/**
 * When the words of the text `element` holds last changed, as its words mark records it, where the
 * mark holds those words. Undefined where the element isn't a text or doesn't hold a mark, and where
 * its mark holds other words, as where a page that doesn't write the mark changed them and kept the
 * element's `customData` as it was.
 */
export function wordsChangedOf(element: unknown): number | undefined {
  const fields = recordOf(element);
  const words = fields === undefined ? undefined : wordsOf(fields);
  const mark = recordOf(fieldsOf(element)?.wordsChanged);
  const at = mark?.at;
  if (words === undefined || mark?.words !== words || !finite(at)) return undefined;
  return at;
}

/**
 * A copy of the text `element`, which a page writes over `current`, the board's copy of the
 * element before the change, or undefined where the board doesn't hold one, whose words mark
 * records when its words last changed: the time the mark of `current` records, where the words are
 * those of `current`, and else the element's `updated`, the time of the change that wrote them. It
 * answers `element` itself where the element isn't a text or doesn't hold an `updated` time, and
 * where its words are those of `current` and `current` doesn't record when they changed, since the
 * page can't tell. The other members of the element, of its `customData` and of Chalkline's member
 * there stay as they are, and `element` itself doesn't change.
 */
export function withWordsChanged<T extends object>(element: T, current: unknown): T {
  const words = wordsOf(element);
  const { updated } = element as { updated?: unknown };
  if (words === undefined || !finite(updated)) return element;
  const changed = (at: number): T => withFields(element, { wordsChanged: { words, at } satisfies WordsChanged });
  const before = recordOf(current);
  if (before === undefined || wordsOf(before) !== words) return changed(updated);
  const at = wordsChangedOf(before);
  return at === undefined ? element : changed(at);
}

/**
 * The drawing mark: a digest of the drawing of a freehand stroke, its place and its points, as
 * `drawingOf` reads it, and when a page last changed them, in milliseconds since the epoch. Each
 * page's binding records it on the board's copy of each stroke it writes, so that a reader that
 * receives only the newest copy of a stroke, as a peer's copy of the board holds it, tells a change
 * of its place or its points from a save that leaves them as they are, such as where Excalidraw
 * sets a new version or index on the stroke.
 */
export interface DrawingChanged {
  drawing: string;
  at: number;
}

/**
 * A digest of the drawing of the freehand stroke `element` holds: its x, its y and its points, as
 * 8 hex digits. Two copies of a stroke with the same place and points have the same digest,
 * whatever else differs, such as their version, index or `updated`. Undefined where the element
 * isn't a freehand stroke.
 */
export function drawingOf(element: unknown): string | undefined {
  const fields = recordOf(element);
  if (fields?.type !== 'freedraw') return undefined;
  return digest(JSON.stringify([fields.x, fields.y, fields.points]));
}

/**
 * When the place and points of the freehand stroke `element` holds last changed, as its drawing
 * mark records it, where the mark holds the stroke's drawing. Undefined where the element isn't a
 * stroke or doesn't hold a mark, and where its mark holds another drawing, as where a page that
 * doesn't write the mark moved the stroke or changed its points and kept the element's
 * `customData` as it was.
 */
export function drawingChangedOf(element: unknown): number | undefined {
  const drawing = drawingOf(element);
  const mark = recordOf(fieldsOf(element)?.drawingChanged);
  const at = mark?.at;
  if (drawing === undefined || mark?.drawing !== drawing || !finite(at)) return undefined;
  return at;
}

/**
 * A copy of the freehand stroke `element`, which a page writes over `current`, the board's copy
 * of the element before the change, or undefined where the board doesn't hold one, whose drawing
 * mark records when its place and points last changed: the time the mark of `current` records,
 * where the place and points are those of `current`, and else the element's `updated`, the time
 * of the change that drew them. It answers `element` itself where the element isn't a stroke or
 * doesn't hold an `updated` time, and where its place and points are those of `current` and
 * `current` doesn't record when they changed, since the page can't tell. The other members of the
 * element, of its `customData` and of Chalkline's member there stay as they are, and `element`
 * itself doesn't change.
 */
export function withDrawingChanged<T extends object>(element: T, current: unknown): T {
  const drawing = drawingOf(element);
  const { updated } = element as { updated?: unknown };
  if (drawing === undefined || !finite(updated)) return element;
  const changed = (at: number): T => withFields(element, { drawingChanged: { drawing, at } satisfies DrawingChanged });
  if (drawingOf(current) !== drawing) return changed(updated);
  const at = drawingChangedOf(current);
  return at === undefined ? element : changed(at);
}

/** A copy of `element` whose Chalkline member of `customData` holds `fields` beside its other members. */
function withFields<T extends object>(element: T, fields: Record<string, unknown>): T {
  const customData = recordOf((element as { customData?: unknown }).customData) ?? {};
  const own = recordOf(customData[CUSTOM_DATA]) ?? {};
  return { ...element, customData: { ...customData, [CUSTOM_DATA]: { ...own, ...fields } } };
}

/** The words of `element` where it is a text, as Excalidraw keeps them unwrapped, else as it shows them. */
function wordsOf(element: object): string | undefined {
  const { type, text, originalText } = element as { type?: unknown; text?: unknown; originalText?: unknown };
  if (type !== 'text') return undefined;
  if (typeof originalText === 'string') return originalText;
  return typeof text === 'string' ? text : undefined;
}

/** Chalkline's member of the `customData` of `element`, where it holds one. */
function fieldsOf(element: unknown): Record<string, unknown> | undefined {
  return recordOf(recordOf(recordOf(element)?.customData)?.[CUSTOM_DATA]);
}

/** A copy of `agent` with its kind and its name alone. */
function agentOf(agent: Creator): Creator {
  return { kind: agent.kind, name: agent.name };
}

/** The agent that `value` records, where it holds one of this form. */
function agentIn(value: unknown): Creator | undefined {
  const agent = recordOf(value);
  if (agent?.kind !== 'agent' || typeof agent.name !== 'string') return undefined;
  return { kind: 'agent', name: agent.name };
}

/** The 32-bit FNV-1a hash of the UTF-16 code units of `text`, as 8 hex digits. */
function digest(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash = Math.imul(hash ^ text.charCodeAt(index), 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}
