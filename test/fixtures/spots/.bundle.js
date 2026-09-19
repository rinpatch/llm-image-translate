"use strict";
var Dump = (() => {
  var __defProp = Object.defineProperty;
  var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  var __export = (target, all) => {
    for (var name in all)
      __defProp(target, name, { get: all[name], enumerable: true });
  };
  var __copyProps = (to, from, except, desc) => {
    if (from && typeof from === "object" || typeof from === "function") {
      for (let key of __getOwnPropNames(from))
        if (!__hasOwnProp.call(to, key) && key !== except)
          __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
    }
    return to;
  };
  var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

  // tools/dump-spots.ts
  var dump_spots_exports = {};
  __export(dump_spots_exports, {
    dump: () => dump
  });

  // src/core/geometry.ts
  var SEAM = 0.25;
  var seam = ([x0, y0, x1, y1], end) => {
    const take = Math.max(y1 - y0, Math.round((x1 - x0) * SEAM));
    return end === "head" ? [x0, y0, Math.min(x1, x0 + take), y1] : [Math.max(x0, x1 - take), y0, x1, y1];
  };
  var offset = (width, x, y) => (y * width + x) * 4;

  // src/backends/ocr/hunyuan.ts
  var SPOTTING = "\u68C0\u6D4B\u5E76\u8BC6\u522B\u56FE\u7247\u4E2D\u7684\u6587\u5B57\uFF0C\u5C06\u6587\u672C\u5750\u6807\u683C\u5F0F\u5316\u8F93\u51FA\u3002";
  var SPOT_RE = /(.+?)\((\d+),(\d+)\),\((\d+),(\d+)\)/gs;
  var MIN_CONFIDENCE_CHARS = 2;
  function parseSpots(reply, width, height) {
    const lines = [];
    for (const m of reply.matchAll(SPOT_RE)) {
      const text = m[1].trim();
      const [x0, y0, x1, y1] = [m[2], m[3], m[4], m[5]].map(Number);
      if (text.length >= MIN_CONFIDENCE_CHARS - 1 && x1 > x0 && y1 > y0) {
        const box = [
          Math.round(x0 / 1e3 * width),
          Math.round(y0 / 1e3 * height),
          Math.round(x1 / 1e3 * width),
          Math.round(y1 / 1e3 * height)
        ];
        lines.push({ text, box });
      }
    }
    return lines;
  }
  var hunyuanSpotting = {
    id: "hunyuan-spotting",
    label: "HunyuanOCR spotting",
    capabilities: {
      maxDim: 1600,
      encode: "png",
      // It can translate, but not from Chinese, which is why a second model exists.
      alsoTranslates: false
    },
    build(image) {
      return {
        kind: "chat",
        body: {
          messages: [{
            role: "user",
            content: [
              { type: "image_url", image_url: { url: image.dataUrl } },
              { type: "text", text: SPOTTING }
            ]
          }],
          temperature: 0,
          max_tokens: 2048
        }
      };
    },
    parse(content, image) {
      return parseSpots(content, image.width, image.height);
    }
  };

  // src/backends/client.ts
  var TIMEOUT_MS = 9e4;
  var Cancelled = class extends Error {
    constructor() {
      super("cancelled");
      this.name = "Cancelled";
    }
  };
  var serverRoot = (url) => url.replace(/\/+$/, "").replace(/\/v1$/, "");
  var apiRoot = (url) => `${serverRoot(url)}/v1`;
  var pathFor = (url, kind) => kind === "chat" ? `${apiRoot(url)}/chat/completions` : `${serverRoot(url)}/completion`;
  function headersFor(endpoint) {
    const headers = { ...endpoint.headers };
    if (endpoint.apiKey) headers.Authorization = `Bearer ${endpoint.apiKey}`;
    return headers;
  }
  async function post(endpoint, url, body, what, signal) {
    const headers = {
      "Content-Type": "application/json",
      ...headersFor(endpoint)
    };
    const deadline = AbortSignal.timeout(TIMEOUT_MS);
    const giveUp = signal ? AbortSignal.any([signal, deadline]) : deadline;
    let response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: giveUp
      });
    } catch {
      if (signal?.aborted) throw new Cancelled();
      if (deadline.aborted) throw new Error(`${what} did not answer within ${TIMEOUT_MS / 1e3}s`);
      throw new Error(`cannot reach ${what} at ${url}`);
    }
    if (!response.ok) throw new Error(`${what} answered ${response.status}`);
    return response.json();
  }
  function statsOf(out, wall_ms) {
    const stats = { wall_ms };
    const timings = out?.timings;
    if (Number.isFinite(timings?.prompt_ms)) stats.ttft_ms = Math.round(timings.prompt_ms);
    const tokens = Number(timings?.predicted_n ?? out?.usage?.completion_tokens);
    if (Number.isFinite(tokens) && tokens > 0) {
      stats.tokens = tokens;
      stats.gen_ms = Math.round(
        Number.isFinite(timings?.predicted_ms) ? timings.predicted_ms : wall_ms
      );
    }
    return stats;
  }
  async function send(endpoint, request, what, signal) {
    const body = endpoint.model ? { ...request.body, model: endpoint.model } : request.body;
    const started = Date.now();
    const out = await post(endpoint, pathFor(endpoint.baseUrl, request.kind), body, what, signal);
    const content = request.kind === "chat" ? out.choices?.[0]?.message?.content : out.content;
    return {
      text: typeof content === "string" ? content : "",
      stats: statsOf(out, Date.now() - started)
    };
  }

  // src/core/color.ts
  var luminance = (data, i) => 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
  var apart = (a, b) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);
  function inkOf(data, width, height, [x0, y0, x1, y1]) {
    const left = Math.max(0, x0);
    const top = Math.max(0, y0);
    const right = Math.min(width, x1);
    const bottom = Math.min(height, y1);
    const pixels = [];
    for (let y = top; y < bottom; y++) {
      for (let x = left; x < right; x++) pixels.push(offset(width, x, y));
    }
    if (!pixels.length) return [0, 0, 0];
    const paper = [...pixels].map((i) => luminance(data, i)).sort((a, b2) => a - b2)[pixels.length >> 1];
    pixels.sort((a, b2) => Math.abs(luminance(data, b2) - paper) - Math.abs(luminance(data, a) - paper));
    const taken = Math.max(4, Math.round(pixels.length / 50));
    let r = 0;
    let g = 0;
    let b = 0;
    for (let k = 0; k < taken; k++) {
      r += data[pixels[k]];
      g += data[pixels[k] + 1];
      b += data[pixels[k] + 2];
    }
    return [Math.round(r / taken), Math.round(g / taken), Math.round(b / taken)];
  }

  // src/core/rules.ts
  var MARGIN = 25;
  var COVERAGE = 0.6;
  var MIN_SPAN = 8;
  function ruledBetween(data, width, height, above, below) {
    const top = Math.max(0, above[3]);
    const bottom = Math.min(height, below[1]);
    if (bottom - top < 2) return false;
    const x0 = Math.max(0, above[0], below[0]);
    const x1 = Math.min(width, above[2], below[2]);
    if (x1 - x0 < MIN_SPAN) return false;
    const samples = [];
    for (let y = top; y < bottom; y++) {
      for (let x = x0; x < x1; x += 2) samples.push(luminance(data, offset(width, x, y)));
    }
    if (!samples.length) return false;
    samples.sort((a, b) => a - b);
    const paper = samples[samples.length >> 1];
    for (let y = top; y < bottom; y++) {
      let dark = 0;
      for (let x = x0; x < x1; x++) {
        if (luminance(data, offset(width, x, y)) < paper - MARGIN) dark++;
      }
      if (dark / (x1 - x0) >= COVERAGE) return true;
    }
    return false;
  }
  var RECOLOURED = 90;
  var RESTARTED = 180;
  function dividerFor(data, width, height) {
    const inks = /* @__PURE__ */ new Map();
    const ink = (box) => {
      const key = box.join(",");
      let found = inks.get(key);
      if (!found) inks.set(key, found = inkOf(data, width, height, box));
      return found;
    };
    return (above, below) => ruledBetween(data, width, height, above, below) || apart(ink(above), ink(below)) > RECOLOURED || apart(ink(seam(above, "tail")), ink(seam(below, "head"))) > RESTARTED;
  }

  // tools/dump-spots.ts
  var NEAR = 4;
  async function raster(url, maxDim) {
    const bitmap = await createImageBitmap(await (await fetch(url)).blob());
    const scale = Math.min(1, maxDim / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(bitmap, 0, 0, width, height);
    bitmap.close();
    const blob = await canvas.convertToBlob({ type: "image/png" });
    const dataUrl = await new Promise((done) => {
      const reader = new FileReader();
      reader.onload = () => done(reader.result);
      reader.readAsDataURL(blob);
    });
    return { data: ctx.getImageData(0, 0, width, height).data, width, height, dataUrl };
  }
  var near = (a, b) => {
    const span = Math.max(a[3] - a[1], b[3] - b[1], a[2] - a[0], b[2] - b[0]);
    const gapY = Math.max(b[1] - a[3], a[1] - b[3]);
    const gapX = Math.max(b[0] - a[2], a[0] - b[2]);
    return Math.max(gapX, gapY) <= span * NEAR;
  };
  async function dump(url, endpoint) {
    const { data, width, height, dataUrl } = await raster(
      url,
      hunyuanSpotting.capabilities.maxDim
    );
    const image = { dataUrl, width, height };
    const reply = await send({ baseUrl: endpoint }, hunyuanSpotting.build(image), "the reader");
    const lines = hunyuanSpotting.parse(reply.text, image);
    const ink = (box) => inkOf(data, width, height, box);
    const inks = lines.map((l) => ink(l.box));
    const heads = lines.map((l) => ink(seam(l.box, "head")));
    const tails = lines.map((l) => ink(seam(l.box, "tail")));
    const cuts = dividerFor(data, width, height);
    const divided = [];
    for (let i = 0; i < lines.length; i++) {
      for (let j = 0; j < lines.length; j++) {
        if (i !== j && near(lines[i].box, lines[j].box) && cuts(lines[i].box, lines[j].box)) divided.push([i, j]);
      }
    }
    return { width, height, lines, inks, heads, tails, divided };
  }
  return __toCommonJS(dump_spots_exports);
})();
