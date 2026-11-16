import { type EndpointSettings } from './endpoint.ts';
import { t } from './i18n.ts';
import { provider } from './providers.ts';

export function hostOf(url: string): string {
  try { return new URL(url).host; } catch { return ''; }
}

/**
 * Why the translator cannot run yet, or '' if it can. Otherwise the answer is a
 * bare 401 or a fetch of an empty URL, from a request that was never going to work.
 */
export function blocker(translator: EndpointSettings): string {
  const p = provider(translator.provider);
  if (p.editUrl && !translator.baseUrl) return t('needsServer');
  if (p.key === 'signin' && !translator.apiKey) return t('signInFirst');
  if (p.key === 'required' && !translator.apiKey) {
    return t('needsKey', hostOf(translator.baseUrl));
  }
  return '';
}
