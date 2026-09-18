import { type Box, type TextLine } from '../../core/geometry.ts';
import { extractRows } from '../json.ts';
import { type EncodedImage, type ModelRequest, type OcrAdapter } from '../types.ts';

interface Spot {
  text?: unknown;
  translation?: unknown;
  box?: unknown;
  box_2d?: unknown;
  bbox?: unknown;
  bbox_2d?: unknown;
}

// For a general vision model with no spotting task of its own.
//
// Coordinates are asked for on a normalized 0-1000 grid, matching Qwen's
// grounding format. Values outside the grid are clamped rather than used to
// guess a different coordinate system.
//
// The axis order is not something a prompt can settle. Gemini answers
// [ymin, xmin, ymax, xmax] however it is asked, and read the other way round its
// boxes are nonsense rather than merely wrong, so it gets its own adapter and a
// preset that pairs the two.
//
// `translates` asks for the English alongside each line. A model strong enough
// to do both at once saves a whole round trip, and it has the rest of the page
// in front of it while it translates, which a text-only translator never does.
function jsonBoxesAdapter(
  id: string, label: string, yFirst: boolean, translates = false,
): OcrAdapter {
  return {
  id,
  label,

  capabilities: {
    // Smaller and lossier than the local reader gets: a remote endpoint bills by
    // image token, and the flood fill does not need the pixels a reader does.
    maxDim: 1280,
    encode: 'jpeg',
    alsoTranslates: translates,
  },

  build(image: EncodedImage, target: string): ModelRequest {
    return {
      kind: 'chat',
      body: {
        messages: [{
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: image.dataUrl } },
            {
              type: 'text',
              text: 'Locate every line of text in this image. Reply with only a JSON array, one '
                + 'object per line of text, of the form '
                + (translates
                  ? `{"text": "...", "translation": "...", `
                    + `"bbox_2d": [x_min, y_min, x_max, y_max]}.\n`
                    + `"translation" is that line rendered in ${target}, translated with the `
                    + 'whole page as context — the speaker, the tone, and the lines around it. '
                    + `Translate every line, and leave "translation" as "" only for a line that `
                    + `is already ${target} or is not words at all.\n`
                  : '{"text": "...", "bbox_2d": [x_min, y_min, x_max, y_max]}.\n')
                + 'bbox_2d is a tight bounding box around only the visible glyphs of that '
                + 'single text line. Coordinates are integers normalized independently to '
                + '0-1000 over the full image: x is horizontal and y is vertical. Do not box '
                + 'the speech bubble, paragraph, or surrounding whitespace. Keep lines '
                + 'separate. No commentary.',
            },
          ],
        }],
        temperature: 0,
        // A dense page runs long, and an unfinished array parses to nothing.
        // Carrying a translation beside every line roughly doubles the reply.
        max_tokens: translates ? 8192 : 4096,
      },
    };
  },

  parse(content: string, image: EncodedImage): TextLine[] {
    const rows = extractRows(content);
    if (!rows) return [];

    const spots: { text: string; translation?: string; quad: number[] }[] = [];
    for (const row of rows as Spot[]) {
      if (typeof row?.text !== 'string' || !row.text.trim()) continue;
      // Older endpoint presets may still answer with one of these aliases.
      const raw = row.bbox_2d ?? row.box_2d ?? row.bbox ?? row.box;
      if (!Array.isArray(raw) || raw.length !== 4) continue;
      const quad = raw.map(Number);
      if (quad.some((v) => !Number.isFinite(v))) continue;
      spots.push({
        text: row.text.trim(),
        ...(translates
          ? { translation: typeof row.translation === 'string' ? row.translation.trim() : '' }
          : {}),
        quad: yFirst ? [quad[1], quad[0], quad[3], quad[2]] : quad,
      });
    }

    const scaleX = image.width / 1000;
    const scaleY = image.height / 1000;
    const at = (v: number, scale: number, max: number) =>
      Math.max(0, Math.min(max, Math.round(v * scale)));

    const lines: TextLine[] = [];
    for (const { text, translation, quad } of spots) {
      const [x0, y0, x1, y1] = quad;
      const box: Box = [
        at(Math.min(x0, x1), scaleX, image.width),
        at(Math.min(y0, y1), scaleY, image.height),
        at(Math.max(x0, x1), scaleX, image.width),
        at(Math.max(y0, y1), scaleY, image.height),
      ];
      if (box[2] <= box[0] || box[3] <= box[1]) continue;
      lines.push(translation === undefined ? { text, box } : { text, box, translation });
    }
    return lines;
  },
  };
}

export const jsonBoxes = jsonBoxesAdapter(
  'json-boxes', 'JSON boxes — Qwen3-VL, GLM, DeepSeek', false);

export const jsonBoxesYx = jsonBoxesAdapter(
  'json-boxes-yx', 'JSON boxes, y first — Gemini', true);

export const jsonBoxesTranslating = jsonBoxesAdapter(
  'json-boxes-translate', 'JSON boxes + translation, one pass', false, true);

export const jsonBoxesYxTranslating = jsonBoxesAdapter(
  'json-boxes-yx-translate', 'JSON boxes + translation, y first — Gemini', true, true);
