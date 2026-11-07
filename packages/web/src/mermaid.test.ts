import {
  Awareness,
  connectAwareness,
  connectDoc,
  CONVERTS,
  MemoryNetwork,
  readRequest,
  REQUESTS,
  type MermaidRequest,
  type Point,
} from '@chalkline/sync';
import { afterEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  bindRequests,
  CONVERTED,
  GAP,
  mermaidConverter,
  placeBelow,
  renameElements,
  type Convert,
  type Element,
} from './mermaid';

const made: Awareness[] = [];

afterEach(() => {
  for (const awareness of made.splice(0)) awareness.destroy();
});

/** A page's copy of the board, whose awareness client id is `clientID`. */
function page(clientID: number) {
  const doc = new Y.Doc();
  doc.clientID = clientID;
  const awareness = new Awareness(doc);
  made.push(awareness);
  return { doc, awareness, requests: doc.getMap<unknown>(REQUESTS), elements: doc.getMap<Element>('elements') };
}

/** Pages that see each other's document on one in-memory network, and their awareness states where `aware`. */
function room(pages: { doc: Y.Doc; awareness: Awareness }[], aware: boolean): MemoryNetwork {
  const network = new MemoryNetwork();
  pages.forEach((joining, place) => {
    const peer = network.join(`page-${place}`);
    connectDoc(joining.doc, peer);
    if (aware) connectAwareness(joining.awareness, peer);
  });
  network.flush();
  return network;
}

function request(text: string, at?: Point): MermaidRequest {
  const pending: MermaidRequest = { kind: 'mermaid', text, by: 'agent', status: 'pending', error: null };
  if (at !== undefined) pending.at = at;
  return pending;
}

/** Resolves with the request `id` once it is done or failed, on the change event of the requests map. */
function settled(doc: Y.Doc, id: string): Promise<MermaidRequest> {
  const requests = doc.getMap<unknown>(REQUESTS);
  return new Promise((resolve) => {
    const check = () => {
      const current = readRequest(requests.get(id));
      if (current === null || current.status === 'pending') return;
      requests.unobserve(check);
      resolve(current);
    };
    requests.observe(check);
    check();
  });
}

/** A labelled box, as Excalidraw's converter makes it: the box, and its label bound to it. */
function box(id: string, x: number, y: number): Element[] {
  return [
    {
      id,
      type: 'rectangle',
      x,
      y,
      width: 100,
      height: 40,
      version: 1,
      versionNonce: 1,
      groupIds: [],
      boundElements: [{ id: `${id}-label`, type: 'text' }],
    },
    { id: `${id}-label`, type: 'text', x: x + 10, y: y + 10, width: 80, height: 20, version: 1, versionNonce: 1, containerId: id },
  ];
}

/** Two labelled boxes and an arrow from the first to the second, as a flowchart `A --> B` converts. */
const flowchart: Convert = async () => [
  ...box('A', 50, 70),
  ...box('B', 250, 70),
  {
    id: 'arrow',
    type: 'arrow',
    x: 150,
    y: 90,
    width: 100,
    height: 0,
    version: 1,
    versionNonce: 1,
    startBinding: { elementId: 'A' },
    endBinding: { elementId: 'B' },
  },
];

/** `convert`, with the text of each call it was called with. */
function counting(convert: Convert): { convert: Convert; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    convert: (text) => {
      calls.push(text);
      return convert(text);
    },
  };
}

describe('mermaidConverter', () => {
  it('makes elements of the skeletons that the parser reads', async () => {
    const convert = mermaidConverter(
      async (text) => ({ elements: [{ type: 'rectangle', id: text }] }),
      (skeletons) => skeletons.map((skeleton) => ({ ...(skeleton as object), x: 0, y: 0, width: 10, height: 10 })),
    );

    await expect(convert('box')).resolves.toEqual([{ type: 'rectangle', id: 'box', x: 0, y: 0, width: 10, height: 10 }]);
  });

  it('refuses a diagram that the parser draws only as an image', async () => {
    const convert = mermaidConverter(
      async () => ({ elements: [{ type: 'image', fileId: 'f' }], files: { f: { mimeType: 'image/svg+xml' } } }),
      (skeletons) => skeletons.map(() => ({ id: 'image', type: 'image', x: 0, y: 0, width: 10, height: 10 })),
    );

    await expect(convert('pie\n  "a": 1')).rejects.toThrow('draws this kind of diagram only as an image');
  });

  it("refuses a diagram without a shape, and rejects with the parser's reason", async () => {
    const empty = mermaidConverter(
      async () => ({ elements: [] }),
      () => [],
    );
    const failing = mermaidConverter(
      async () => {
        throw new Error('No diagram type detected');
      },
      () => [],
    );

    await expect(empty('flowchart LR')).rejects.toThrow("The diagram doesn't hold any shape to add.");
    await expect(failing('not mermaid')).rejects.toThrow('No diagram type detected');
  });
});

describe('renameElements', () => {
  it("names each element after the request, and renames each reference to one of them", async () => {
    const elements = (await flowchart('')).map((element) => ({ ...element, groupIds: ['g1', 'g2'] }));
    const renamed = renameElements('r', elements);

    expect(renamed.map((element) => element.id)).toEqual(['r-0', 'r-1', 'r-2', 'r-3', 'r-4']);
    expect(renamed[0]).toMatchObject({ boundElements: [{ id: 'r-1', type: 'text' }], groupIds: ['r-group-0', 'r-group-1'] });
    expect(renamed[1]).toMatchObject({ containerId: 'r-0' });
    expect(renamed[3]).toMatchObject({ containerId: 'r-2' });
    expect(renamed[4]).toMatchObject({ startBinding: { elementId: 'r-0' }, endBinding: { elementId: 'r-2' } });
    // The elements it was given stay as they were.
    expect(elements[0].id).toBe('A');
  });

  it('leaves a reference to an element outside the diagram as it is', () => {
    const [label] = renameElements('r', [{ id: 'label', type: 'text', x: 0, y: 0, width: 1, height: 1, containerId: 'elsewhere' }]);

    expect(label).toMatchObject({ id: 'r-0', containerId: 'elsewhere' });
  });
});

describe('placeBelow', () => {
  it("answers the left edge of the board's shapes, GAP below the lowest, and 0, 0 on an empty board", () => {
    expect(placeBelow([])).toEqual({ x: 0, y: 0 });
    expect(
      placeBelow([
        { x: 10, y: 0, height: 50 },
        { x: -20, y: 30, height: 40 },
        { x: -500, y: 900, height: 10, isDeleted: true },
        'not an element',
      ]),
    ).toEqual({ x: -20, y: 70 + GAP });
  });
});

describe('bindRequests', () => {
  it("converts a pending request into shapes at its place, above the board's elements, and marks it done", async () => {
    const { doc, awareness, requests, elements } = page(1);
    elements.set('old', { id: 'old', type: 'rectangle', x: 0, y: 0, width: 10, height: 10, index: 'a5' });
    const origins: unknown[] = [];
    doc.on('afterTransaction', (transaction) => origins.push(transaction.origin));
    bindRequests(doc, awareness, flowchart);

    requests.set('r', request('flowchart LR\n  A --> B', { x: 400, y: 300 }));
    const done = await settled(doc, 'r');

    expect(done).toMatchObject({ status: 'done', error: null, by: 'agent', ids: ['r-0', 'r-2', 'r-4'] });
    expect(elements.get('r-0')).toMatchObject({ type: 'rectangle', x: 400, y: 300, boundElements: [{ id: 'r-1', type: 'text' }] });
    expect(elements.get('r-1')).toMatchObject({ type: 'text', containerId: 'r-0', x: 410, y: 310 });
    expect(elements.get('r-2')).toMatchObject({ x: 600, y: 300 });
    expect(elements.get('r-4')).toMatchObject({ x: 500, y: 320, startBinding: { elementId: 'r-0' }, endBinding: { elementId: 'r-2' } });
    const indices = ['r-0', 'r-1', 'r-2', 'r-3', 'r-4'].map((id) => String(elements.get(id)?.index));
    expect(indices.every((index) => index > 'a5')).toBe(true);
    expect([...indices].sort()).toEqual(indices);
    for (const id of ['r-0', 'r-1', 'r-2', 'r-3', 'r-4']) {
      expect(elements.get(id)).toMatchObject({ customData: { chalkline: { creator: { kind: 'agent', name: 'agent' } } } });
    }
    expect(origins).toContain(CONVERTED);
  });

  it("puts a diagram without a place below the board's shapes", async () => {
    const { doc, awareness, requests, elements } = page(1);
    elements.set('old', { id: 'old', type: 'rectangle', x: -20, y: 10, width: 10, height: 30 });
    bindRequests(doc, awareness, flowchart);

    requests.set('r', request('flowchart LR\n  A --> B'));
    await settled(doc, 'r');

    expect(elements.get('r-0')).toMatchObject({ x: -20, y: 40 + GAP });
  });

  it("marks a request failed with the converter's reason, and adds nothing", async () => {
    const { doc, awareness, requests, elements } = page(1);
    bindRequests(doc, awareness, async () => {
      throw new Error('No diagram type detected');
    });

    requests.set('r', request('not mermaid'));
    const failed = await settled(doc, 'r');

    expect(failed).toMatchObject({ status: 'failed', error: 'No diagram type detected', text: 'not mermaid' });
    expect(elements.size).toBe(0);
  });

  it('converts the requests pending as it binds, and leaves the ones done or failed as they are', async () => {
    const { doc, awareness, requests } = page(1);
    requests.set('pending', request('flowchart LR\n  A --> B'));
    requests.set('done', { ...request('flowchart LR'), status: 'done', ids: [] });
    requests.set('failed', { ...request('pie'), status: 'failed', error: 'image' });
    const { convert, calls } = counting(flowchart);

    bindRequests(doc, awareness, convert);
    await settled(doc, 'pending');

    expect(calls).toEqual(['flowchart LR\n  A --> B']);
    expect(readRequest(requests.get('done'))?.status).toBe('done');
    expect(readRequest(requests.get('failed'))).toMatchObject({ status: 'failed', error: 'image' });
  });

  it('lists mermaid in the awareness state, and only the converter with the lowest client id converts', async () => {
    const low = page(1);
    const high = page(2);
    const network = room([low, high], true);
    const lowConverter = counting(flowchart);
    const highConverter = counting(flowchart);
    bindRequests(high.doc, high.awareness, highConverter.convert);
    bindRequests(low.doc, low.awareness, lowConverter.convert);
    network.flush();
    expect(high.awareness.getStates().get(1)).toMatchObject({ [CONVERTS]: ['mermaid'] });

    high.requests.set('r', request('flowchart LR\n  A --> B'));
    network.flush();
    await settled(low.doc, 'r');
    network.flush();

    expect(lowConverter.calls).toHaveLength(1);
    expect(highConverter.calls).toEqual([]);
    expect(readRequest(high.requests.get('r'))?.status).toBe('done');
    expect(high.elements.size).toBe(5);
  });

  it('converts on the next page once the converter stops before it carries out a request', async () => {
    const low = page(1);
    const high = page(2);
    const network = room([low, high], true);
    // The first page's conversion never ends, so the request stays pending until the next page takes it.
    const stopLow = bindRequests(low.doc, low.awareness, () => new Promise<Element[]>(() => {}));
    const highConverter = counting(flowchart);
    bindRequests(high.doc, high.awareness, highConverter.convert);
    network.flush();

    high.requests.set('r', request('flowchart LR\n  A --> B'));
    network.flush();
    expect(highConverter.calls).toEqual([]);

    stopLow();
    network.flush();
    const done = await settled(high.doc, 'r');

    expect(low.awareness.getLocalState()).not.toHaveProperty(CONVERTS);
    expect(done.status).toBe('done');
    expect(highConverter.calls).toHaveLength(1);
  });

  it("makes one copy of the diagram where two pages that don't see each other's awareness both convert it", async () => {
    const first = page(1);
    const second = page(2);
    const network = room([first, second], false);
    bindRequests(first.doc, first.awareness, flowchart);
    bindRequests(second.doc, second.awareness, flowchart);

    first.requests.set('r', request('flowchart LR\n  A --> B'));
    network.flush();
    await Promise.all([settled(first.doc, 'r'), settled(second.doc, 'r')]);
    network.flush();

    expect([...first.elements.keys()].sort()).toEqual(['r-0', 'r-1', 'r-2', 'r-3', 'r-4']);
    expect([...second.elements.keys()].sort()).toEqual(['r-0', 'r-1', 'r-2', 'r-3', 'r-4']);
  });

  it('stops converting, and takes mermaid off the awareness state, once stopped', async () => {
    const { doc, awareness, requests, elements } = page(1);
    const { convert, calls } = counting(flowchart);
    const stop = bindRequests(doc, awareness, convert);
    expect(awareness.getLocalState()).toMatchObject({ [CONVERTS]: ['mermaid'] });

    stop();
    requests.set('r', request('flowchart LR\n  A --> B'));
    // The request's change event doesn't start a conversion, so this wait only checks that none happens.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(awareness.getLocalState()).not.toHaveProperty(CONVERTS);
    expect(calls).toEqual([]);
    expect(readRequest(requests.get('r'))?.status).toBe('pending');
    expect(elements.size).toBe(0);
  });
});
