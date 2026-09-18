import { test } from 'node:test';
import assert from 'node:assert';

import { OCR_ADAPTERS, TRANSLATE_ADAPTERS } from '../src/backends/registry.ts';
import { SHIPPED, copyOf, uniqueName } from '../src/platform/profiles.ts';
import { PRIVATE_DEFAULTS } from '../src/platform/settings.ts';

test('every shipped profile names adapters that exist', () => {
  for (const profile of SHIPPED) {
    assert.ok(OCR_ADAPTERS[profile.reader.adapter], `${profile.id} reader`);
    assert.ok(TRANSLATE_ADAPTERS[profile.translator.adapter], `${profile.id} translator`);
  }
});

test('a hosted profile never pairs a local-only adapter with a hosted endpoint', () => {
  for (const profile of SHIPPED) {
    if (profile.reader.baseUrl.includes('127.0.0.1')) continue;
    assert.equal(TRANSLATE_ADAPTERS[profile.translator.adapter].capabilities.localOnly, false,
      `${profile.id} would never work`);
  }
});

test('ids are unique, since switching profiles goes by id', () => {
  assert.equal(new Set(SHIPPED.map((p) => p.id)).size, SHIPPED.length);
});

test('the first shipped profile is the one a fresh install opens on', () => {
  assert.equal(PRIVATE_DEFAULTS.profile, SHIPPED[0].id);
  assert.deepEqual(PRIVATE_DEFAULTS.reader, SHIPPED[0].reader);
  assert.deepEqual(PRIVATE_DEFAULTS.translator, SHIPPED[0].translator);
});

test('a duplicate is a separate profile with the key and a name of its own', () => {
  const from = { ...SHIPPED[2], reader: { ...SHIPPED[2].reader, apiKey: 'sk-x' } };
  const list = [from];
  const copy = copyOf(list, from);
  assert.notEqual(copy.id, from.id);
  assert.equal(copy.name, `${from.name} (2)`);
  assert.equal(copy.reader.apiKey, 'sk-x', 'the key comes along, or the copy cannot run');

  copy.reader.baseUrl = 'http://elsewhere';
  assert.notEqual(from.reader.baseUrl, 'http://elsewhere', 'editing one leaves the other alone');

  assert.equal(uniqueName([from, copy], from.name), `${from.name} (3)`);
});
