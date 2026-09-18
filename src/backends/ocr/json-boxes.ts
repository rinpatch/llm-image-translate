import { type Box, type TextLine } from '../../core/geometry.ts';
import { asArray, extractJson } from '../json.ts';
import { type EncodedImage, type ModelRequest, type OcrAdapter } from '../types.ts';

interface Spot {
  text?: unknown;
  box?: unknown;
}

// For a general vision model with no spotting task of its own.
//
// Coordinates are asked for on a 0-1000 grid, which is what Qwen3-VL returns in
// practice even when the prompt spells out the pixel size of the image. A model
// that answers in pixels anyway is caught by the one thing the grid cannot do,
// which is exceed 1000.
export const jsonBoxes: OcrAdapter = {
  id: 'json-boxes',

  capabilities: {
    // Smaller and lossier than the local reader gets: a remote endpoint bills by
    // image token, and the flood fill does not need the pixels a reader does.
    maxDim: 1280,
    encode: 'jpeg',
    alsoTranslates: false,
  },

  build(image: EncodedImage): ModelRequest {
    return {
      kind: 'chat',
      body: {
        messages: [{
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: image.dataUrl } },
            {
              type: 'text',
              text: 'Find every line of text in this image. Reply with only a JSON array, one '
                + 'object per line of text, of the form '
                + '{"text": "...", "box": [x0, y0, x1, y1]}.\n'
                + 'The box is on a 0-1000 grid over the image, measured from its top-left '
                + 'corner: x0,y0 is the top-left of the line and x1,y1 the bottom-right. Keep '
                + 'lines separate rather than merging them into a paragraph. No commentary.',
            },
          ],
        }],
        temperature: 0,
        max_tokens: 2048,
      },
    };
  },

  parse(content: string, image: EncodedImage): TextLine[] {
    const rows = asArray(extractJson(content));
    if (!rows) return [];

    const spots: { text: string; quad: number[] }[] = [];
    for (const row of rows as Spot[]) {
      if (typeof row?.text !== 'string' || !row.text.trim()) continue;
      const raw = row.box;
      if (!Array.isArray(raw) || raw.length !== 4) continue;
      const quad = raw.map(Number);
      if (quad.some((v) => !Number.isFinite(v))) continue;
      spots.push({ text: row.text.trim(), quad });
    }

    const overflowed = spots.some(({ quad }) => quad.some((v) => v > 1000));
    const scaleX = overflowed ? 1 : image.width / 1000;
    const scaleY = overflowed ? 1 : image.height / 1000;
    const at = (v: number, scale: number, max: number) =>
      Math.max(0, Math.min(max, Math.round(v * scale)));

    const lines: TextLine[] = [];
    for (const { text, quad } of spots) {
      const [x0, y0, x1, y1] = quad;
      const box: Box = [
        at(Math.min(x0, x1), scaleX, image.width),
        at(Math.min(y0, y1), scaleY, image.height),
        at(Math.max(x0, x1), scaleX, image.width),
        at(Math.max(y0, y1), scaleY, image.height),
      ];
      if (box[2] <= box[0] || box[3] <= box[1]) continue;
      lines.push({ text, box });
    }
    return lines;
  },
};
