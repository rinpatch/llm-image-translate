import { test } from 'node:test';
import assert from 'node:assert';

import {
  CUSTOM, SERVER, cardOf, customFor, serverProfile, withCard, withKey, withKeys,
} from '../src/platform/cards.ts';
import { PRESETS, type Profile, find } from '../src/platform/profiles.ts';
import { startOn } from '../src/platform/providers.ts';

const preset = (id: string): Profile => structuredClone(find(PRESETS, id)!);

test('a preset as written is its own card, whatever key it carries', () => {
  for (const p of PRESETS) assert.equal(cardOf(p), p.id);
  const keyed = preset('openrouter');
  keyed.translator.apiKey = 'sk-or-1';
  assert.equal(cardOf(keyed), 'openrouter');
});

test('a preset edited past its card is Custom', () => {
  const edited = preset('openrouter');
  edited.translator.model = 'some/other-model';
  assert.equal(cardOf(edited), CUSTOM);

  const slow = preset('chatgpt');
  slow.translator.fast = false;
  assert.equal(cardOf(slow), CUSTOM);
});

test('the server card is the browser reading for any server', () => {
  const server = serverProfile({ ...startOn('translator', 'server'), model: 'x' });
  assert.equal(cardOf(server), SERVER);
  assert.equal(cardOf({ ...server, reader: startOn('reader', 'server') }), CUSTOM);
});

test('a profile of its own is Custom', () => {
  assert.equal(cardOf({ ...preset('openrouter'), id: 'p123' }), CUSTOM);
});

test('picking a card keeps the edits made to its profile as a copy', () => {
  const edited = preset('openrouter');
  edited.translator.model = 'some/other-model';
  const list = withCard([preset('browser-only'), edited], preset('openrouter'));
  assert.equal(list.length, 3);
  assert.equal(cardOf(find(list, 'openrouter')!), 'openrouter');
  const copy = list[2];
  assert.equal(copy.translator.model, 'some/other-model');
  assert.equal(copy.name, 'OpenRouter (2)');
});

test('picking a card that is still the card replaces it in place', () => {
  const list = withCard([preset('browser-only'), preset('openrouter')], preset('openrouter'));
  assert.equal(list.length, 2);
  assert.equal(withCard([preset('browser-only')], preset('chatgpt')).length, 2);
});

test('Custom goes to the last custom profile, or copies the one in use', () => {
  const mine = { ...preset('openrouter'), id: 'p1', name: 'Mine' };
  const list = [preset('browser-only'), mine, preset('openrouter')];
  assert.deepEqual(customFor(list, list[0]), { list, id: 'p1' });
  assert.equal(customFor(list, mine).id, 'p1');

  const only = [preset('browser-only')];
  const made = customFor(only, only[0]);
  assert.equal(made.list.length, 2);
  assert.equal(made.list[1].name, 'Custom');
  assert.equal(cardOf(made.list[1]), CUSTOM);
});

test('keys follow the server, across profiles', () => {
  const filled = withKeys(preset('openrouter'), { 'https://openrouter.ai/api': 'sk-or-1' });
  assert.equal(filled.reader.apiKey, 'sk-or-1');
  assert.equal(filled.translator.apiKey, 'sk-or-1');

  const list = withKey([preset('openrouter'), preset('browser-only')],
    'https://openrouter.ai/api', 'sk-or-2');
  assert.equal(list[0].translator.apiKey, 'sk-or-2');
  assert.equal(list[1].translator.apiKey, '');
});
