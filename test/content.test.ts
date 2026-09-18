import { test } from 'node:test';
import assert from 'node:assert';
import { JSDOM } from 'jsdom';

import { BadgeLayer } from '../src/content/badges.ts';
import { ResultCache } from '../src/content/cache.ts';
import { restore, show } from '../src/content/swap.ts';

const any = globalThis as any;

/** The content modules reach for page globals, which node does not have. */
function adopt(dom: JSDOM): void {
  const w = dom.window as any;
  for (const name of ['document', 'Node', 'MutationObserver', 'HTMLElement', 'URL']) {
    any[name] = w[name];
  }
  any.addEventListener = w.addEventListener.bind(w);
  any.removeEventListener = w.removeEventListener.bind(w);
}

test('only X photo backgrounds follow the translated img', () => {
  for (const { hostname, container } of [
    { hostname: 'x.com', container: 'data-testid="tweetPhoto"' },
    { hostname: 'mobile.twitter.com', container: 'data-testid="tweetPhoto"' },
    { hostname: 'x.com', container: 'aria-label="Image"' },
    { hostname: 'example.com', container: 'aria-label="Image"' },
  ]) {
    const original = 'https://pbs.twimg.com/media/photo?format=jpg&name=medium';
    const translated = 'data:image/png;base64,dGVzdA==';
    const dom = new JSDOM(`<div ${container}>
      <div style='filter: brightness(1); background-image: url("${original}") !important'></div>
      <img src="${original}" style="opacity: 0">
    </div>`, { url: `https://${hostname}` });
    adopt(dom);

    const img = dom.window.document.querySelector('img')!;
    const background = img.previousElementSibling as HTMLElement;
    const before = background.style.backgroundImage;
    for (let toggle = 0; toggle < 2; toggle++) {
      show(img, translated);
      assert.equal(img.src, translated);
      assert.equal(background.style.backgroundImage,
        hostname === 'example.com' ? before : `url("${translated}")`);
      assert.equal(background.style.filter, 'brightness(1)');
      restore(img);
      assert.equal(img.src, original);
      assert.equal(background.style.backgroundImage, before);
      assert.equal(background.style.getPropertyPriority('background-image'), 'important');
    }
    dom.window.close();
  }
});

test('a carousel slide gets a badge when it becomes visible', () => {
  const dom = new JSDOM('<img id="visible"><img id="hidden">', { url: 'https://example.com' });
  adopt(dom);
  const observedSizes = new Set<Element>();
  let resize: (entries: { target: Element }[]) => void = () => {};
  any.IntersectionObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  any.ResizeObserver = class {
    constructor(callback: typeof resize) { resize = callback; }
    observe(img: Element) { observedSizes.add(img); }
    unobserve(img: Element) { observedSizes.delete(img); }
    disconnect() { observedSizes.clear(); }
  };

  const doc = dom.window.document;
  const visible = doc.querySelector('#visible') as HTMLImageElement;
  const hidden = doc.querySelector('#hidden') as HTMLImageElement;
  const seen = () => ({ width: 200, height: 120, left: 0, top: 0 }) as DOMRect;
  const unseen = () => ({ width: 0, height: 0, left: 0, top: 0 }) as DOMRect;
  visible.getBoundingClientRect = seen;
  hidden.getBoundingClientRect = unseen;

  const layer = new BadgeLayer(() => {});
  layer.start();
  assert.equal(layer.controllers.size, 1, 'only the visible slide starts attached');
  assert.ok(observedSizes.has(hidden), 'hidden carousel slides remain observed');

  hidden.getBoundingClientRect = seen;
  resize([{ target: hidden }]);
  assert.equal(layer.controllers.size, 2, 'a slide attaches when it becomes visible');
  layer.stop();
  dom.window.close();
});

test('the image result cache stays bounded and revokes what it drops', () => {
  const dom = new JSDOM('', { url: 'https://x.com' });
  adopt(dom);
  const revoked: string[] = [];
  let serial = 0;
  any.URL = { createObjectURL: () => `blob:test-${++serial}`,
              revokeObjectURL: (url: string) => revoked.push(url) };

  const cache = new ResultCache();
  for (let i = 0; i <= 12; i++) {
    cache.set(`image-${i}`, { ok: true, image: 'data:image/png;base64,dGVzdA==',
                              blocks: [], timings: {} });
  }
  assert.equal(cache.size, 12);
  assert.equal(cache.get('image-0'), null, 'oldest image result is evicted');
  const last = cache.get('image-12');
  assert.equal(last?.ok && last.image, 'blob:test-13', 'cached result uses a blob URL');
  assert.deepEqual(revoked, ['blob:test-1'], 'evicted blob URL is revoked');
  dom.window.close();
});

test('a badge keeps out of the way until the modifier is held', () => {
  const dom = new JSDOM('<img id="pic">', { url: 'https://example.com' });
  adopt(dom);
  any.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
  any.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };

  const doc = dom.window.document;
  const img = doc.querySelector('#pic') as HTMLImageElement;
  img.getBoundingClientRect = () => ({ width: 200, height: 120, left: 0, top: 0 }) as DOMRect;

  const layer = new BadgeLayer(() => {});
  layer.start();
  const badge = () => layer.controllers.get(img)!.badge;
  const key = (type: string, metaKey: boolean) =>
    dom.window.dispatchEvent(new dom.window.KeyboardEvent(type, { metaKey, key: 'Meta' }));

  assert.equal(badge().style.display, 'none', 'hidden until asked for');
  key('keydown', true);
  assert.equal(badge().style.display, '', 'the modifier brings it out');
  key('keyup', false);
  assert.equal(badge().style.display, 'none');

  // Once an image has been acted on, its badge is the way back.
  layer.setStatus(img, 'shown', 'Show the original image');
  assert.equal(badge().style.display, '', 'a translated image keeps its badge');
  layer.setStatus(img, 'idle', 'Translate the text in this image');
  assert.equal(badge().style.display, 'none', 'and gives it up again when it is idle');

  key('keydown', true);
  dom.window.dispatchEvent(new dom.window.Event('blur'));
  assert.equal(badge().style.display, 'none', 'cmd-tabbing away puts it back');

  layer.stop();
  dom.window.close();
});
