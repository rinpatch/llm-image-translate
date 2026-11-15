import { test } from 'node:test';
import assert from 'node:assert';

import { OCR_ADAPTERS, TRANSLATE_ADAPTERS } from '../src/backends/registry.ts';
import { PRESETS, SHIPPED, copyOf, uniqueName } from '../src/platform/profiles.ts';
import { PRIVATE_DEFAULTS } from '../src/platform/settings.ts';

test('every preset names adapters that exist', () => {
  for (const profile of PRESETS) {
    assert.ok(OCR_ADAPTERS[profile.reader.adapter], `${profile.id} reader`);
    assert.ok(TRANSLATE_ADAPTERS[profile.translator.adapter], `${profile.id} translator`);
  }
});

test('a hosted profile never pairs a local-only adapter with a hosted endpoint', () => {
  for (const profile of PRESETS) {
    if (profile.translator.baseUrl.includes('127.0.0.1')) continue;
    assert.equal(TRANSLATE_ADAPTERS[profile.translator.adapter].capabilities.localOnly, false,
      `${profile.id} would never work`);
  }
});

test('ids are unique, since switching profiles goes by id', () => {
  assert.equal(new Set(PRESETS.map((p) => p.id)).size, PRESETS.length);
});

test('the first shipped profile is the one a fresh install opens on', () => {
  assert.equal(PRIVATE_DEFAULTS.profile, SHIPPED[0].id);
  assert.equal(SHIPPED[0].reader.adapter, 'ppocr-browser');
  assert.equal(SHIPPED[0].translator.adapter, 'chrome-translator', 'nothing to start at all');
});

test('a duplicate is a separate profile with a name of its own', () => {
  const from = { ...PRESETS[1], reader: { ...PRESETS[1].reader } };
  const list = [from];
  const copy = copyOf(list, from);
  assert.notEqual(copy.id, from.id);
  assert.equal(copy.name, `${from.name} (2)`);

  copy.reader.baseUrl = 'http://elsewhere';
  assert.notEqual(from.reader.baseUrl, 'http://elsewhere', 'editing one leaves the other alone');

  assert.equal(uniqueName([from, copy], from.name), `${from.name} (3)`);
});
