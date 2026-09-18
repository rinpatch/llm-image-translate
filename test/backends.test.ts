import { test } from 'node:test';
import assert from 'node:assert';

import { send } from '../src/backends/client.ts';
import { hunyuanSpotting } from '../src/backends/ocr/hunyuan.ts';
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
  assert.equal(await send({ baseUrl: 'http://host/' }, hunyuanSpotting.build(image), 'reader'),
    'read');
  assert.equal(calls[0].url, 'http://host/v1/chat/completions', 'trailing slash does not double');
  assert.equal(calls[0].init.headers.Authorization, undefined, 'no key, no header');
  assert.equal(JSON.parse(calls[0].init.body).model, undefined, 'no model unless one is named');

  globalThis.fetch = reply({ content: 'written' }) as typeof fetch;
  const endpoint = { baseUrl: 'https://openrouter.ai/api/v1', apiKey: 'sk-x', model: 'qwen' };
  assert.equal(await send(endpoint, translateGemma.build(['x'], 'Chinese', 'English'), 'tr'),
    'written');
  assert.equal(calls[1].url, 'https://openrouter.ai/api/v1/completion');
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
