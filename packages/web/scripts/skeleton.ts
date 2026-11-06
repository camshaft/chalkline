import type {
  ExcalidrawElement,
  ExcalidrawTextElement,
  OrderedExcalidrawElement,
} from '@excalidraw/excalidraw/element/types';

/**
 * Node has no canvas to measure text on, so each character is measured as 0.6
 * of the font's size, about the average width of Excalidraw's hand-drawn font.
 */
const CHARACTER_WIDTH = 0.6;

export interface LabelledBox {
  /** Every element of the box, in the order to add them: the rectangle, then its label. */
  elements: readonly ExcalidrawElement[];
  box: ExcalidrawElement;
  text: ExcalidrawTextElement;
}

/**
 * Converts one labelled rectangle from Excalidraw's skeleton format with
 * `convertToExcalidrawElements`, in Node: Excalidraw expects a DOM, so jsdom
 * supplies one first.
 */
export async function labelledBox(label: string, at = { x: 120, y: 420 }): Promise<LabelledBox> {
  await installDom();
  const { convertToExcalidrawElements, setCustomTextMetricsProvider } = await import('@excalidraw/excalidraw');
  setCustomTextMetricsProvider({
    getLineWidth: (text: string, font: string) => text.length * fontSize(font) * CHARACTER_WIDTH,
  });

  const elements = convertToExcalidrawElements([
    { type: 'rectangle', x: at.x, y: at.y, width: 280, height: 100, label: { text: label } },
  ]);
  const box = elements.find((element) => element.type === 'rectangle');
  const text = elements.find(
    (element): element is OrderedExcalidrawElement & ExcalidrawTextElement => element.type === 'text',
  );
  if (box === undefined || text === undefined || text.containerId !== box.id || text.originalText !== label) {
    throw new Error(`convertToExcalidrawElements didn't make a rectangle labelled "${label}": ${JSON.stringify(elements)}`);
  }
  return { elements, box, text };
}

async function installDom(): Promise<void> {
  if (typeof globalThis.document !== 'undefined') return;
  const { default: globalJsdom } = await import('global-jsdom');
  globalJsdom(undefined, { pretendToBeVisual: true, url: 'https://chalkline.invalid/' });
  // jsdom's canvas has no 2D context, and Excalidraw checks which context features exist as it
  // loads. draw-box doesn't draw anything, so a context whose methods do nothing is enough.
  HTMLCanvasElement.prototype.getContext = function getContext(this: HTMLCanvasElement) {
    return inertContext(this);
  } as unknown as HTMLCanvasElement['getContext'];
  // jsdom has no font loading API either. Excalidraw registers its fonts as it measures text, and
  // draw-box measures text with the metrics provider above, so fonts that load nothing are enough.
  globalThis.FontFace = InertFontFace as unknown as typeof FontFace;
  Object.defineProperty(document, 'fonts', { value: new InertFontFaceSet(), configurable: true });
  // Libraries written for browsers, such as Trystero, call addEventListener on the global scope once
  // they see a window. global-jsdom puts the window there but not its event methods, so they go there too.
  Object.assign(globalThis, {
    addEventListener: window.addEventListener.bind(window),
    removeEventListener: window.removeEventListener.bind(window),
    dispatchEvent: window.dispatchEvent.bind(window),
  });
}

/** A 2D context that holds the properties set on it and whose methods do nothing. */
function inertContext(canvas: HTMLCanvasElement): unknown {
  const state: Record<PropertyKey, unknown> = { canvas, filter: 'none', font: '10px sans-serif' };
  const nothing = () => undefined;
  return new Proxy(state, {
    has: () => true,
    get: (target, property) => {
      if (property in target) return target[property];
      if (typeof property === 'symbol' || property === 'then') return undefined;
      if (property === 'measureText') return (text: string) => ({ width: text.length * 6 });
      return nothing;
    },
    set: (target, property, value) => {
      target[property] = value;
      return true;
    },
  });
}

/** A FontFace that keeps its descriptors and counts as loaded without fetching anything. */
class InertFontFace {
  readonly status = 'loaded';
  readonly loaded: Promise<InertFontFace>;
  readonly display: string;
  readonly style: string;
  readonly weight: string;
  readonly unicodeRange: string;

  constructor(
    readonly family: string,
    readonly source: unknown,
    descriptors: Record<string, string | undefined> = {},
  ) {
    this.display = descriptors.display ?? 'auto';
    this.style = descriptors.style ?? 'normal';
    this.weight = descriptors.weight ?? 'normal';
    this.unicodeRange = descriptors.unicodeRange ?? 'U+0-10FFFF';
    this.loaded = Promise.resolve(this);
  }

  load(): Promise<InertFontFace> {
    return this.loaded;
  }
}

/** A FontFaceSet whose fonts all count as loaded. */
class InertFontFaceSet extends Set<InertFontFace> {
  readonly status = 'loaded';
  readonly ready: Promise<InertFontFaceSet> = Promise.resolve(this);

  check(): boolean {
    return true;
  }

  load(): Promise<InertFontFace[]> {
    return Promise.resolve([...this]);
  }

  addEventListener(): void {
    // The set's fonts never change state, so no listener is ever called.
  }

  removeEventListener(): void {
    // Nothing to remove: addEventListener doesn't keep a listener.
  }
}

function fontSize(font: string): number {
  const match = /(\d+(?:\.\d+)?)px/.exec(font);
  return match === null ? 20 : Number(match[1]);
}
