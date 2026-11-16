import { test } from 'node:test';
import assert from 'node:assert';

import { search } from '../src/ui/search.ts';

const values = (names: string[]) => names.map((value) => ({ value }));

test('search puts a prefix before a word start before a substring', () => {
  const options = values(['Ukrainian', 'gemma-3-it', 'Italian', 'qwen/it-mini']);
  assert.deepStrictEqual(search(options, 'it').map((o) => o.value),
    ['Italian', 'gemma-3-it', 'qwen/it-mini']);
  assert.deepStrictEqual(search(options, 'AN').map((o) => o.value), ['Ukrainian', 'Italian']);
});

test('search matches the label as well as the value, and keeps everything on empty', () => {
  const options = [{ value: 'gpt-oss-20b', label: 'OpenAI: gpt-oss' }, { value: 'qwen3' }];
  assert.deepStrictEqual(search(options, 'openai').map((o) => o.value), ['gpt-oss-20b']);
  assert.strictEqual(search(options, '  ').length, 2);
});
