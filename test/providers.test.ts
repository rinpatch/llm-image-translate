import { test } from 'node:test';
import assert from 'node:assert';

import { OCR_ADAPTERS, TRANSLATE_ADAPTERS } from '../src/backends/registry.ts';
import { SHIPPED } from '../src/platform/profiles.ts';
import {
  PROVIDERS, adapterFor, guessAdapter, keyScope, knownModel, onePass, providerOf, startOn, twoPass,
} from '../src/platform/providers.ts';

test('every known model names an adapter that exists', () => {
  for (const p of PROVIDERS) {
    for (const known of p.models.reader || []) assert.ok(OCR_ADAPTERS[known.adapter], known.name);
    for (const known of p.models.translator || []) {
      assert.ok(TRANSLATE_ADAPTERS[known.adapter], known.name);
    }
  }
});

test('every one-pass variant is a real adapter that translates', () => {
  for (const plain of ['json-boxes', 'json-boxes-yx']) {
    const both = onePass(plain)!;
    assert.equal(OCR_ADAPTERS[both].capabilities.alsoTranslates, true);
    assert.equal(twoPass(both), plain);
  }
  assert.equal(onePass('hunyuan-spotting'), undefined, 'no checkbox where there is no variant');
});

test('every shipped endpoint is filed under the provider it would be worked out as', () => {
  for (const profile of SHIPPED) {
    for (const endpoint of [profile.reader, profile.translator]) {
      assert.equal(providerOf({ ...endpoint, provider: undefined }), endpoint.provider,
        profile.id);
    }
  }
});

test('every shipped OpenRouter model shows up by name rather than as "another model"', () => {
  for (const profile of SHIPPED) {
    for (const role of ['reader', 'translator'] as const) {
      if (profile[role].provider !== 'openrouter') continue;
      assert.ok(knownModel(role, profile[role]), `${profile.id} ${role}`);
    }
  }
});

test('the models install.sh serves get the adapters the shipped profiles use', () => {
  assert.equal(guessAdapter('reader', 'prithivMLmods/HunyuanOCR-1.5-GGUF-Updated:Q8_0', true),
    'hunyuan-spotting');
  assert.equal(guessAdapter('translator', 'tencent/Hy-MT2-1.8B-GGUF:Q6_K', true), 'hunyuan-mt');
});

test('a model nobody listed gets the adapter its family answers in', () => {
  assert.equal(guessAdapter('reader', 'google/gemini-2.5-flash', false), 'json-boxes-yx');
  assert.equal(guessAdapter('reader', 'z-ai/glm-4.5v', false), 'json-boxes');
  assert.equal(guessAdapter('translator', 'tencent/hy-mt1.5-7b', false), 'hunyuan-mt');
  assert.equal(guessAdapter('translator', 'translategemma-4b', true), 'gemma-raw');
  assert.equal(guessAdapter('translator', 'google/translategemma-4b', false), 'chat-lines',
    'raw prompts need llama.cpp\'s /completion');
});

test('changing the model keeps a one-pass reader in one pass', () => {
  const endpoint = { ...startOn('reader', 'openrouter'), adapter: 'json-boxes-translate',
    model: 'google/gemini-3-pro' };
  assert.equal(adapterFor('reader', endpoint), 'json-boxes-yx-translate');
  const local = { ...endpoint, model: 'HunyuanOCR-1.5' };
  assert.equal(adapterFor('reader', local), 'hunyuan-spotting',
    'a reader with no translating variant drops back to reading');
});

test('one server is one key however its URL is written', () => {
  assert.equal(keyScope('https://openrouter.ai/api/v1'), keyScope('https://OpenRouter.ai/api/v1/'));
  assert.equal(keyScope('https://openrouter.ai/api/v1'), keyScope('https://openrouter.ai/api'));
  assert.notEqual(keyScope('http://127.0.0.1:8090'), keyScope('http://127.0.0.1:8091'));
});
