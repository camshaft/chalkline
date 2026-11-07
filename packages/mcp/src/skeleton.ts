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

/** Node's EventTarget, read before jsdom is installed. */
const NodeEventTarget = globalThis.EventTarget;

/** Excalidraw's module, which loads in Node only once jsdom supplies a DOM. */
export type Excalidraw = typeof import('@excalidraw/excalidraw');

/** One element in Excalidraw's skeleton format, as `convertToExcalidrawElements` reads it. */
export type Skeleton = NonNullable<Parameters<Excalidraw['convertToExcalidrawElements']>[0]>[number];

/** One element that `convertToExcalidrawElements` makes. */
export type ConvertedElement = ReturnType<Excalidraw['convertToExcalidrawElements']>[number];

let loading: Promise<Excalidraw> | undefined;

/**
 * Loads Excalidraw in Node, once. Excalidraw expects a DOM, so jsdom supplies one first, and
 * Node has no canvas to measure text on, so each character measures CHARACTER_WIDTH of its font.
 */
export function loadExcalidraw(): Promise<Excalidraw> {
  loading ??= (async () => {
    await installDom();
    const excalidraw = await import('@excalidraw/excalidraw');
    excalidraw.setCustomTextMetricsProvider({
      getLineWidth: (text: string, font: string) => text.length * fontSize(font) * CHARACTER_WIDTH,
    });
    return excalidraw;
  })();
  return loading;
}

/**
 * Converts elements from Excalidraw's skeleton format with `convertToExcalidrawElements`, in Node.
 * With `regenerateIds` false, each element keeps the id its skeleton sets, which an arrow's
 * `start` and `end` name.
 */
export async function convertSkeletons(
  skeletons: readonly Skeleton[],
  { regenerateIds = true }: { regenerateIds?: boolean } = {},
): Promise<ConvertedElement[]> {
  const { convertToExcalidrawElements } = await loadExcalidraw();
  return convertToExcalidrawElements([...skeletons], { regenerateIds });
}

export interface LabelledBox {
  /** Every element of the box, in the order to add them: the rectangle, then its label. */
  elements: readonly ExcalidrawElement[];
  box: ExcalidrawElement;
  text: ExcalidrawTextElement;
}

/** Converts one labelled rectangle from Excalidraw's skeleton format, as draw-box adds it. */
export async function labelledBox(label: string, at = { x: 120, y: 420 }): Promise<LabelledBox> {
  const elements = await convertSkeletons([
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
  // loads. Neither draw-box nor chalkline-mcp draws anything, so a context whose methods do nothing
  // is enough.
  HTMLCanvasElement.prototype.getContext = function getContext(this: HTMLCanvasElement) {
    return inertContext(this);
  } as unknown as HTMLCanvasElement['getContext'];
  // jsdom has no font loading API either. Excalidraw registers its fonts as it measures text, and
  // loadExcalidraw measures text with a metrics provider of its own, so fonts that load nothing are
  // enough.
  globalThis.FontFace = InertFontFace as unknown as typeof FontFace;
  Object.defineProperty(document, 'fonts', { value: new InertFontFaceSet(), configurable: true });
  // Libraries written for browsers, such as Trystero, call addEventListener on the global scope once
  // they see a window, which global-jsdom puts there without its event methods. Those methods come
  // from Node's EventTarget, since jsdom's refuses the Node AbortSignal that Trystero passes as the
  // `signal` option. Nothing in Node sends the window events they listen for, such as "online".
  const globalEvents = new NodeEventTarget();
  Object.assign(globalThis, {
    addEventListener: globalEvents.addEventListener.bind(globalEvents),
    removeEventListener: globalEvents.removeEventListener.bind(globalEvents),
    dispatchEvent: globalEvents.dispatchEvent.bind(globalEvents),
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
