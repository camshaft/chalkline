import type { ExcalidrawElement, ExcalidrawTextElement } from '@excalidraw/excalidraw/element/types';

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
  const text = elements.find((element): element is ExcalidrawTextElement => element.type === 'text');
  if (box === undefined || text === undefined || text.containerId !== box.id || text.originalText !== label) {
    throw new Error(`convertToExcalidrawElements didn't make a rectangle labelled "${label}": ${JSON.stringify(elements)}`);
  }
  return { elements, box, text };
}

async function installDom(): Promise<void> {
  if (typeof globalThis.document !== 'undefined') return;
  const { default: globalJsdom } = await import('global-jsdom');
  globalJsdom(undefined, { pretendToBeVisual: true, url: 'https://chalkline.invalid/' });
}

function fontSize(font: string): number {
  const match = /(\d+(?:\.\d+)?)px/.exec(font);
  return match === null ? 20 : Number(match[1]);
}
