import { code } from '../../core/language.ts';
import { type ModelRequest, type TranslateAdapter } from '../types.ts';

// TranslateGemma is trained on one fixed prompt and its own chat template will
// not render a plain string, so the prompt is built here and posted raw.
function prompt(text: string, source: string, target: string): string {
  return '<start_of_turn>user\n'
    + `You are a professional ${source} (${code(source)}) to ${target} (${code(target)}) `
    + 'translator. Your goal is to accurately convey the meaning and nuances of the '
    + `original ${source} text while adhering to ${target} grammar, vocabulary, and `
    + 'cultural sensitivities.\n'
    + `Produce only the ${target} translation, without any additional explanations or `
    + `commentary. Please translate the following ${source} text into ${target}:\n\n\n`
    + `${text.trim()}<end_of_turn>\n<start_of_turn>model\n`;
}

export const translateGemma: TranslateAdapter = {
  id: 'gemma-raw',
  label: 'TranslateGemma — local llama.cpp only',

  capabilities: {
    batch: true,
    localOnly: true,
  },

  build(texts: string[], source: string, target: string, maxTokens = 1024): ModelRequest {
    return {
      kind: 'completion',
      body: {
        prompt: prompt(texts.join('\n'), source, target),
        n_predict: maxTokens,
        temperature: 0,
        stop: ['<end_of_turn>'],
      },
    };
  },

  parse(content: string, expected: number): string[] | null {
    const reply = content.trim();
    // One line in, one line out: whatever came back is the answer, newlines and
    // all. Splitting it would invent lines the caller never asked for.
    if (expected === 1) return [reply];

    const lines = reply.split('\n');
    while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
    return lines.length === expected ? lines.map((l) => l.trim()) : null;
  },
};
