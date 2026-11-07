import { describe, expect, it } from 'vitest';
import {
  DRAWING_SPACE_KEY,
  keepDrawingSpace,
  keepDrawingSpaceChanges,
  keptDrawingSpace,
  type DrawingSpace,
  type DrawingSpaceStorage,
} from './drawing-space';

class MemoryStorage implements DrawingSpaceStorage {
  readonly items = new Map<string, string>();
  writes = 0;

  getItem(key: string): string | null {
    return this.items.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.writes += 1;
    this.items.set(key, value);
  }
}

const refusing: DrawingSpaceStorage = {
  getItem: () => {
    throw new Error('The operation is insecure.');
  },
  setItem: () => {
    throw new Error('The quota has been exceeded.');
  },
};

describe('keptDrawingSpace', () => {
  it('reads the background color and the grid a browser keeps', () => {
    const storage = new MemoryStorage();
    storage.setItem(DRAWING_SPACE_KEY, JSON.stringify({ viewBackgroundColor: '#fff9db', gridModeEnabled: true }));

    expect(keptDrawingSpace(storage)).toEqual({ viewBackgroundColor: '#fff9db', gridModeEnabled: true });
  });

  it('leaves out each value of the wrong type, and a blank color', () => {
    const storage = new MemoryStorage();
    storage.setItem(DRAWING_SPACE_KEY, JSON.stringify({ viewBackgroundColor: '', gridModeEnabled: 'yes' }));
    expect(keptDrawingSpace(storage)).toEqual({});

    storage.setItem(DRAWING_SPACE_KEY, JSON.stringify({ viewBackgroundColor: 12, gridModeEnabled: false }));
    expect(keptDrawingSpace(storage)).toEqual({ gridModeEnabled: false });
  });

  it("reads nothing where the browser doesn't keep a drawing space, keeps one that isn't JSON or an object, or refuses the read", () => {
    const storage = new MemoryStorage();
    expect(keptDrawingSpace(storage)).toEqual({});
    expect(keptDrawingSpace(undefined)).toEqual({});
    expect(keptDrawingSpace(refusing)).toEqual({});

    storage.setItem(DRAWING_SPACE_KEY, '{not json');
    expect(keptDrawingSpace(storage)).toEqual({});
    storage.setItem(DRAWING_SPACE_KEY, 'null');
    expect(keptDrawingSpace(storage)).toEqual({});
    storage.setItem(DRAWING_SPACE_KEY, '"#fff9db"');
    expect(keptDrawingSpace(storage)).toEqual({});
  });
});

describe('keepDrawingSpace', () => {
  it('keeps the drawing space, which keptDrawingSpace reads back', () => {
    const storage = new MemoryStorage();

    keepDrawingSpace(storage, { viewBackgroundColor: '#1e1e1e', gridModeEnabled: false });

    expect(keptDrawingSpace(storage)).toEqual({ viewBackgroundColor: '#1e1e1e', gridModeEnabled: false });
  });

  it("doesn't throw where the browser refuses the write, or doesn't offer storage", () => {
    expect(() => keepDrawingSpace(refusing, { viewBackgroundColor: '#ffffff', gridModeEnabled: true })).not.toThrow();
    expect(() => keepDrawingSpace(undefined, { viewBackgroundColor: '#ffffff', gridModeEnabled: true })).not.toThrow();
  });
});

describe('keepDrawingSpaceChanges', () => {
  function scene(space: DrawingSpace) {
    let now = space;
    const listeners = new Set<() => void>();
    return {
      source: {
        current: () => now,
        onChange: (listener: () => void) => {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        },
      },
      change(next: Partial<DrawingSpace>) {
        now = { ...now, ...next };
        for (const listener of listeners) listener();
      },
    };
  }

  it('writes each change of the background color or the grid, and no other change', () => {
    const storage = new MemoryStorage();
    const { source, change } = scene({ viewBackgroundColor: '#ffffff', gridModeEnabled: false });
    keepDrawingSpaceChanges(storage, source);

    // A shape drawn or moved changes the scene and leaves the drawing space as it was.
    change({});
    change({});
    expect(storage.writes).toBe(0);

    change({ gridModeEnabled: true });
    expect(storage.writes).toBe(1);
    expect(keptDrawingSpace(storage)).toEqual({ viewBackgroundColor: '#ffffff', gridModeEnabled: true });

    change({ viewBackgroundColor: '#fff9db' });
    change({});
    expect(storage.writes).toBe(2);
    expect(keptDrawingSpace(storage)).toEqual({ viewBackgroundColor: '#fff9db', gridModeEnabled: true });
  });

  it('stops writing once stopped', () => {
    const storage = new MemoryStorage();
    const { source, change } = scene({ viewBackgroundColor: '#ffffff', gridModeEnabled: false });
    const stop = keepDrawingSpaceChanges(storage, source);

    stop();
    change({ gridModeEnabled: true });

    expect(storage.writes).toBe(0);
  });
});
