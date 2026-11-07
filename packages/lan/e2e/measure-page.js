// Loaded by the board-size measurement into its browser before the page's own scripts. The
// measurement calls it to wait until the scene shows the helper's shapes, to set the board's view
// and draw frames at it, and to count the time the page spends in the transactions that apply the
// changes its peers send. It is plain JavaScript, outside the measurement's compiled code, so that
// the browser runs it as written.

/** Resolves at the browser's next frame. */
function nextFrame() {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

// The page sets window.chalklineReady as it starts; this resolves with the page's handle once it has.
let readyValue;
let resolveReady;
const ready = new Promise((resolve) => {
  resolveReady = resolve;
});
Object.defineProperty(window, 'chalklineReady', {
  configurable: true,
  get: () => readyValue,
  set: (value) => {
    readyValue = value;
    resolveReady(value);
  },
});

// The milliseconds the page spent in transactions that a peer's change started, and how many there were:
// each holds the change's update, the board's observers, and the binding's work on the scene.
let remoteMs = 0;
let remoteCount = 0;
ready.then((handle) => {
  let startedAt = null;
  handle.doc.on('beforeTransaction', (transaction) => {
    if (!transaction.local) startedAt = performance.now();
  });
  handle.doc.on('afterTransaction', (transaction) => {
    if (!transaction.local && startedAt !== null) {
      remoteMs += performance.now() - startedAt;
      remoteCount += 1;
    }
    startedAt = null;
  });
});

/** Waits a frame at a time until `done` answers true, and throws once `waitMs` passes first. */
async function frameUntil(done, waitMs, what) {
  const started = performance.now();
  while (!done()) {
    if (performance.now() - started > waitMs) throw new Error(`timed out after ${waitMs} ms waiting for ${what}`);
    await nextFrame();
  }
}

/** The number of shapes the scene shows, deleted ones left out. */
function shownCount(api) {
  return api.getSceneElements().length;
}

let resolveLoad;
const load = new Promise((resolve) => {
  resolveLoad = resolve;
});

window.chalklineMeasure = {
  /** Resolves once the page has started. */
  async ready() {
    await ready;
  },

  /**
   * Records, from this page's navigation, when the scene first shows `count` shapes and when the
   * browser draws the frame after it, which `loaded` answers. The measurement calls it from an init
   * script, before the page's own scripts run.
   */
  watchLoad(count) {
    void (async () => {
      const { api } = await ready;
      while (shownCount(api) < count) await nextFrame();
      const shownMs = performance.now();
      await nextFrame();
      resolveLoad({ shownMs, drawnMs: performance.now() });
    })();
  },

  /** Resolves with the times `watchLoad` recorded, in milliseconds from this page's navigation. */
  async loaded(waitMs) {
    let timer;
    const late = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`timed out after ${waitMs} ms waiting for the board to load`)), waitMs);
    });
    try {
      return await Promise.race([load, late]);
    } finally {
      clearTimeout(timer);
    }
  },

  /** Resolves once the scene shows `count` shapes. */
  async shown(count, waitMs) {
    const { api } = await ready;
    await frameUntil(() => shownCount(api) >= count, waitMs, `${count} shapes`);
  },

  /** Resolves once the page is connected to at least one peer. */
  async connected(waitMs) {
    const handle = await ready;
    await frameUntil(() => handle.peers().length > 0, waitMs, 'a peer');
  },

  /** Sets the board's zoom and scroll, and resolves once the browser has drawn three frames at them. */
  async view(zoom, scrollX, scrollY) {
    const { api } = await ready;
    api.updateScene({ appState: { zoom: { value: zoom }, scrollX, scrollY } });
    for (let frame = 0; frame < 3; frame += 1) await nextFrame();
  },

  /**
   * Moves the board's view one pixel to the right and back again, `count` times in all, and waits
   * two frames after each move, so that the browser draws the scene once for each.
   */
  async pans(count) {
    const { api } = await ready;
    const { scrollX } = api.getAppState();
    for (let index = 0; index < count; index += 1) {
      api.updateScene({ appState: { scrollX: scrollX + (index % 2 === 0 ? 1 : 0) } });
      await nextFrame();
      await nextFrame();
    }
  },

  /** Resolves once the scene shows the shape `id` with its x at `x`, and the browser has drawn two frames after. */
  async shownAt(id, x, waitMs) {
    const { api } = await ready;
    const at = () => api.getSceneElementsIncludingDeleted().find((element) => element.id === id)?.x;
    await frameUntil(
      () => {
        const current = at();
        return current !== undefined && Math.abs(current - x) < 0.01;
      },
      waitMs,
      `the shape ${id} at x ${x}`,
    );
    await nextFrame();
    await nextFrame();
  },

  /** The milliseconds the page has spent so far in transactions a peer's change started, and how many. */
  remote() {
    return { ms: remoteMs, count: remoteCount };
  },
};
