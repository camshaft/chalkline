/**
 * A value that a part of the page follows, such as the main menu, which shows its file items once the
 * board's file commands are set. Its methods stay bound, so that React's `useSyncExternalStore` can call
 * `subscribe` and `get` on their own.
 */
export class Followed<T> {
  private value: T;
  private readonly listeners = new Set<() => void>();

  constructor(value: T) {
    this.value = value;
  }

  /** The value now. */
  readonly get = (): T => this.value;

  /** Changes the value, and tells each listener. */
  readonly set = (value: T): void => {
    this.value = value;
    for (const listener of [...this.listeners]) listener();
  };

  /** Calls `listener` on each change; returns the call that stops it. */
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
}
