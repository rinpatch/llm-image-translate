// Translations as Danbooru draws them: a pale box over each run of text, and
// the translation in a note that opens while the box is hovered.

import { type BlockReport } from '../platform/messages.ts';

const STYLE = `
.notes { position: absolute; pointer-events: none; }
.box {
  position: absolute; box-sizing: border-box;
  background: rgba(255, 255, 238, .5); border: 1px solid #000;
  pointer-events: auto; cursor: default;
}
.box:hover { background: rgba(255, 255, 238, .2); z-index: 1; }
.body {
  display: none; position: absolute; top: 100%; left: -1px; margin-top: 4px;
  width: max-content; min-width: 140px; max-width: 300px;
  padding: 4px 6px; box-sizing: border-box;
  background: #ffe; color: #000; border: 1px solid #000;
  font: 13px/1.4 -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  text-align: left; white-space: pre-wrap; overflow-wrap: anywhere;
}
.box:hover > .body { display: block; }
.box.up > .body { top: auto; bottom: 100%; margin: 0 0 4px; }
.box.end > .body { left: auto; right: -1px; }
/* The gap above or below the box is still the box, so moving onto the note
   does not close it on the way. */
.body::before { content: ''; position: absolute; left: 0; right: 0; height: 6px; top: -6px; }
.box.up > .body::before { top: auto; bottom: -6px; }
`;

/**
 * One positioned layer per image. Boxes are placed in percentages of the image
 * the reader saw, so the layer only has to be sized to the <img> to line up at
 * whatever size the page shows it.
 */
export function notesFor(blocks: BlockReport[], width: number, height: number): HTMLElement {
  const layer = document.createElement('div');
  layer.className = 'notes';
  const style = document.createElement('style');
  style.textContent = STYLE;
  layer.append(style);
  const pct = (n: number, of: number) => `${(n / of) * 100}%`;
  for (const { box: [x0, y0, x1, y1], translation, skipped } of blocks) {
    if (skipped || !translation.trim()) continue;
    const box = document.createElement('div');
    box.className = 'box';
    box.style.left = pct(x0, width);
    box.style.top = pct(y0, height);
    box.style.width = pct(x1 - x0, width);
    box.style.height = pct(y1 - y0, height);
    // Opened toward the middle of the image, so a note on the bottom or right
    // edge is not cut off by whatever the page clips the image to.
    box.classList.toggle('up', (y0 + y1) / 2 > height * 0.65);
    box.classList.toggle('end', (x0 + x1) / 2 > width * 0.6);
    const body = document.createElement('div');
    body.className = 'body';
    body.textContent = translation;
    box.append(body);
    layer.append(box);
  }
  return layer;
}
