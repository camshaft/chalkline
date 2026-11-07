import * as Y from 'yjs';

/**
 * How an entry came to the board's chat: "speech", a final result of a
 * browser's speech recognition; "typed", a message a person typed in the
 * chat's field; "agent", a message an agent posted.
 */
export type TranscriptVia = 'speech' | 'typed' | 'agent';

const VIAS: readonly string[] = ['speech', 'typed', 'agent'];

/**
 * One entry of the board's transcript, which the page shows as its chat: who
 * said, typed or posted it, when, the words, and how they came.
 */
export interface TranscriptEntry {
  /** The entry's id, unique on the board. */
  id: string;
  /** The name of the person or the agent, as the board showed it when the words came. */
  speaker: string;
  /** When the words came, as an ISO 8601 time. */
  at: string;
  /** The words. */
  text: string;
  /** How the words came. */
  via: TranscriptVia;
}

/** The transcript's name in the room's Yjs document. */
export const TRANSCRIPT = 'transcript';

/**
 * The board's transcript: a Y.Array that each participant appends its final
 * speech results, its typed messages and an agent's posts to, and that no one
 * edits.
 */
export function transcriptOf(doc: Y.Doc): Y.Array<unknown> {
  return doc.getArray<unknown>(TRANSCRIPT);
}

/** A new entry's id: 16 random hex digits. */
export function newEntryId(): string {
  const data = crypto.getRandomValues(new Uint8Array(8));
  return Array.from(data, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const filled = (value: unknown): value is string => typeof value === 'string' && value.trim() !== '';

const isVia = (value: unknown): value is TranscriptVia => typeof value === 'string' && VIAS.includes(value);

/**
 * Reads one entry, which may come from any peer: a value that isn't an
 * object, or that lacks one of the fields `id`, `speaker`, `at` and `text`,
 * holds one of the wrong type, or holds a time that doesn't parse, reads as
 * null. An entry without `via`, as each entry written before the chat, reads
 * as speech, and one whose `via` isn't "speech", "typed" or "agent" reads as
 * null. Other fields are left out.
 */
export function readEntry(value: unknown): TranscriptEntry | null {
  if (!isRecord(value)) return null;
  const { id, speaker, at, text, via = 'speech' } = value;
  if (!filled(id) || !filled(speaker) || !filled(at) || !filled(text)) return null;
  if (Number.isNaN(Date.parse(at))) return null;
  if (!isVia(via)) return null;
  return { id, speaker, at, text, via };
}

/** Every entry of `transcript` that reads as one, in the transcript's order. */
export function readTranscript(transcript: Y.Array<unknown>): TranscriptEntry[] {
  return transcript.toArray().flatMap((value) => {
    const entry = readEntry(value);
    return entry === null ? [] : [entry];
  });
}

/** Appends `entry` to the end of `transcript`, which sends it to every peer. */
export function appendEntry(transcript: Y.Array<unknown>, entry: TranscriptEntry): void {
  const { id, speaker, at, text, via } = entry;
  transcript.push([{ id, speaker, at, text, via }]);
}
