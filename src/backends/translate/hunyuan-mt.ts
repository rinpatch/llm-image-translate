import { type ModelRequest, type TranslateAdapter } from '../types.ts';

// Hy-MT2 is a translation model, not a chat model: asked for JSON it translates
// the instructions along with the text. Tencent documents one instruction, and
// that is what it answers to. The numbering rides along inside the text being
// translated, which the model preserves, so a merged line still cannot shift
// the ones after it.
//
// The documented prompt names only the target language — the model works out
// the source itself — so `source` goes unused here.
export const hunyuanMt: TranslateAdapter = {
  id: 'hunyuan-mt',
  label: 'Hunyuan MT — numbered lines',

  capabilities: {
    batch: true,
    localOnly: false,
  },

  build(texts: string[], _source: string, target: string, maxTokens = 2048): ModelRequest {
    const numbered = texts.map((text, i) => `${i + 1}. ${text.replace(/\n/g, ' ')}`).join('\n');
    return {
      kind: 'chat',
      body: {
        messages: [{
          role: 'user',
          content: `Translate the following text into ${target}. Note that you should **only `
            + 'output the translated result without any additional explanation**. Keep the '
            + `numbering, one line per numbered line:\n\n${numbered}`,
        }],
        temperature: 0,
        max_tokens: maxTokens,
      },
    };
  },

  parse(content: string, expected: number): (string | null)[] | null {
    const reply = content.trim();
    const out: (string | null)[] = Array(expected).fill(null);
    for (const line of reply.split('\n')) {
      const m = line.match(/^\s*(\d+)[.)]\s*(.+)$/);
      if (!m) continue;
      const at = Number(m[1]) - 1;
      if (at >= 0 && at < expected) out[at] = m[2].trim();
    }
    if (out.some((line) => line !== null)) return out;
    // One line in with no numbering back: whatever came back is the answer.
    return expected === 1 && reply ? [reply] : null;
  },
};
