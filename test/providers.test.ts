import { test } from 'node:test';
import assert from 'node:assert';

import { TRANSLATE_ADAPTERS } from '../src/backends/registry.ts';
import { PROVIDERS, guessAdapter, keyScope, startOn } from '../src/platform/providers.ts';
import { PRIVATE_DEFAULTS } from '../src/platform/settings.ts';

test('every card\'s model names an adapter that exists', () => {
  for (const p of PROVIDERS) {
    if (p.known) assert.ok(TRANSLATE_ADAPTERS[p.known.adapter], p.id);
  }
});

test('a hosted card never pairs a local-only adapter with a hosted endpoint', () => {
  for (const p of PROVIDERS.filter((one) => one.known && one.baseUrl.startsWith('https'))) {
    assert.equal(TRANSLATE_ADAPTERS[p.known!.adapter].capabilities.localOnly, false, p.id);
  }
});

test('a fresh install translates with nothing to start and no key', () => {
  assert.equal(PRIVATE_DEFAULTS.provider, 'browser');
  assert.equal(startOn('browser').adapter, 'chrome-translator');
});

test('the local model gets the adapter install.sh serves it for', () => {
  assert.equal(guessAdapter('tencent/Hy-MT2-1.8B-GGUF:Q6_K', true), 'hunyuan-mt');
});

test('a model nobody listed gets the adapter its family answers in', () => {
  assert.equal(guessAdapter('tencent/hy-mt1.5-7b', false), 'hunyuan-mt');
  assert.equal(guessAdapter('translategemma-4b', true), 'gemma-raw');
  assert.equal(guessAdapter('google/translategemma-4b', false), 'chat-lines',
    'raw prompts need llama.cpp\'s /completion');
});

test('one server is one key however its URL is written', () => {
  assert.equal(keyScope('https://openrouter.ai/api/v1'), keyScope('https://OpenRouter.ai/api/v1/'));
  assert.equal(keyScope('https://openrouter.ai/api/v1'), keyScope('https://openrouter.ai/api'));
  assert.notEqual(keyScope('http://127.0.0.1:8090'), keyScope('http://127.0.0.1:8091'));
});
