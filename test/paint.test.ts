import { test } from 'node:test';
import assert from 'node:assert';

import { columnar, drawBlock, units, wrap, type TextCanvas } from '../src/core/paint.ts';

// Full-width characters a font size wide, ASCII half that, and every glyph
// drawn recorded with where it went.
function canvas() {
  const drawn: { text: string; x: number; y: number; turned: boolean }[] = [];
  let turned = false;
  const ctx = {
    font: '10px sans-serif', textBaseline: 'top', lineWidth: 1,
    strokeStyle: '', fillStyle: '',
    measureText(text: string) {
      const size = parseInt(ctx.font, 10);
      return { width: [...text].reduce((n, c) => n + (c.charCodeAt(0) < 0x80 ? size / 2 : size), 0) };
    },
    fillRect() {}, strokeText() {},
    fillText(text: string, x: number, y: number) { drawn.push({ text, x, y, turned }); },
    save() {}, restore() { turned = false; }, translate() {},
    rotate() { turned = true; },
  };
  return { ctx: ctx as unknown as TextCanvas, drawn };
}

test('Chinese breaks between any two characters, not only at spaces', () => {
  const { ctx } = canvas();
  ctx.font = '10px x';
  assert.deepEqual(wrap(ctx, '我们今天去学校', 30), ['我们今', '天去学', '校']);
});

test('a closing mark never starts a line and an opening one never ends it', () => {
  assert.deepEqual(units('他说：「好。」'), ['他', '说：', '「好。」']);
  const { ctx } = canvas();
  ctx.font = '10px x';
  assert.ok(wrap(ctx, '你好，世界！', 20).every((l) => !/^[，！]/.test(l)));
});

test('Latin inside Chinese keeps its words whole and its spaces', () => {
  const { ctx } = canvas();
  ctx.font = '10px x';
  assert.deepEqual(wrap(ctx, 'hello world', 1000), ['hello world']);
  assert.deepEqual(units('用 Chrome 打开'), ['用', 'Chrome', '打', '开']);
});

test('only text that is mostly Han or kana goes in columns', () => {
  assert.ok(columnar('你好，世界！'));
  assert.ok(columnar('すごいね'));
  assert.ok(!columnar('Hello, world!'));
  assert.ok(!columnar('안녕하세요'), 'Korean comics are lettered across');
});

test('a vertical block is set in columns, right to left, top to bottom', () => {
  const { ctx, drawn } = canvas();
  drawBlock(ctx, [0, 0, 40, 100], '我们今天去学校吧', { ink: '#000', outline: null, align: 'center', vertical: true });
  const xs = [...new Set(drawn.map((d) => Math.round(d.x)))];
  assert.ok(xs.length >= 2, 'more than one column');
  const first = drawn.filter((d) => Math.round(d.x) === Math.max(...xs));
  assert.equal(first[0].text, '我', 'the first character heads the rightmost column');
  assert.ok(first.every((d, i) => i === 0 || d.y > first[i - 1].y), 'and the column runs down');
});

test('in a column the marks turn upright and a long Latin run lies on its side', () => {
  const { ctx, drawn } = canvas();
  drawBlock(ctx, [0, 0, 30, 300], '他用Chrome，「好」', { ink: '#000', outline: null, align: 'center', vertical: true });
  const texts = drawn.map((d) => d.text);
  assert.ok(texts.includes('︐') && texts.includes('﹁') && texts.includes('﹂'));
  assert.ok(drawn.find((d) => d.text === 'Chrome')?.turned);
});

test('a vertical block translated into English is still set across', () => {
  const { ctx, drawn } = canvas();
  drawBlock(ctx, [0, 0, 40, 100], 'Let us go', { ink: '#000', outline: null, align: 'center', vertical: true });
  assert.deepEqual(drawn.map((d) => d.text), ['Let', 'us', 'go']);
});
