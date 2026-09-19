#!/usr/bin/env python3
"""Cold-prefill end-to-end timing for the local (or OpenRouter) pair.

Matches the extension's Hunyuan spotting + Hy-MT2 prompts so the numbers are
comparable to what the worker sees. Each run mutates one pixel so llama.cpp's
prompt cache cannot turn a second ask into a free pass.

    poc/.venv/bin/python tools/bench.py test/fixtures/manga-page.png
    poc/.venv/bin/python tools/bench.py test/fixtures/manga-page.png --runs 3 --save /tmp/gold.json
    poc/.venv/bin/python tools/bench.py test/fixtures/manga-page.png --compare /tmp/gold.json
"""

from __future__ import annotations

import argparse
import base64
import io
import json
import os
import re
import statistics
import sys
import time
import urllib.error
import urllib.request

from PIL import Image

SPOTTING = '检测并识别图片中的文字，将文本坐标格式化输出。'
SPOT_RE = re.compile(r'(.+?)\((\d+),(\d+)\),\((\d+),(\d+)\)', re.S)
# Same wording as src/backends/translate/hunyuan-mt.ts
MT_PROMPT = (
    'Translate the following text into {target}. Note that you should **only '
    'output the translated result without any additional explanation**. Keep the '
    'numbering, one line per numbered line:\n\n{body}'
)


def api_root(url: str) -> str:
    # Accept either http://host:8090 or https://openrouter.ai/api/v1.
    return url.rstrip('/').removesuffix('/v1') + '/v1'


def post(url: str, body: dict, headers: dict | None = None, timeout: int = 300) -> dict:
    req = urllib.request.Request(
        url, data=json.dumps(body).encode(),
        headers={'Content-Type': 'application/json', **(headers or {})})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.load(resp)
    except urllib.error.HTTPError as e:
        detail = e.read().decode('utf-8', 'replace')[:500]
        raise RuntimeError(f'{e.code} from {url}: {detail}') from e


def data_url(img: Image.Image, fmt: str, quality: int = 90) -> tuple[str, int]:
    buf = io.BytesIO()
    if fmt.upper() == 'JPEG':
        img.convert('RGB').save(buf, 'JPEG', quality=quality)
        mime = 'image/jpeg'
    else:
        img.save(buf, 'PNG')
        mime = 'image/png'
    raw = buf.getvalue()
    return f'data:{mime};base64,{base64.b64encode(raw).decode()}', len(raw)


def resize(src: Image.Image, max_dim: int) -> Image.Image:
    scale = min(1.0, max_dim / max(src.size))
    size = (max(1, round(src.width * scale)), max(1, round(src.height * scale)))
    return src.resize(size, Image.LANCZOS)


def bust(img: Image.Image, nonce: int) -> Image.Image:
    """Flip one pixel so the image tokens differ from every prior run."""
    out = img.copy()
    x, y = nonce % out.width, (nonce * 17) % out.height
    px = list(out.getpixel((x, y)))
    px[0] = (px[0] + 1 + (nonce % 3)) % 256
    out.putpixel((x, y), tuple(px))
    return out


def parse_spots(text: str) -> list[str]:
    return [m[0].strip() for m in SPOT_RE.findall(text)]


def parse_mt(text: str, expected: int) -> list[str | None]:
    out: list[str | None] = [None] * expected
    for line in text.strip().splitlines():
        m = re.match(r'^\s*(\d+)[.)]\s*(.+)$', line)
        if not m:
            continue
        at = int(m.group(1)) - 1
        if 0 <= at < expected:
            out[at] = m.group(2).strip()
    return out


def run_once(
    src: Image.Image,
    *,
    nonce: int,
    max_dim: int,
    encode: str,
    ocr_url: str,
    mt_url: str,
    ocr_headers: dict,
    mt_headers: dict,
    ocr_model: str | None,
    mt_model: str | None,
    target: str,
) -> dict:
    img = bust(resize(src, max_dim), nonce)
    url, nbytes = data_url(img, encode)

    ocr_body: dict = {
        'messages': [{'role': 'user', 'content': [
            {'type': 'image_url', 'image_url': {'url': url}},
            {'type': 'text', 'text': SPOTTING},
        ]}],
        'temperature': 0,
        'max_tokens': 2048,
    }
    if ocr_model:
        ocr_body['model'] = ocr_model

    t0 = time.time()
    ocr = post(f'{api_root(ocr_url)}/chat/completions', ocr_body, ocr_headers)
    ocr_wall = round((time.time() - t0) * 1000)
    content = ocr['choices'][0]['message']['content']
    spots = parse_spots(content)
    unique = list(dict.fromkeys(spots))  # order-preserving unique
    ocr_t = ocr.get('timings') or {}

    numbered = '\n'.join(f'{i + 1}. {s.replace(chr(10), " ")}' for i, s in enumerate(unique))
    mt_body: dict = {
        'messages': [{'role': 'user', 'content': MT_PROMPT.format(target=target, body=numbered)}],
        'temperature': 0,
        'max_tokens': 2048,
    }
    if mt_model:
        mt_body['model'] = mt_model

    t1 = time.time()
    mt = post(f'{api_root(mt_url)}/chat/completions', mt_body, mt_headers)
    mt_wall = round((time.time() - t1) * 1000)
    translations = parse_mt(mt['choices'][0]['message']['content'], len(unique))
    mt_t = mt.get('timings') or {}

    return {
        'dim': f'{img.width}x{img.height}',
        'bytes': nbytes,
        'encode': encode.lower(),
        'total_ms': ocr_wall + mt_wall,
        'ocr_wall_ms': ocr_wall,
        'mt_wall_ms': mt_wall,
        'ocr_prompt_n': ocr_t.get('prompt_n'),
        'ocr_prompt_ms': round(ocr_t['prompt_ms']) if 'prompt_ms' in ocr_t else None,
        'ocr_pred_n': ocr_t.get('predicted_n'),
        'ocr_pred_ms': round(ocr_t['predicted_ms']) if 'predicted_ms' in ocr_t else None,
        'mt_prompt_n': mt_t.get('prompt_n'),
        'mt_prompt_ms': round(mt_t['prompt_ms']) if 'prompt_ms' in mt_t else None,
        'mt_pred_n': mt_t.get('predicted_n'),
        'mt_pred_ms': round(mt_t['predicted_ms']) if 'predicted_ms' in mt_t else None,
        'spots': len(spots),
        'unique': len(unique),
        'translated': sum(1 for t in translations if t),
        'finish': ocr['choices'][0].get('finish_reason'),
        'spot_texts': unique,
        'translations': translations,
    }


def jaccard(a: list[str], b: list[str]) -> float:
    sa, sb = set(a), set(b)
    if not sa and not sb:
        return 1.0
    return len(sa & sb) / len(sa | sb)


def compare(run: dict, gold: dict) -> dict:
    spot_j = jaccard(run['spot_texts'], gold['spot_texts'])
    # Align translations by exact source text match.
    gold_map = {s: t for s, t in zip(gold['spot_texts'], gold['translations'])}
    matched = 0
    comparable = 0
    for s, t in zip(run['spot_texts'], run['translations']):
        if s not in gold_map or gold_map[s] is None:
            continue
        comparable += 1
        if t == gold_map[s]:
            matched += 1
    return {
        'spot_jaccard': round(spot_j, 4),
        'unique_delta': run['unique'] - gold['unique'],
        'translation_exact': f'{matched}/{comparable}' if comparable else 'n/a',
        'translation_rate': round(matched / comparable, 4) if comparable else None,
    }


def median_int(values: list[int]) -> int:
    return int(statistics.median(values))


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument('image')
    p.add_argument('--runs', type=int, default=3)
    p.add_argument('--max-dim', type=int, default=1600)
    p.add_argument('--encode', choices=('png', 'jpeg'), default='png')
    p.add_argument('--ocr', default=os.environ.get('OCR_SERVER', 'http://127.0.0.1:8090'))
    p.add_argument('--mt', default=os.environ.get('MT_SERVER', 'http://127.0.0.1:8091'))
    p.add_argument('--ocr-model', default=os.environ.get('OCR_MODEL_NAME') or None)
    p.add_argument('--mt-model', default=os.environ.get('MT_MODEL_NAME') or None)
    p.add_argument('--ocr-key', default=os.environ.get('OCR_API_KEY') or None)
    p.add_argument('--mt-key', default=os.environ.get('MT_API_KEY') or None)
    p.add_argument('--target', default='English')
    p.add_argument('--save', help='write the first run as a gold quality snapshot')
    p.add_argument('--compare', help='compare each run against a gold snapshot')
    p.add_argument('--discard-first', action='store_true',
                   help='run once more before timing (weights already resident, but useful after a restart)')
    args = p.parse_args()

    src = Image.open(args.image).convert('RGB')
    ocr_headers = {'Authorization': f'Bearer {args.ocr_key}'} if args.ocr_key else {}
    mt_headers = {'Authorization': f'Bearer {args.mt_key}'} if args.mt_key else {}
    gold = json.load(open(args.compare)) if args.compare else None

    if args.discard_first:
        print(json.dumps({'warmup': True, **{k: v for k, v in run_once(
            src, nonce=0, max_dim=args.max_dim, encode=args.encode,
            ocr_url=args.ocr, mt_url=args.mt, ocr_headers=ocr_headers, mt_headers=mt_headers,
            ocr_model=args.ocr_model, mt_model=args.mt_model, target=args.target,
        ).items() if k not in ('spot_texts', 'translations')}}), flush=True)

    runs = []
    for i in range(args.runs):
        result = run_once(
            src, nonce=i + 1, max_dim=args.max_dim, encode=args.encode,
            ocr_url=args.ocr, mt_url=args.mt, ocr_headers=ocr_headers, mt_headers=mt_headers,
            ocr_model=args.ocr_model, mt_model=args.mt_model, target=args.target,
        )
        if args.save and i == 0:
            with open(args.save, 'w') as f:
                json.dump({
                    'spot_texts': result['spot_texts'],
                    'translations': result['translations'],
                    'unique': result['unique'],
                    'meta': {k: result[k] for k in (
                        'dim', 'encode', 'spots', 'unique', 'translated', 'finish')},
                }, f, ensure_ascii=False, indent=2)
            print(f'saved gold → {args.save}', file=sys.stderr)
        summary = {k: v for k, v in result.items() if k not in ('spot_texts', 'translations')}
        if gold:
            summary['quality'] = compare(result, gold)
        print(json.dumps(summary), flush=True)
        runs.append(result)

    if len(runs) > 1:
        print(json.dumps({
            'median': {
                'total_ms': median_int([r['total_ms'] for r in runs]),
                'ocr_wall_ms': median_int([r['ocr_wall_ms'] for r in runs]),
                'mt_wall_ms': median_int([r['mt_wall_ms'] for r in runs]),
                'unique': median_int([r['unique'] for r in runs]),
            },
            'n': len(runs),
        }), flush=True)


if __name__ == '__main__':
    main()
