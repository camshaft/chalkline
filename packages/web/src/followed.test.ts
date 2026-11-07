import { describe, expect, it, vi } from 'vitest';
import { Followed } from './followed';

describe('Followed', () => {
  it('holds its value, and tells each listener of each change', () => {
    const files = new Followed<string | null>(null);
    const listener = vi.fn<() => void>();
    files.subscribe(listener);
    expect(files.get()).toBeNull();

    files.set('commands');

    expect(files.get()).toBe('commands');
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('stops telling a listener once it unsubscribes, and keeps telling the others', () => {
    const files = new Followed(0);
    const gone = vi.fn<() => void>();
    const kept = vi.fn<() => void>();
    const unsubscribe = files.subscribe(gone);
    files.subscribe(kept);

    unsubscribe();
    files.set(1);

    expect(gone).not.toHaveBeenCalled();
    expect(kept).toHaveBeenCalledTimes(1);
  });

  it('keeps its methods bound, as React calls them on their own', () => {
    const files = new Followed('saved');
    const { get, set, subscribe } = files;
    const listener = vi.fn<() => void>();
    subscribe(listener);

    set('opened');

    expect(get()).toBe('opened');
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
