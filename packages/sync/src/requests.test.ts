import { describe, expect, it } from 'vitest';
import { CONVERTS, convertsMermaid, mermaidConverters, readRequest } from './requests';

describe('readRequest', () => {
  it('reads a pending request, and one done with the ids of its shapes', () => {
    const pending = { kind: 'mermaid', text: 'flowchart LR\n  A --> B', by: 'agent', status: 'pending', error: null, at: { x: 10, y: -20 } };
    const done = { ...pending, status: 'done', ids: ['r-0', 'r-2'] };

    expect(readRequest(pending)).toEqual(pending);
    expect(readRequest(done)).toEqual(done);
  });

  it('reads a failed request with its reason', () => {
    const failed = { kind: 'mermaid', text: 'not mermaid', by: 'agent', status: 'failed', error: 'No diagram type detected' };

    expect(readRequest(failed)).toEqual(failed);
  });

  it("reads a value that isn't a Mermaid request with a known status as null", () => {
    const request = { kind: 'mermaid', text: 'flowchart LR', by: 'agent', status: 'pending', error: null };
    for (const value of [
      null,
      'flowchart LR',
      [request],
      { ...request, kind: 'image' },
      { ...request, text: 7 },
      { ...request, by: undefined },
      { ...request, status: 'converting' },
    ]) {
      expect(readRequest(value)).toBeNull();
    }
  });

  it('leaves out an `at` or `ids` of the wrong type, and reads an `error` that is not text as null', () => {
    const value = { kind: 'mermaid', text: 'flowchart LR', by: 'agent', status: 'done', error: 5, at: { x: '1', y: 2 }, ids: ['a', 3] };

    expect(readRequest(value)).toEqual({ kind: 'mermaid', text: 'flowchart LR', by: 'agent', status: 'done', error: null });
    expect(readRequest({ ...value, at: { x: Number.NaN, y: 0 } })).not.toHaveProperty('at');
  });
});

describe('convertsMermaid and mermaidConverters', () => {
  it('finds the participants whose awareness state lists mermaid, lowest client id first', () => {
    const states = new Map<number, unknown>([
      [9, { name: 'Ada', [CONVERTS]: ['mermaid'] }],
      [2, { name: 'helper' }],
      [4, { [CONVERTS]: ['mermaid'] }],
      [3, { [CONVERTS]: 'mermaid' }],
      [5, null],
    ]);

    expect(mermaidConverters(states)).toEqual([4, 9]);
    expect(convertsMermaid({ [CONVERTS]: ['image', 'mermaid'] })).toBe(true);
    expect(convertsMermaid({ [CONVERTS]: [] })).toBe(false);
    expect(convertsMermaid(undefined)).toBe(false);
  });
});
