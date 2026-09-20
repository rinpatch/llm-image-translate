// What the reader in the offscreen document answers, and how it is read back.
//
// Deliberately does not import ./engine.ts: the registry reaches this file from
// the service worker, and engine.ts pulls in ONNX Runtime — which belongs in
// the offscreen bundle and nowhere near the worker's.
import { type Box, type TextLine } from '../../../core/geometry.ts';
import { type EncodedImage, type ModelRequest, type OcrAdapter } from '../../types.ts';


// PP-OCR's detector answers with a quadrilateral, because it segments the ink
// rather than guessing a rectangle. Grouping and layout work in axis-aligned
// boxes, and the lean is read off the pixels later, so the quad is reduced to
// the box that holds it here — where what this reader means is its adapter's
// business and nobody else's.
interface Spot {
  text: string;
  /** CTC's own confidence in the reading, 0-1. */
  score: number;
  quad: [number, number][];
}

// Under this the recogniser was guessing at something that is probably not
// writing: a texture, a logo, the edge of a panel. Taken from the noisy page,
// where the faintest real line still scores above 0.6.
const MIN_SCORE = 0.5;

const boxOf = (quad: [number, number][]): Box => [
  Math.round(Math.min(...quad.map((p) => p[0]))),
  Math.round(Math.min(...quad.map((p) => p[1]))),
  Math.round(Math.max(...quad.map((p) => p[0]))),
  Math.round(Math.max(...quad.map((p) => p[1]))),
];

function parseSpots(content: string): TextLine[] {
  let spots: Spot[];
  try {
    spots = JSON.parse(content);
  } catch {
    return [];
  }
  return spots
    .filter((spot) => spot?.text?.trim() && spot.score >= MIN_SCORE && spot.quad?.length === 4)
    .map((spot) => ({ text: spot.text.trim(), box: boxOf(spot.quad) }));
}

// Its own detector resizes to a shorter side of its own, so the cost of a
// larger page is the crops it recognises, not the detection. PNG because the
// bytes never leave the browser.
const capabilities = { maxDim: 1600, encode: 'png', alsoTranslates: false } as const;

export const ppOcrBrowser: OcrAdapter = {
  id: 'ppocr-browser',
  label: 'PP-OCR (in this browser)',
  capabilities: { ...capabilities, inBrowser: true },
  build: (image: EncodedImage): ModelRequest => ({
    kind: 'offscreen', body: { image: image.dataUrl },
  }),
  parse: parseSpots,
};
