import { test } from 'node:test';
import assert from 'node:assert';

import { send } from '../src/backends/client.ts';
import { ppOcrBrowser } from '../src/backends/ocr/ppocr/adapter.ts';
import { readsInBrowser } from '../src/backends/client.ts';
import { chatLines } from '../src/backends/translate/chat-lines.ts';
import { chromeTranslator } from '../src/backends/translate/chrome.ts';
import { hunyuanMt } from '../src/backends/translate/hunyuan-mt.ts';
import { translateGemma } from '../src/backends/translate/gemma.ts';
import { type EncodedImage } from '../src/backends/types.ts';

const image: EncodedImage = { dataUrl: 'data:image/png;base64,dGVzdA==', width: 800, height: 400 };

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
    (await send({ baseUrl: 'http://host/' }, chatLines.build(['x'], 'Chinese', 'English'), 'tr')).text,
    'read');
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
  await assert.rejects(
    send({ baseUrl: 'http://host' }, chatLines.build(['x'], 'Chinese', 'English'), 'the translator'),
    /the translator answered 503/);

  globalThis.fetch = (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch;
  await assert.rejects(
    send({ baseUrl: 'http://host' }, chatLines.build(['x'], 'Chinese', 'English'), 'the translator'),
    /cannot reach the translator at http:\/\/host\/v1\/chat\/completions/);
});

test('a base written either way round reaches the same place', async () => {
  const seen: string[] = [];
  globalThis.fetch = (async (url: string) => {
    seen.push(url);
    return { ok: true, json: async () => ({ choices: [{ message: { content: '' } }] }) };
  }) as unknown as typeof fetch;
  for (const baseUrl of ['http://127.0.0.1:8090', 'http://127.0.0.1:8090/v1',
                         'http://127.0.0.1:8090/v1/']) {
    await send({ baseUrl }, chatLines.build(['x'], 'Chinese', 'English'), 'tr');
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

test('giving up is not reported as the endpoint failing', async () => {
  const controller = new AbortController();
  globalThis.fetch = ((_url: string, init: any) => new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(new Error('aborted')));
  })) as unknown as typeof fetch;

  const job = send({ baseUrl: 'http://host' }, chatLines.build(['x'], 'Chinese', 'English'), 'tr',
    controller.signal);
  controller.abort();
  await assert.rejects(job, (e: Error) => e.name === 'Cancelled');
});

test('a reply with no content at all is an empty string, not a crash', async () => {
  const reply = (body: unknown) => (async () => ({ ok: true, json: async () => body }));
  for (const body of [{ choices: [{ message: { content: null } }] }, { choices: [] }, {}]) {
    globalThis.fetch = reply(body) as unknown as typeof fetch;
    assert.equal(
      (await send({ baseUrl: 'http://host' }, chatLines.build(['x'], 'Chinese', 'English'), 'tr'))
        .text, '');
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

test('a reader in this browser is asked without a socket, and answers with lines', async () => {
  const asked: any[] = [];
  globalThis.fetch = (async () => { throw new Error('nothing should go out'); }) as typeof fetch;
  readsInBrowser(async (body) => {
    asked.push(body);
    return {
      lines: [
        { text: ' 全场包邮 ', score: 0.97, quad: [[10, 8], [90, 5], [91, 30], [11, 33]] },
        { text: 'blur', score: 0.2, quad: [[0, 0], [9, 0], [9, 9], [0, 9]] },
      ],
      timings: { wall_ms: 40, det_ms: 12, rec_ms: 25 },
    };
  });

  const reply = await send({ baseUrl: '' }, ppOcrBrowser.build(image), 'the reader');
  assert.equal(asked[0].image, image.dataUrl, 'the image is handed over, not posted');

  assert.deepEqual(ppOcrBrowser.parse(reply.text, image),
    [{ text: '全场包邮', box: [10, 5, 91, 33] }],
    'the quad becomes the box that holds it, and a guess below MIN_SCORE is dropped');
});

test('the browser reader brings in its Korean recogniser unless the page is known not to be Korean', () => {
  const script = (source?: string) => ppOcrBrowser.build(image, source).body.script;
  assert.equal(script('Korean'), 'korean');
  assert.equal(script('Auto'), 'compare');
  assert.equal(script(), 'compare');
  assert.equal(script('Japanese'), 'general');
});

test('a reader that cannot run here says so rather than posting somewhere', async () => {
  readsInBrowser(null);
  await assert.rejects(send({ baseUrl: '' }, ppOcrBrowser.build(image), 'the reader'),
    /the reader cannot run here/);
});

test('a reader that answers nothing usable is no lines rather than a throw', () => {
  assert.deepEqual(ppOcrBrowser.parse('not json at all', image), []);
  assert.deepEqual(ppOcrBrowser.parse('[{"text":"x","score":0.9,"quad":[[0,0],[1,1]]}]', image), [],
    'a quad that is not four corners is not a box');
});

test('Chrome\'s translator is handed language codes and the lines, in this browser', async () => {
  const asked: any[] = [];
  readsInBrowser(async (body) => {
    asked.push(body);
    return { lines: ['Free shipping', null] };
  });
  const request = chromeTranslator.build(['全场包邮', '？'], 'Chinese', 'English');
  const reply = await send({ baseUrl: '' }, request, 'the translator');
  assert.deepEqual(asked[0], { type: 'translate', texts: ['全场包邮', '？'], from: 'zh',
    to: 'en' });
  assert.deepEqual(chromeTranslator.parse(reply.text, 2), ['Free shipping', null],
    'a line it could not translate is asked for again, not left blank');
  assert.equal(chromeTranslator.parse('["one"]', 2), null, 'a count that does not match is no answer');
  readsInBrowser(null);
});

const sse = (...events: unknown[]) =>
  events.map((e) => `data: ${typeof e === 'string' ? e : JSON.stringify(e)}\n\n`).join('');

/** A body that arrives in pieces cut at arbitrary places, as a network delivers it. */
function trickle(text: string, size = 7): Response {
  const bytes = new TextEncoder().encode(text);
  return new Response(new ReadableStream({
    start(c) {
      for (let i = 0; i < bytes.length; i += size) c.enqueue(bytes.slice(i, i + size));
      c.close();
    },
  }));
}

test('with a listener the reply is streamed, and reported as it grows', async () => {
  let body: any;
  globalThis.fetch = (async (_url: string, init: any) => {
    body = JSON.parse(init.body);
    return trickle(sse(
      { choices: [{ delta: { reasoning_content: 'hmm' } }] },
      { choices: [{ delta: { content: '[{"i": 1, "text": "Free' } }] },
      { choices: [{ delta: { content: ' shipping"}]' } }] },
      { choices: [], usage: { completion_tokens: 9 } },
      '[DONE]'));
  }) as typeof fetch;

  const seen: [string, number][] = [];
  const reply = await send({ baseUrl: 'http://host' }, chatLines.build(['全场包邮'], 'Chinese', 'English'),
    'the translator', undefined, (s) => seen.push([s.text, s.tokens]));
  assert.equal(body.stream, true);
  assert.deepEqual(body.stream_options, { include_usage: true });
  assert.deepEqual(chatLines.parse(reply.text, 1), ['Free shipping']);
  assert.deepEqual(seen.map(([, n]) => n), [1, 2, 3], 'the thinking counts as a sign of life');
  assert.equal(seen[0][0], '', 'but is not part of the text');
  assert.equal(reply.stats.tokens, 9, 'the server’s own count wins over ours');
  assert.equal(typeof reply.stats.ttft_ms, 'number');
});

test('llama.cpp’s raw completion streams too, and times itself at the end', async () => {
  globalThis.fetch = (async () => trickle(sse(
    { content: 'Free ', stop: false },
    { content: 'shipping', stop: false },
    { content: '', stop: true, timings: { prompt_ms: 40, predicted_ms: 100, predicted_n: 2 } },
  ))) as unknown as typeof fetch;
  const reply = await send({ baseUrl: 'http://host' }, translateGemma.build(['包邮'], 'Chinese', 'English'),
    'the translator', undefined, () => {});
  assert.equal(reply.text, 'Free shipping');
  assert.deepEqual(reply.stats, { wall_ms: reply.stats.wall_ms, ttft_ms: 40, tokens: 2, gen_ms: 100 });
});

test('an error sent inside the stream fails the call', async () => {
  globalThis.fetch = (async () => trickle(sse({ error: { message: 'context too long' } }))) as
    unknown as typeof fetch;
  await assert.rejects(send({ baseUrl: 'http://host' }, chatLines.build(['x'], 'Chinese', 'English'),
    'the translator', undefined, () => {}), /context too long/);
});

test('each adapter can tell how many lines of a half-arrived reply are whole', () => {
  assert.equal(chatLines.finished!('[{"i": 1, "text": "Free \\"ship\\""}, {"i": 2, "text": "SF'), 1);
  assert.equal(chatLines.finished!('<think>{"i": 1, "text": "draft"}'), 0,
    'a draft in the thinking is not a line');
  assert.equal(chatLines.finished!('<think>x</think>[{"i": 1, "text": "a"}'), 1);
  assert.equal(hunyuanMt.finished!('1. Free shipping\n2. SF Ex'), 1,
    'the last line is not whole until its newline');
  assert.equal(translateGemma.finished!('\nFree shipping\nSF Ex'), 1);
});

test('a half-arrived reply hands over its whole lines in their places', () => {
  assert.deepEqual(chatLines.partial!('[{"i": 2, "text": "SF"}, {"i": 1, "text": "Fr', 3),
    [null, 'SF', null]);
  assert.deepEqual(chatLines.partial!('<think>[{"i": 1, "text": "draft"}]', 2), [null, null],
    'a draft in the thinking is not a line');
  assert.deepEqual(hunyuanMt.partial!('2. SF Express\n1. Free ship', 2), [null, 'SF Express']);
  assert.equal(translateGemma.partial, undefined,
    'a line placed by position alone is not placed until the count is in');
});
