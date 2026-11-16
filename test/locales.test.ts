import { test } from 'node:test';
import assert from 'node:assert';
import { readdirSync, readFileSync } from 'node:fs';

const root = new URL('../extension/_locales/', import.meta.url);
const load = (locale: string): Record<string, { message: string }> =>
  JSON.parse(readFileSync(new URL(`${locale}/messages.json`, root), 'utf8'));
const en = load('en');
const others = readdirSync(root).filter((locale) => locale !== 'en');

// Plural forms differ by language, so they are compared by the base before `_`.
const base = (key: string) => key.replace(/_(zero|one|two|few|many|other)$/, '');
const slots = (message: string) => [...new Set(message.match(/\$[1-9]/g))].sort().join();

test('every locale says everything English does', () => {
  const wanted = new Set(Object.keys(en).map(base));
  for (const locale of others) {
    const has = new Set(Object.keys(load(locale)).map(base));
    assert.deepEqual([...wanted].filter((k) => !has.has(k)), [], `${locale} is missing these`);
    assert.deepEqual([...has].filter((k) => !wanted.has(k)), [], `${locale} has these English lacks`);
  }
});

test('a plural has its other form everywhere, since that is what tn falls back to', () => {
  for (const locale of ['en', ...others]) {
    const messages = load(locale);
    for (const key of Object.keys(messages).filter((k) => k !== base(k))) {
      assert.ok(messages[`${base(key)}_other`], `${locale}: ${base(key)}_other`);
    }
  }
});

test('a translation fills the same slots as the English', () => {
  const slotsOf = (messages: Record<string, { message: string }>, key: string) =>
    Object.entries(messages).filter(([k]) => base(k) === key).map(([, m]) => slots(m.message));
  for (const locale of others) {
    const messages = load(locale);
    for (const key of new Set(Object.keys(en).map(base))) {
      const want = new Set(slotsOf(en, key));
      for (const got of slotsOf(messages, key)) {
        assert.ok(want.has(got), `${locale}: ${key} fills ${got || 'nothing'}, English ${[...want]}`);
      }
    }
  }
});
