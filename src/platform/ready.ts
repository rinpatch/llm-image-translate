import { ocrAdapter } from '../backends/registry.ts';
import { type Profile, type Role, ROLES } from './profiles.ts';
import { provider } from './providers.ts';

/** The roles a profile actually calls: a reader that translates leaves the translator idle. */
export const rolesUsed = (profile: Profile): Role[] =>
  (ocrAdapter(profile.reader.adapter).capabilities.alsoTranslates ? ['reader'] : ROLES);

export function hostOf(url: string): string {
  try { return new URL(url).host; } catch { return ''; }
}

/**
 * Why the profile cannot run yet, or '' if it can. Otherwise the answer is a
 * bare 401 or a fetch of an empty URL, from a request that was never going to work.
 */
export function blocker(profile: Profile): string {
  for (const role of rolesUsed(profile)) {
    const endpoint = profile[role];
    const p = provider(endpoint.provider);
    if (p.editUrl && !endpoint.baseUrl) return `The ${role} needs a server.`;
    if (p.key === 'required' && !endpoint.apiKey) {
      return `The ${role} needs an API key for ${hostOf(endpoint.baseUrl)}.`;
    }
  }
  return '';
}
