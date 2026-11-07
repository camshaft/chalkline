import { generateKeyBetween, generateNKeysBetween } from 'fractional-indexing';

/**
 * `count` fractional indices, in order, above the index of every element of
 * `values`, the board's elements, as the page orders them from back to front.
 * A value that isn't an element, and an index that isn't a valid fractional
 * index, are passed over.
 */
export function indicesAbove(values: Iterable<unknown>, count: number): string[] {
  return indicesUnder(values, null, count);
}

/**
 * `count` fractional indices, in order, just below `ceiling`: above the index
 * of each element of `values` that is below `ceiling`, and below `ceiling`
 * itself. A null `ceiling` is the front of the board, so the indices go above
 * every element. Values and indices are passed over as in indicesAbove.
 */
export function indicesUnder(values: Iterable<unknown>, ceiling: string | null, count: number): string[] {
  let floor: string | null = null;
  for (const index of indicesOf(values)) {
    if ((ceiling === null || index < ceiling) && (floor === null || index > floor)) floor = index;
  }
  return generateNKeysBetween(floor, ceiling, count);
}

/**
 * `count` fractional indices, in order, just above `floor`: below the index of
 * each element of `values` that is above `floor`, and above `floor` itself. A
 * null `floor` is the back of the board, so the indices go below every element.
 * Values and indices are passed over as in indicesAbove.
 */
export function indicesOver(values: Iterable<unknown>, floor: string | null, count: number): string[] {
  let ceiling: string | null = null;
  for (const index of indicesOf(values)) {
    if ((floor === null || index > floor) && (ceiling === null || index < ceiling)) ceiling = index;
  }
  return generateNKeysBetween(floor, ceiling, count);
}

/** The fractional index of `value`, an element of the board, where it holds a valid one; else null. */
export function fractionalIndex(value: unknown): string | null {
  const index = typeof value === 'object' && value !== null ? (value as { index?: unknown }).index : undefined;
  return typeof index === 'string' && validIndex(index) ? index : null;
}

/** The valid fractional index of each element of `values` that holds one. */
function* indicesOf(values: Iterable<unknown>): Generator<string> {
  for (const value of values) {
    const index = fractionalIndex(value);
    if (index !== null) yield index;
  }
}

function validIndex(index: string): boolean {
  try {
    generateKeyBetween(index, null);
    return true;
  } catch {
    return false;
  }
}
