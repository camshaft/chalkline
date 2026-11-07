import { generateKeyBetween, generateNKeysBetween } from 'fractional-indexing';

/**
 * `count` fractional indices, in order, above the index of every element of
 * `values`, the board's elements, as the page orders them from back to front.
 * A value that isn't an element, and an index that isn't a valid fractional
 * index, are passed over.
 */
export function indicesAbove(values: Iterable<unknown>, count: number): string[] {
  let top: string | null = null;
  for (const value of values) {
    const index = typeof value === 'object' && value !== null ? (value as { index?: unknown }).index : undefined;
    if (typeof index === 'string' && (top === null || index > top) && validIndex(index)) top = index;
  }
  return generateNKeysBetween(top, null, count);
}

function validIndex(index: string): boolean {
  try {
    generateKeyBetween(index, null);
    return true;
  } catch {
    return false;
  }
}
