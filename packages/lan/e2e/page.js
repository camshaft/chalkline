// Loaded by the end-to-end test into each of its browsers before the page's own scripts. The test
// calls it to wait, on the page's change events, until the page shows the shapes that chalkline-mcp
// added and its answer to a feedback. It is plain JavaScript, outside the test's compiled code, so
// that the browser runs it as written.
window.chalklineE2e = {
  /**
   * Resolves with each of `expected` as the page shows it: its type, its label, the creator its
   * custom data records, and the shapes an arrow binds to. It resolves once the scene shows each
   * one with the type, the label and the bindings `expected` holds and with `creator` as its
   * creator, and rejects with what the scene shows where `waitMs` passes first.
   */
  async shown(expected, creator, waitMs) {
    const handle = await window.chalklineReady;
    const { api, doc } = handle;
    const read = () => {
      const elements = api.getSceneElements();
      return expected.map((wanted) => {
        const element = elements.find((candidate) => candidate.id === wanted.id);
        const label = elements.find((candidate) => candidate.type === 'text' && candidate.containerId === wanted.id);
        const mark = element?.customData?.chalkline?.creator;
        return {
          id: wanted.id,
          type: element?.type ?? null,
          label: label?.originalText ?? null,
          creator: mark === undefined ? null : { kind: mark.kind, name: mark.name },
          start: element?.startBinding?.elementId ?? null,
          end: element?.endBinding?.elementId ?? null,
        };
      });
    };
    const matches = (shape, wanted) =>
      shape.type === wanted.type &&
      shape.label === wanted.label &&
      shape.creator?.kind === 'agent' &&
      shape.creator?.name === creator &&
      shape.start === (wanted.start ?? null) &&
      shape.end === (wanted.end ?? null);
    return new Promise((resolve, reject) => {
      let finished = false;
      let stopScene = () => {};
      let timer;
      const check = () => {
        const shapes = read();
        if (shapes.every((shape, index) => matches(shape, expected[index]))) finish(null, shapes);
      };
      const finish = (error, value) => {
        if (finished) return;
        finished = true;
        stopScene();
        doc.off('update', check);
        clearTimeout(timer);
        if (error) reject(error);
        else resolve(value);
      };
      stopScene = api.onChange(check);
      doc.on('update', check);
      timer = setTimeout(() => {
        const state = { shapes: read(), peers: handle.peers() };
        finish(new Error(`timed out waiting for the helper's shapes: ${JSON.stringify(state)}`));
      }, waitMs);
      check();
    });
  },
  /**
   * Resolves with the feedback `id` as the page shows it: its status and its text in the chat, the
   * answer the chat shows under it, whether the chat shows Reopen beside it, whether the canvas
   * outlines its area, and the top edge of the shape `shapeId` in the scene. It resolves once the
   * chat shows the feedback answered, with an answer, the canvas doesn't outline its area and the
   * scene shows the shape at `y`, on the scene's, the board's and the page's change events, and
   * rejects with what the page shows where `waitMs` passes first.
   */
  async answered(id, shapeId, y, waitMs) {
    const handle = await window.chalklineReady;
    const { api, doc } = handle;
    const selector = (base) => `${base}[data-id="${CSS.escape(id)}"]`;
    const read = () => {
      const item = document.querySelector(selector('#transcript li.transcript-feedback'));
      const part = item?.querySelector('.transcript-feedback-answer') ?? null;
      const shape = api.getSceneElements().find((candidate) => candidate.id === shapeId);
      return {
        status: item?.dataset.status ?? null,
        text: item?.querySelector(':scope > .transcript-text')?.textContent ?? null,
        answer:
          part === null
            ? null
            : {
                by: part.querySelector('.transcript-speaker')?.textContent ?? null,
                tag: part.querySelector('.transcript-feedback-answer-tag')?.textContent ?? null,
                text: part.querySelector('.transcript-text')?.textContent ?? null,
              },
        reopen: (item?.querySelector('.transcript-feedback-reopen') ?? null) !== null,
        outlined: document.querySelector(selector('.feedback-outline')) !== null,
        y: shape?.y ?? null,
      };
    };
    return new Promise((resolve, reject) => {
      let finished = false;
      let stopScene = () => {};
      let timer;
      const pageChanges = new MutationObserver(() => check());
      const check = () => {
        const shown = read();
        if (shown.status === 'answered' && shown.answer !== null && !shown.outlined && shown.y === y) {
          finish(null, shown);
        }
      };
      const finish = (error, value) => {
        if (finished) return;
        finished = true;
        stopScene();
        doc.off('update', check);
        pageChanges.disconnect();
        clearTimeout(timer);
        if (error) reject(error);
        else resolve(value);
      };
      stopScene = api.onChange(check);
      doc.on('update', check);
      pageChanges.observe(document.body, { childList: true, subtree: true, attributes: true, characterData: true });
      timer = setTimeout(() => {
        const state = { feedback: read(), peers: handle.peers() };
        finish(new Error(`timed out waiting for the answered feedback: ${JSON.stringify(state)}`));
      }, waitMs);
      check();
    });
  },
  /**
   * Resolves with the image `id` as the page shows it: its type, its fileId, the MIME type of the
   * file the page holds for it, and the red, green, blue and alpha of the static canvas's pixel at
   * the image's center. It resolves once the scene shows an image of the file `fileId`, the page
   * holds that file, and the canvas draws that pixel red, on the scene's and the board's change
   * events and on each frame the page draws, and rejects with what the page shows where `waitMs`
   * passes first.
   */
  async picture(id, fileId, waitMs) {
    const handle = await window.chalklineReady;
    const { api, doc } = handle;
    const read = () => {
      const element = api.getSceneElements().find((candidate) => candidate.id === id);
      const file = element === undefined ? undefined : api.getFiles()[element.fileId];
      let color = null;
      const canvas = document.querySelector('canvas.excalidraw__canvas.static');
      const context = canvas?.getContext('2d');
      if (element !== undefined && canvas && context && canvas.clientWidth > 0) {
        const { scrollX, scrollY, zoom } = api.getAppState();
        const ratio = canvas.width / canvas.clientWidth;
        const x = Math.round((element.x + element.width / 2 + scrollX) * zoom.value * ratio);
        const y = Math.round((element.y + element.height / 2 + scrollY) * zoom.value * ratio);
        if (x >= 0 && y >= 0 && x < canvas.width && y < canvas.height) color = [...context.getImageData(x, y, 1, 1).data];
      }
      return {
        id,
        type: element?.type ?? null,
        fileId: element?.fileId ?? null,
        mimeType: file?.mimeType ?? null,
        color,
      };
    };
    const red = (color) => color !== null && color[0] > 200 && color[1] < 60 && color[2] < 60 && color[3] === 255;
    return new Promise((resolve, reject) => {
      let finished = false;
      let stopScene = () => {};
      let frame;
      let timer;
      const check = () => {
        const shown = read();
        if (shown.type === 'image' && shown.fileId === fileId && shown.mimeType !== null && red(shown.color)) finish(null, shown);
      };
      const everyFrame = () => {
        check();
        if (!finished) frame = requestAnimationFrame(everyFrame);
      };
      const finish = (error, value) => {
        if (finished) return;
        finished = true;
        stopScene();
        doc.off('update', check);
        cancelAnimationFrame(frame);
        clearTimeout(timer);
        if (error) reject(error);
        else resolve(value);
      };
      stopScene = api.onChange(check);
      doc.on('update', check);
      timer = setTimeout(() => {
        const state = { picture: read(), peers: handle.peers() };
        finish(new Error(`timed out waiting for the helper's picture: ${JSON.stringify(state)}`));
      }, waitMs);
      everyFrame();
    });
  },
};
