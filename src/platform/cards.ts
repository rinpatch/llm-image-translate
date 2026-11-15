// The setups the welcome page and the settings page offer as cards, and which
// card a stored profile still is. A profile is only a card's while it is
// exactly what the card writes; anything edited past that is Custom.
import {
  type EndpointSettings, type Profile, PRESETS, ROLES, copyOf, find, newId, uniqueName,
} from './profiles.ts';
import { scopeOf, startOn } from './providers.ts';

/** The one card that is not a preset: its translator is whatever server is typed in. */
export const SERVER = 'server';
export const CUSTOM = 'custom';

// Keys are left out: they belong to the server, not to the profile.
const same = (a: EndpointSettings, b: EndpointSettings) =>
  a.provider === b.provider && a.baseUrl === b.baseUrl && a.model === b.model
  && a.adapter === b.adapter && (a.effort || '') === (b.effort || '')
  && (a.fast !== false) === (b.fast !== false);

export function cardOf(profile: Profile): string {
  if (profile.id === SERVER) {
    return same(profile.reader, startOn('reader', 'browser'))
      && profile.translator.provider === 'server' ? SERVER : CUSTOM;
  }
  const preset = find(PRESETS, profile.id);
  return preset && same(profile.reader, preset.reader)
    && same(profile.translator, preset.translator) ? preset.id : CUSTOM;
}

/** The server card's profile: PP-OCR reads, the server translates. */
export const serverProfile = (translator: EndpointSettings): Profile => ({
  id: SERVER,
  name: 'OpenAI-compatible server',
  reader: startOn('reader', 'browser'),
  translator,
});

export function withKeys(profile: Profile, keyring: Record<string, string>): Profile {
  const out = { ...profile };
  for (const role of ROLES) {
    out[role] = { ...profile[role], apiKey: keyring[scopeOf(profile[role])] || '' };
  }
  return out;
}

/**
 * The list with `card` written under its id. One stored there that was edited
 * past the card is kept as a copy, since picking a card is not asking to lose
 * those edits.
 */
export function withCard(list: Profile[], card: Profile): Profile[] {
  const existing = find(list, card.id);
  if (!existing) return [...list, card];
  const out = list.map((p) => (p.id === card.id ? card : p));
  if (cardOf(existing) !== CUSTOM) return out;
  return [...out, { ...existing, id: newId(), name: uniqueName(out, existing.name) }];
}

/**
 * Where picking Custom goes: the profile in use if no card describes it, else
 * the last one no card describes, else a copy of the one in use to edit.
 */
export function customFor(list: Profile[], active: Profile): { list: Profile[]; id: string } {
  if (cardOf(active) === CUSTOM) return { list, id: active.id };
  const last = list.filter((p) => cardOf(p) === CUSTOM).at(-1);
  if (last) return { list, id: last.id };
  const copy = copyOf(list, active, 'Custom');
  return { list: [...list, copy], id: copy.id };
}

/** Every endpoint on `scope` takes the new key, in every profile. */
export const withKey = (list: Profile[], scope: string, key: string): Profile[] =>
  list.map((profile) => {
    const copy = { ...profile };
    for (const role of ROLES) {
      if (scopeOf(profile[role]) === scope) copy[role] = { ...profile[role], apiKey: key };
    }
    return copy;
  });
