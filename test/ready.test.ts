import { test } from 'node:test';
import assert from 'node:assert';

import { startOn } from '../src/platform/providers.ts';
import { blocker } from '../src/platform/ready.ts';
import './i18n.ts';

test('a hosted translator without its key says which and where', () => {
  assert.equal(blocker(startOn('openrouter')), 'The translator needs an API key for openrouter.ai.');
  assert.equal(blocker({ ...startOn('openrouter'), apiKey: 'sk-or-1' }), '');
});

test('the ChatGPT plan asks to be signed in to', () => {
  assert.equal(blocker(startOn('chatgpt')), 'Sign in to ChatGPT first.');
});

test('a server with no URL is caught before the key it may not need', () => {
  assert.equal(blocker({ ...startOn('server'), baseUrl: '' }), 'The translator needs a server.');
  assert.equal(blocker(startOn('server')), '', 'install.sh\'s address, and no key asked for');
  assert.equal(blocker(startOn('browser')), '', 'nothing to fill in at all');
});
