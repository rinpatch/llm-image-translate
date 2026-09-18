#!/usr/bin/env python3
"""Times the reader on one image at several scales.

The extension always sends `maxDim` from the OCR adapter's capabilities, so the
only way to see what that choice costs is to ask the server the same question at
other sizes. Run it against a warm server — a cold one spends its first seconds
reading weights off disk and every number comes out wrong.

    poc/.venv/bin/python tools/probe-reader.py test/fixtures/manga-page.png 1600 1280

`unique` below `spots` is the number that matters. HunyuanOCR repeats itself when
the text is too small to resolve, and a run that ends on `length` rather than
`stop` hit max_tokens mid-loop: slower than the larger image, and wrong as well.
"""

import base64
import io
import json
import re
import sys
import time
import urllib.request

from PIL import Image

# Must match src/backends/ocr/hunyuan.ts — a different prompt is a different
# workload and the timings stop being comparable to what the extension sees.
SPOTTING = '检测并识别图片中的文字，将文本坐标格式化输出。'
SPOT_RE = re.compile(r'(.+?)\((\d+),(\d+)\),\((\d+),(\d+)\)', re.S)
ENDPOINT = 'http://127.0.0.1:8090/v1/chat/completions'
MAX_TOKENS = 2048


def probe(src: Image.Image, max_dim: int) -> dict:
    scale = min(1.0, max_dim / max(src.size))
    size = (max(1, round(src.width * scale)), max(1, round(src.height * scale)))
    buf = io.BytesIO()
    src.resize(size, Image.LANCZOS).save(buf, 'PNG')
    body = {
        'messages': [{'role': 'user', 'content': [
            {'type': 'image_url', 'image_url': {
                'url': 'data:image/png;base64,' + base64.b64encode(buf.getvalue()).decode()}},
            {'type': 'text', 'text': SPOTTING}]}],
        'temperature': 0,
        'max_tokens': MAX_TOKENS,
    }
    request = urllib.request.Request(
        ENDPOINT, data=json.dumps(body).encode(),
        headers={'Content-Type': 'application/json'})
    started = time.time()
    out = json.load(urllib.request.urlopen(request, timeout=300))
    wall = round((time.time() - started) * 1000)

    choice = out['choices'][0]
    spots = [m[0].strip() for m in SPOT_RE.findall(choice['message']['content'])]
    timings = out.get('timings', {})
    prompt_ms, predicted_ms = timings.get('prompt_ms', 0), timings.get('predicted_ms', 0)
    return {
        'dim': f'{size[0]}x{size[1]}',
        'png_kb': round(len(buf.getvalue()) / 1024),
        'wall_ms': wall,
        'prompt_n': timings.get('prompt_n'),
        'prompt_ms': round(prompt_ms),
        'pred_n': timings.get('predicted_n'),
        'pred_ms': round(predicted_ms),
        # Whatever the server did not attribute to either: the POST itself, and
        # turning the image into embeddings before there is a prompt to evaluate.
        'other_ms': round(wall - prompt_ms - predicted_ms),
        'spots': len(spots),
        'unique': len(set(spots)),
        'finish': choice.get('finish_reason'),
    }


def main() -> None:
    if len(sys.argv) < 3:
        sys.exit(__doc__)
    src = Image.open(sys.argv[1]).convert('RGB')
    for arg in sys.argv[2:]:
        print(json.dumps(probe(src, int(arg))), flush=True)


if __name__ == '__main__':
    main()
