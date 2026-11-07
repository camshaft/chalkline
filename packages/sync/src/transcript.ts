import * as Y from 'yjs';

/**
 * One final speech result on the board's transcript: who said it, when, and
 * the words the speaker's browser recognized.
 */
export interface TranscriptEntry {
  /** The entry's id, unique on the board. */
  id: string;
  /** The speaker's name, as the board showed it when they spoke. */
  speaker: string;
  /** When the speaker's browser recognized the words, as an ISO 8601 time. */
  at: string;
  /** The words. */
  text: string;
}

/** The transcript's name in the room's Yjs document. */
export const TRANSCRIPT = 'transcript';

/**
 * The board's transcript: a Y.Array that each participant appends its final
 * speech results to, and that no one edits.
 */
export function transcriptOf(doc: Y.Doc): Y.Array<unknown> {
  return doc.getArray<unknown>(TRANSCRIPT);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const filled = (value: unknown): value is string => typeof value === 'string' && value.trim() !== '';

/**
 * Reads one entry, which may come from any peer: a value that isn't an
 * object, or that lacks one of the four fields, holds one of the wrong type,
 * or holds a time that doesn't parse, reads as null. Other fields are left out.
 */
export function readEntry(value: unknown): TranscriptEntry | null {
  if (!isRecord(value)) return null;
  const { id, speaker, at, text } = value;
  if (!filled(id) || !filled(speaker) || !filled(at) || !filled(text)) return null;
  if (Number.isNaN(Date.parse(at))) return null;
  return { id, speaker, at, text };
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
  const { id, speaker, at, text } = entry;
  transcript.push([{ id, speaker, at, text }]);
}
