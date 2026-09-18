import { code } from '../../core/language.ts';

// TranslateGemma is trained on one fixed prompt and its own chat template will
// not render a plain string, so the prompt is built here and posted raw.
export function prompt(text: string, source: string, target: string): string {
  return '<start_of_turn>user\n'
    + `You are a professional ${source} (${code(source)}) to ${target} (${code(target)}) `
    + 'translator. Your goal is to accurately convey the meaning and nuances of the '
    + `original ${source} text while adhering to ${target} grammar, vocabulary, and `
    + 'cultural sensitivities.\n'
    + `Produce only the ${target} translation, without any additional explanations or `
    + `commentary. Please translate the following ${source} text into ${target}:\n\n\n`
    + `${text.trim()}<end_of_turn>\n<start_of_turn>model\n`;
}

export const STOP = ['<end_of_turn>'];
