import { code } from '../../core/language.ts';
import { asArray, extractJson } from '../json.ts';
import { type ModelRequest, type TranslateAdapter } from '../types.ts';

interface Line {
  i?: unknown;
  text?: unknown;
}

// Numbered in, numbered out. A model that merges two lines or drops one can no
// longer shift everything after it, which is what a bare list of lines does.
export const chatLines: TranslateAdapter = {
  id: 'chat-lines',
  label: 'Numbered lines — any instruct model',

  capabilities: {
    batch: true,
    localOnly: false,
  },

  build(texts: string[], source: string, target: string, maxTokens = 2048): ModelRequest {
    const numbered = texts.map((text, i) => `${i + 1}. ${text.replace(/\n/g, ' ')}`).join('\n');
    return {
      kind: 'chat',
      body: {
        messages: [
          {
            role: 'system',
            content: `You are a professional ${source} (${code(source)}) to `
              + `${target} (${code(target)}) translator. These lines come from one image and `
              + 'belong together, so translate them as a whole. Keep each line separate.',
          },
          {
            role: 'user',
            content: `Translate each numbered line into ${target}. Reply with only a JSON `
              + 'array, one object per line, of the form {"i": 1, "text": "..."}, keeping the '
              + 'numbers you were given. No commentary.\n\n'
              + numbered,
          },
        ],
        temperature: 0,
        max_tokens: maxTokens,
      },
    };
  },

  parse(content: string, expected: number): (string | null)[] | null {
    const rows = asArray(extractJson(content));
    if (!rows) return null;

    const out: (string | null)[] = Array(expected).fill(null);
    for (const row of rows as Line[]) {
      const at = Number(row?.i) - 1;
      if (!Number.isInteger(at) || at < 0 || at >= expected) continue;
      if (typeof row.text !== 'string') continue;
      out[at] = row.text.trim();
    }
    // Every number wrong means the reply was not this protocol at all; asking
    // again line by line stands a better chance than keeping nothing.
    return out.some((line) => line !== null) ? out : null;
  },
};
