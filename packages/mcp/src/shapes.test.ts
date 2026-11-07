import { describe, expect, it } from 'vitest';
import { DEFAULT_FONT, DEFAULT_STYLE, FONT_FAMILY } from './shapes';
import { convertSkeletons, loadExcalidraw } from './skeleton';

describe("Excalidraw's values", () => {
  it("names each of Excalidraw's fonts, with the number its FONT_FAMILY holds", async () => {
    expect(FONT_FAMILY).toEqual((await loadExcalidraw()).FONT_FAMILY);
  });

  it('holds the style, the font and the alignment that Excalidraw sets where a shape leaves them out', async () => {
    const [rectangle] = await convertSkeletons([{ type: 'rectangle', x: 0, y: 0, width: 100, height: 50 }]);
    expect(rectangle).toMatchObject(DEFAULT_STYLE);

    const [text] = await convertSkeletons([{ type: 'text', x: 0, y: 0, text: 'Note' }]);
    expect(text).toMatchObject({ ...DEFAULT_STYLE, fontFamily: FONT_FAMILY[DEFAULT_FONT], textAlign: 'left' });

    const labelled = await convertSkeletons([{ type: 'ellipse', x: 0, y: 0, width: 100, height: 50, label: { text: 'Oval' } }]);
    expect(labelled.find((element) => element.type === 'text')).toMatchObject({ fontFamily: FONT_FAMILY[DEFAULT_FONT], textAlign: 'center' });
  });
});
