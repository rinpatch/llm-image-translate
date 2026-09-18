import { type Box, type TextLine } from '../../core/geometry.ts';
import { type EncodedImage, type ModelRequest, type OcrAdapter } from '../types.ts';

// The reader was trained to emit this; the JSON variant of the same task is a
// prompt it largely ignores.
const SPOTTING = '检测并识别图片中的文字，将文本坐标格式化输出。';

// TEXT(x0,y0),(x1,y1) run together, normalised to 0-1000 on both axes.
const SPOT_RE = /(.+?)\((\d+),(\d+)\),\((\d+),(\d+)\)/gs;

const MIN_CONFIDENCE_CHARS = 2;

export function parseSpots(reply: string, width: number, height: number): TextLine[] {
  const lines: TextLine[] = [];
  for (const m of reply.matchAll(SPOT_RE)) {
    const text = m[1].trim();
    const [x0, y0, x1, y1] = [m[2], m[3], m[4], m[5]].map(Number);
    if (text.length >= MIN_CONFIDENCE_CHARS - 1 && x1 > x0 && y1 > y0) {
      const box: Box = [Math.round(x0 / 1000 * width), Math.round(y0 / 1000 * height),
                        Math.round(x1 / 1000 * width), Math.round(y1 / 1000 * height)];
      lines.push({ text, box });
    }
  }
  return lines;
}

export const hunyuanSpotting: OcrAdapter = {
  id: 'hunyuan-spotting',
  label: 'HunyuanOCR spotting',

  capabilities: {
    maxDim: 1600,
    encode: 'png',
    // It can translate, but not from Chinese, which is why a second model exists.
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
            { type: 'text', text: SPOTTING },
          ],
        }],
        temperature: 0,
        max_tokens: 2048,
      },
    };
  },

  parse(content: string, image: EncodedImage): TextLine[] {
    return parseSpots(content, image.width, image.height);
  },
};
