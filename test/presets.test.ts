import { test } from 'node:test';
import assert from 'node:assert';

import { OCR_ADAPTERS, TRANSLATE_ADAPTERS } from '../src/backends/registry.ts';
import { jsonBoxes, jsonBoxesYx } from '../src/backends/ocr/json-boxes.ts';
import { PRESETS, matching, presetFor } from '../src/platform/presets.ts';
import { PRIVATE_DEFAULTS } from '../src/platform/settings.ts';

const image = { dataUrl: '', width: 900, height: 640 };

test('every preset names adapters that exist', () => {
  for (const preset of PRESETS) {
    assert.ok(OCR_ADAPTERS[preset.reader.adapter], `${preset.id} reader`);
    assert.ok(TRANSLATE_ADAPTERS[preset.translator.adapter], `${preset.id} translator`);
  }
});

test('a hosted preset never pairs a local-only adapter with a hosted endpoint', () => {
  for (const preset of PRESETS) {
    if (preset.reader.baseUrl.includes('127.0.0.1')) continue;
    assert.equal(TRANSLATE_ADAPTERS[preset.translator.adapter].capabilities.localOnly, false,
      `${preset.id} would never work`);
  }
});

test('the shipped defaults are the local preset, so the picker opens on it', () => {
  assert.equal(matching(PRIVATE_DEFAULTS.reader, PRIVATE_DEFAULTS.translator), 'llamacpp');
  assert.equal(presetFor('llamacpp')?.reader.model, '');
  assert.equal(matching({ ...PRIVATE_DEFAULTS.reader, model: 'something' },
    PRIVATE_DEFAULTS.translator), '', 'an edited endpoint is no longer a preset');
});

// Gemini answers [ymin, xmin, ymax, xmax] however the prompt asks, and read the
// other way round its boxes are not merely wrong but nonsense.
test('the two orderings read the same reply differently, on purpose', () => {
  const reply = '[{"box_2d": [874, 66, 899, 190], "text": "© 2024 example"}]';
  assert.deepEqual(jsonBoxesYx.parse(reply, image), [
    { text: '© 2024 example', box: [59, 559, 171, 575] },
  ], 'which is where that line actually is');
  assert.deepEqual(jsonBoxes.parse(reply, image), [
    { text: '© 2024 example', box: [787, 42, 809, 122] },
  ]);
});
