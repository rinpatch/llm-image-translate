import { test } from 'node:test';
import assert from 'node:assert';

import { PRESETS, find } from '../src/platform/profiles.ts';
import { blocker, rolesUsed } from '../src/platform/ready.ts';

const preset = (id: string) => structuredClone(find(PRESETS, id)!);

test('a one-pass profile does not wait on its idle translator', () => {
  const profile = preset('openrouter');
  profile.reader.adapter = 'json-boxes-yx-translate';
  assert.deepEqual(rolesUsed(profile), ['reader']);
  profile.reader.apiKey = 'sk-or-1';
  assert.equal(blocker(profile), '', 'the translator has no key, and is never called');
});

test('a hosted role without its key says which and where', () => {
  const profile = preset('openrouter');
  profile.reader.apiKey = 'sk-or-1';
  assert.equal(blocker(profile), 'The translator needs an API key for openrouter.ai.');
});

test('a server with no URL is caught before the key it may not need', () => {
  const profile = preset('browser-only');
  profile.translator = { provider: 'server', baseUrl: '', apiKey: '', model: '',
    adapter: 'hunyuan-mt' };
  assert.equal(blocker(profile), 'The translator needs a server.');
  assert.equal(blocker(preset('browser-only')), '', 'nothing to fill in at all');
});
