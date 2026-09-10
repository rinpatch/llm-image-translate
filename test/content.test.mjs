import { JSDOM } from 'jsdom';
import { readFileSync } from 'fs';
import assert from 'assert';

const html = `<body>
  <h1>  Hello world  </h1>
  <p>Hello world</p>
  <p>Some <b>bold</b> text</p>
  <script>var x = "do not touch";</script>
  <pre>keep me</pre>
  <div translate="no">skip me</div>
  <input placeholder="Search here">
  <img alt="A cat" src="x">
  <span>42</span>
</body>`;

const dom = new JSDOM(html, { runScripts: 'outside-only' });
const w = dom.window;
const listeners = [];
let lastRequest = null;

w.chrome = {
  runtime: {
    onMessage: { addListener: (fn) => listeners.push(fn) },
    sendMessage: async (msg) => {
      if (msg.type === 'settings') return { source: 'auto', target: 'xx', auto: false };
      lastRequest = msg;
      return { ok: true, source: 'en', translations: msg.texts.map((t) => `[${t}]`) };
    }
  }
};
w.eval(readFileSync('extension/content.js', 'utf8'));

const send = (msg) => new Promise((res) => listeners[0](msg, null, res));
const text = (sel) => w.document.querySelector(sel).textContent;
const attr = (sel, a) => w.document.querySelector(sel).getAttribute(a);

const run = await send({ type: 'run', source: 'auto', target: 'xx' });
assert.ok(run.ok, 'run failed');

assert.equal(text('h1'), '  [Hello world]  ', 'whitespace not preserved: ' + JSON.stringify(text('h1')));
assert.equal(text('p'), '[Hello world]');
assert.equal(text('p:nth-of-type(2)'), '[Some] [bold] [text]');
assert.equal(text('script'), 'var x = "do not touch";');
assert.equal(text('pre'), 'keep me');
assert.equal(text('div'), 'skip me');
assert.equal(attr('input', 'placeholder'), '[Search here]');
assert.equal(attr('img', 'alt'), '[A cat]');
assert.equal(text('span'), '42', 'digit-only node should be skipped');
assert.equal(new Set(lastRequest.texts).size, lastRequest.texts.length, 'duplicates not deduped');
assert.ok(!lastRequest.texts.includes('Hello world  '), 'untrimmed text sent');

// A second run must not re-translate what is already translated.
const before = w.document.body.innerHTML;
await send({ type: 'run', source: 'auto', target: 'xx' });
assert.equal(w.document.body.innerHTML, before, 'second run double-translated');

// New content arriving after the fact gets picked up by the observer.
w.document.body.insertAdjacentHTML('beforeend', '<p id="late">Fresh content</p>');
await new Promise((r) => setTimeout(r, 900));
assert.equal(text('#late'), '[Fresh content]', 'mutation observer missed new node');

await send({ type: 'restore' });
assert.equal(text('h1'), '  Hello world  ', 'restore failed');
assert.equal(text('#late'), 'Fresh content', 'restore missed observed node');
assert.equal(attr('input', 'placeholder'), 'Search here');

console.log('all content-script assertions passed');
