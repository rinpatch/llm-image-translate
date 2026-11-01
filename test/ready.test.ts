import { test } from 'node:test';
import assert from 'node:assert';

import { SHIPPED, find } from '../src/platform/profiles.ts';
import { blocker, rolesUsed } from '../src/platform/ready.ts';

const shipped = (id: string) => structuredClone(find(SHIPPED, id)!);

test('a one-pass profile does not wait on its idle translator', () => {
  const profile = shipped('openrouter-one-pass');
  assert.deepEqual(rolesUsed(profile), ['reader']);
  profile.reader.apiKey = 'sk-or-1';
  assert.equal(blocker(profile), '', 'the translator has no key, and is never called');
});

test('a hosted role without its key says which and where', () => {
  const profile = shipped('openrouter');
  profile.reader.apiKey = 'sk-or-1';
  assert.equal(blocker(profile), 'The translator needs an API key for openrouter.ai.');
});

test('a server with no URL is caught before the key it may not need', () => {
  const profile = shipped('llamacpp');
  profile.translator.baseUrl = '';
  assert.equal(blocker(profile), 'The translator needs a server.');
  assert.equal(blocker(shipped('browser-only')), '', 'nothing to fill in at all');
});
