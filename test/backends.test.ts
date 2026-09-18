import { test } from 'node:test';
import assert from 'node:assert';

import { send } from '../src/backends/client.ts';
import { hunyuanSpotting } from '../src/backends/ocr/hunyuan.ts';
import { jsonBoxes } from '../src/backends/ocr/json-boxes.ts';
import { chatLines } from '../src/backends/translate/chat-lines.ts';
import { hunyuanMt } from '../src/backends/translate/hunyuan-mt.ts';
import { translateGemma } from '../src/backends/translate/gemma.ts';
import { type EncodedImage } from '../src/backends/types.ts';

const image: EncodedImage = { dataUrl: 'data:image/png;base64,dGVzdA==', width: 800, height: 400 };

test('the reader is asked for spotting, with the image first', () => {
  const request = hunyuanSpotting.build(image);
  assert.equal(request.kind, 'chat');
  const content = (request.body.messages as any[])[0].content;
  assert.equal(content[0].image_url.url, image.dataUrl);
  assert.match(content[1].text, /检测并识别/);
  assert.equal(request.body.temperature, 0);
});

test('text and its corners run together, one spot after another', () => {
  const reply = '22:06(69,22),(169,39)発消息或按住説話(153,701),(839,735)'
    + '深度思考(92,779),(647,812)';
  const spots = hunyuanSpotting.parse(reply, { ...image, width: 1000, height: 1000 });
  assert.equal(spots.length, 3);
  assert.deepEqual(spots[0], { text: '22:06', box: [69, 22, 169, 39] });
  assert.equal(spots[1].text, '発消息或按住説話');
});

test('spot coordinates are scaled off 1000 onto the raster', () => {
  const lines = hunyuanSpotting.parse('包邮(100,250),(500,500)', image);
  assert.deepEqual(lines, [{ text: '包邮', box: [80, 100, 400, 200] }]);
});

test('the translator prompt names both languages and their codes', () => {
  const request = translateGemma.build(['包邮', '顺丰发货'], 'Chinese', 'English');
  assert.equal(request.kind, 'completion');
  const prompt = request.body.prompt as string;
  assert.match(prompt, /Chinese \(zh\) to English \(en\)/);
  assert.match(prompt, /包邮\n顺丰发货/, 'the batch goes over as one block of lines');
  assert.equal(request.body.n_predict, 1024);
  assert.equal(translateGemma.build(['包邮'], 'Chinese', 'English', 256).body.n_predict, 256);
});

test('a reply is only trusted when its line count matches the batch', () => {
  assert.deepEqual(translateGemma.parse('Free shipping\n SF Express ', 2),
    ['Free shipping', 'SF Express']);
  assert.equal(translateGemma.parse('Free shipping, shipped via SF Express', 2), null,
    'two lines in, one out, so there is no telling which merged');
  assert.deepEqual(translateGemma.parse('Free shipping\nvia SF Express', 1),
    ['Free shipping\nvia SF Express'], 'one line in, whatever came back is the answer');
});

test('the client addresses the endpoint and unwraps whichever reply shape', async () => {
  const calls: { url: string; init: any }[] = [];
  const reply = (body: unknown) => async (url: string, init: any) => {
    calls.push({ url, init });
    return { ok: true, json: async () => body } as unknown as Response;
  };

  globalThis.fetch = reply({ choices: [{ message: { content: 'read' } }] }) as typeof fetch;
  assert.equal(
    (await send({ baseUrl: 'http://host/' }, hunyuanSpotting.build(image), 'reader')).text, 'read');
  assert.equal(calls[0].url, 'http://host/v1/chat/completions', 'trailing slash does not double');
  assert.equal(calls[0].init.headers.Authorization, undefined, 'no key, no header');
  assert.equal(JSON.parse(calls[0].init.body).model, undefined, 'no model unless one is named');

  globalThis.fetch = reply({ content: 'written' }) as typeof fetch;
  const endpoint = { baseUrl: 'https://openrouter.ai/api/v1', apiKey: 'sk-x', model: 'qwen' };
  assert.equal(
    (await send(endpoint, translateGemma.build(['x'], 'Chinese', 'English'), 'tr')).text,
    'written');
  assert.equal(calls[1].url, 'https://openrouter.ai/api/completion',
    'the version segment is not doubled onto a base that already has one');
  assert.equal(calls[1].init.headers.Authorization, 'Bearer sk-x');
  assert.equal(JSON.parse(calls[1].init.body).model, 'qwen');
});

test('a server that answers badly says so, in terms of what it was asked to be', async () => {
  globalThis.fetch = (async () => ({ ok: false, status: 503 })) as unknown as typeof fetch;
  await assert.rejects(send({ baseUrl: 'http://host' }, hunyuanSpotting.build(image), 'the reader'),
    /the reader answered 503/);

  globalThis.fetch = (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch;
  await assert.rejects(send({ baseUrl: 'http://host' }, hunyuanSpotting.build(image), 'the reader'),
    /cannot reach the reader at http:\/\/host\/v1\/chat\/completions/);
});

test('a base written either way round reaches the same place', async () => {
  const seen: string[] = [];
  globalThis.fetch = (async (url: string) => {
    seen.push(url);
    return { ok: true, json: async () => ({ choices: [{ message: { content: '' } }] }) };
  }) as unknown as typeof fetch;
  for (const baseUrl of ['http://127.0.0.1:8090', 'http://127.0.0.1:8090/v1',
                         'http://127.0.0.1:8090/v1/']) {
    await send({ baseUrl }, hunyuanSpotting.build(image), 'reader');
  }
  assert.deepEqual(new Set(seen), new Set(['http://127.0.0.1:8090/v1/chat/completions']));
});

test('a numbered reply is put back in order, whatever it is wrapped in', () => {
  const reply = 'Sure!\n```json\n[{"i": 2, "text": "SF Express"}, {"i": 1, "text": "Free"}]\n```';
  assert.deepEqual(chatLines.parse(reply, 2), ['Free', 'SF Express']);
});

test('a line the model dropped is the only one lost', () => {
  assert.deepEqual(chatLines.parse('[{"i":1,"text":"Free"},{"i":3,"text":"Third"}]', 3),
    ['Free', null, 'Third'], 'the gap is reported rather than shifting the rest up');
  assert.equal(chatLines.parse('I cannot read that image', 2), null,
    'nothing usable at all means ask again line by line');
  assert.equal(chatLines.parse('[{"i":9,"text":"nope"}]', 2), null,
    'numbers that fit no line are not this protocol');
});

test('the numbered prompt keeps one line per line', () => {
  const body = chatLines.build(['包邮\n顺丰', 'x'], 'Chinese', 'English').body as any;
  assert.match(body.messages[1].content, /1\. 包邮 顺丰\n2\. x/,
    'a newline inside a line would be read back as a second line');
});

test('a 0-1000 grid is scaled onto the image, and junk is dropped', () => {
  const lines = jsonBoxes.parse(
    '[{"text":"ok","box":[125,250,500,750]},'
    + '{"text":"backwards","box":[500,750,125,250]},'
    + '{"text":"flat","box":[10,10,10,40]},'
    + '{"text":"junk","box":[1,2]},'
    + '{"text":"  ","box":[1,2,3,4]}]', image);
  assert.deepEqual(lines, [
    { text: 'ok', box: [100, 100, 400, 300] },
    { text: 'backwards', box: [100, 100, 400, 300] },
  ], 'a zero-width box, a malformed box and an empty string are all dropped');
});

// Qwen3-VL answers on the grid whatever the prompt says; something else may not.
test('a reply in pixels is taken as pixels, since the grid cannot exceed 1000', () => {
  const lines = jsonBoxes.parse(
    '[{"text":"a","box":[10,20,100,60]},{"text":"b","box":[200,100,1400,900]}]', image);
  assert.deepEqual(lines, [
    { text: 'a', box: [10, 20, 100, 60] },
    { text: 'b', box: [200, 100, 800, 400] },
  ], 'and the one that runs off the edge is clamped to it');
});

test('a model that wraps its array in an object is still understood', () => {
  const lines = jsonBoxes.parse('{"lines": [{"text":"ok","box":[1,2,3,4]}]}', image);
  assert.equal(lines.length, 1);
  assert.deepEqual(jsonBoxes.parse('no text found here', image), []);
});

test('giving up is not reported as the endpoint failing', async () => {
  const controller = new AbortController();
  globalThis.fetch = ((_url: string, init: any) => new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(new Error('aborted')));
  })) as unknown as typeof fetch;

  const job = send({ baseUrl: 'http://host' }, hunyuanSpotting.build(image), 'the reader',
    controller.signal);
  controller.abort();
  await assert.rejects(job, (e: Error) => e.name === 'Cancelled');
});

test('a reply with no content at all is an empty string, not a crash', async () => {
  const reply = (body: unknown) => (async () => ({ ok: true, json: async () => body }));
  for (const body of [{ choices: [{ message: { content: null } }] }, { choices: [] }, {}]) {
    globalThis.fetch = reply(body) as unknown as typeof fetch;
    assert.equal(
      (await send({ baseUrl: 'http://host' }, hunyuanSpotting.build(image), 'reader')).text, '');
  }
});

test('a translation model gets one instruction and numbered lines', () => {
  const body = hunyuanMt.build(['包邮\n顺丰', 'x'], 'Chinese', 'English').body as any;
  assert.equal(body.messages.length, 1, 'no system message: it would be translated too');
  assert.match(body.messages[0].content, /into English/);
  assert.match(body.messages[0].content, /1\. 包邮 顺丰\n2\. x/);
});

test('numbered lines come back by number, and a gap stays a gap', () => {
  assert.deepEqual(hunyuanMt.parse('1. Free shipping\n2. SF Express', 2),
    ['Free shipping', 'SF Express']);
  assert.deepEqual(hunyuanMt.parse('2) Only the second', 2), [null, 'Only the second']);
  assert.deepEqual(hunyuanMt.parse('Here you go:\n1. First\nand that is all', 1), ['First'],
    'prose around the lines is ignored');
  assert.deepEqual(hunyuanMt.parse('Limited-time discount', 1), ['Limited-time discount'],
    'one line in, an unnumbered answer is still the answer');
  assert.equal(hunyuanMt.parse('I cannot do that', 3), null);
});
