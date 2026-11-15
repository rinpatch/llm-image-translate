import { type EndpointSettings } from './endpoint.ts';
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
  if (p.editUrl && !translator.baseUrl) return 'The translator needs a server.';
  if (p.key === 'signin' && !translator.apiKey) return 'Sign in to ChatGPT first.';
  if (p.key === 'required' && !translator.apiKey) {
    return `The translator needs an API key for ${hostOf(translator.baseUrl)}.`;
  }
  return '';
}
