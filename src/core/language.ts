const NON_LATIN = /[Ѐ-ӿ぀-ヿ㐀-䶿一-鿿가-힯]/;

const SCRIPTS: [string, RegExp][] = [
  ['Japanese', /[぀-ヿ]/],
  ['Korean', /[가-힯]/],
  ['Russian', /[Ѐ-ӿ]/],
  ['Arabic', /[؀-ۿ]/],
  ['Thai', /[฀-๿]/],
  ['Hindi', /[ऀ-ॿ]/],
  ['Chinese', /[㐀-䶿一-鿿]/],
];

export const CODES: Record<string, string> = {
  english: 'en', chinese: 'zh', japanese: 'ja', korean: 'ko', russian: 'ru',
  ukrainian: 'uk', spanish: 'es', french: 'fr', german: 'de', portuguese: 'pt',
  italian: 'it', dutch: 'nl', polish: 'pl', turkish: 'tr', arabic: 'ar',
  hindi: 'hi', thai: 'th', vietnamese: 'vi', indonesian: 'id',
  malay: 'ms',
};

export const LANGUAGES = Object.keys(CODES).map((n) => n[0].toUpperCase() + n.slice(1));

const LANGUAGE_NAMES: Record<string, string> =
  Object.fromEntries(Object.entries(CODES).map(([name, id]) => [id, name]));

export interface Detection {
  isReliable: boolean;
  languages?: { language: string; percentage: number }[];
}

/** Whatever the platform offers for Latin text the scripts below cannot place. */
export type Detect = (text: string) => Promise<Detection>;

export function code(name: string): string {
  return CODES[(name || '').trim().toLowerCase()] || 'en';
}

export function sourceLanguage(texts: string[]): string | null {
  const joined = texts.join('');
  for (const [name, pattern] of SCRIPTS) if (pattern.test(joined)) return name;
  return null;
}

export async function detectedSource(
  texts: string[],
  configured: string,
  detect: Detect,
): Promise<string> {
  if (configured && configured.toLowerCase() !== 'auto') return configured;
  const scripted = sourceLanguage(texts);
  if (scripted) return scripted;

  const result = await detect(texts.join('\n'));
  const best = result.languages?.[0];
  const name = LANGUAGE_NAMES[(best?.language || '').toLowerCase().split('-')[0]];
  if (!result.isReliable || !best || best.percentage < 55 || !name) {
    throw new Error('Could not reliably detect the source language — choose one in Translate from');
  }
  return name[0].toUpperCase() + name.slice(1);
}

/** A reason to leave the block alone, or null when the translation looks real. */
export function untranslated(source: string, result: string, target: string): string | null {
  if (!result) return 'no translation came back';
  if (result.trim() === source.trim()) return 'came back unchanged';
  if (['chinese', 'japanese', 'korean', 'russian', 'ukrainian']
      .includes(target.trim().toLowerCase())) return null;
  const letters = [...result].filter((c) => /\p{L}/u.test(c));
  if (letters.length && letters.filter((c) => NON_LATIN.test(c)).length / letters.length > 0.2) {
    return `reply is not in ${target}`;
  }
  return null;
}
