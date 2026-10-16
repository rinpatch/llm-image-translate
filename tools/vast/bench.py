#!/usr/bin/env python3
"""Sequential OCR benchmark; can also measure an already-running local server."""
import argparse
import base64
import hashlib
import io
import json
import os
from pathlib import Path
import re
import signal
import statistics
import subprocess
import time
import urllib.request

from PIL import Image

PROMPT = '检测并识别图片中的文字，将文本坐标格式化输出。'
SPOT = re.compile(r'(.+?)\((\d+),(\d+)\),\((\d+),(\d+)\)', re.S)
CONFIGS = ['q8-mac', 'f16', 'q8', 'q5', 'q4', 'vllm', 'dflash', 'dflash-llama']


def request(url, body, timeout=300):
    req = urllib.request.Request(url, data=json.dumps(body).encode(),
                                 headers={'Content-Type': 'application/json'})
    start = time.perf_counter()
    first = None
    chunks, usage, timings, finish = [], {}, {}, None
    with urllib.request.urlopen(req, timeout=timeout) as response:
        for line in response:
            if not line.startswith(b'data:'):
                continue
            data = line[5:].strip()
            if data == b'[DONE]':
                break
            event = json.loads(data)
            if 'error' in event:
                raise RuntimeError(event['error'])
            usage = event.get('usage') or usage
            timings = event.get('timings') or timings
            for choice in event.get('choices', []):
                content = choice.get('delta', {}).get('content')
                if content:
                    first = first or time.perf_counter()
                    chunks.append(content)
                finish = choice.get('finish_reason') or finish
    elapsed = time.perf_counter() - start
    if finish is None:
        raise RuntimeError('Stream ended without a finish reason')
    text = ''.join(chunks)
    tokens = usage.get('completion_tokens', timings.get('predicted_n'))
    return dict(text=text, finish=finish, wall_s=elapsed,
                ttft_s=first - start if first else None,
                output_tokens=tokens, usage=usage, timings=timings,
                end_to_end_tps=tokens / elapsed if tokens else None)


def image_payload(path, max_dim):
    with Image.open(path) as image:
        image = image.convert('RGB')
        scale = min(1, max_dim / max(image.size))
        image = image.resize(tuple(max(1, round(v * scale)) for v in image.size), Image.Resampling.LANCZOS)
        buf = io.BytesIO()
        image.save(buf, 'PNG')
        raw = buf.getvalue()
        return ('data:image/png;base64,' + base64.b64encode(raw).decode(),
                hashlib.sha256(raw).hexdigest(), image.size)


def stop(process):
    if process is None:
        return
    try:
        os.killpg(process.pid, signal.SIGTERM)
        process.wait(timeout=30)
    except subprocess.TimeoutExpired:
        os.killpg(process.pid, signal.SIGKILL)
        process.wait()
    except ProcessLookupError:
        pass


def wait_ready(base, process, timeout):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise RuntimeError('Server exited; inspect server.log')
        try:
            with urllib.request.urlopen(base + '/v1/models', timeout=2):
                return
        except OSError:
            time.sleep(1)
    raise TimeoutError('Server startup timed out')


def summarize(rows):
    valid = [r for r in rows if 'error' not in r]
    def median(key):
        values = [r[key] for r in valid if r.get(key) is not None]
        return statistics.median(values) if values else None
    return dict(requests=len(rows), errors=len(rows) - len(valid),
                truncated=sum(r['finish'] == 'length' for r in valid),
                empty=sum(not r['text'].strip() for r in valid),
                median_wall_s=median('wall_s'), median_ttft_s=median('ttft_s'),
                median_end_to_end_tps=median('end_to_end_tps'),
                median_server_decode_tps=median('server_decode_tps'))


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('images', nargs='+', type=Path)
    p.add_argument('--configs', nargs='+', choices=CONFIGS, default=CONFIGS)
    p.add_argument('--endpoint', help='Use an existing server instead of launching the matrix')
    p.add_argument('--backend', choices=['llama', 'vllm'], default='llama')
    p.add_argument('--model', default='hyocr')
    p.add_argument('--label', default='local-q8')
    p.add_argument('--out', type=Path, required=True)
    p.add_argument('--runs', type=int, default=3)
    p.add_argument('--max-dim', type=int, default=1600)
    p.add_argument('--max-tokens', type=int, default=2048)
    p.add_argument('--startup-timeout', type=int, default=900)
    args = p.parse_args()
    if min(args.runs, args.max_dim, args.max_tokens) < 1:
        p.error('runs, max-dim and max-tokens must be positive')
    if not re.fullmatch(r'[A-Za-z0-9_-]+', args.label):
        p.error('label must contain only letters, numbers, underscores or hyphens')
    payloads = [(str(path), *image_payload(path, args.max_dim)) for path in args.images]
    args.out.mkdir(parents=True, exist_ok=False)
    (args.out / 'config.json').write_text(json.dumps(vars(args), default=str, indent=2))
    if not args.endpoint:
        result = subprocess.run(['nvidia-smi', '-q'], capture_output=True, text=True)
        (args.out / 'gpu.txt').write_text(result.stdout + result.stderr)
    summary = {}
    base = (args.endpoint or 'http://127.0.0.1:' + os.environ.get('PORT', '8090')).rstrip('/').removesuffix('/v1')
    if not args.endpoint:
        try:
            with urllib.request.urlopen(base + '/v1/models', timeout=2):
                raise RuntimeError('Benchmark port is already serving a model')
        except OSError:
            pass
    for config in ([args.label] if args.endpoint else args.configs):
        folder = args.out / config
        folder.mkdir()
        process = None
        rows = []
        backend = args.backend if args.endpoint else ('vllm' if config in ['vllm', 'dflash'] else 'llama')
        try:
            with (folder / 'server.log').open('w') as log:
                if not args.endpoint:
                    process = subprocess.Popen(['bash', str(Path(__file__).with_name('serve.sh')), config],
                                               stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
                    wait_ready(base, process, args.startup_timeout)
                with (folder / 'requests.jsonl').open('w') as results:
                    # Warm each image shape, while leaving request caches disabled.
                    for run in range(args.runs + 1):
                        for path, data, digest, size in payloads:
                            body = dict(model=args.model, temperature=0, top_p=1,
                                        max_tokens=args.max_tokens, stream=True,
                                        stream_options={'include_usage': True},
                                        messages=[{'role': 'user', 'content': [
                                            {'type': 'image_url', 'image_url': {'url': data}},
                                            {'type': 'text', 'text': PROMPT}]}])
                            if backend == 'llama':
                                body.update(cache_prompt=False, repeat_penalty=1.0)
                            else:
                                body.update(repetition_penalty=1.0)
                            row = dict(image=path, image_sha256=digest, size=size, run=run, warmup=run == 0)
                            try:
                                row.update(request(base + '/v1/chat/completions', body))
                                matches = SPOT.findall(row['text'])
                                row['spots'] = [{'text': m[0].strip(), 'box': list(map(int, m[1:]))} for m in matches]
                                row['server_decode_tps'] = row['timings'].get('predicted_per_second')
                            except Exception as error:
                                row['error'] = str(error)
                            results.write(json.dumps(row, ensure_ascii=False) + '\n')
                            results.flush()
                            if run:
                                rows.append(row)
                summary[config] = summarize(rows)
        except Exception as error:
            summary[config] = {'error': str(error)}
        finally:
            stop(process)
        (args.out / 'summary.json').write_text(json.dumps(summary, indent=2))
        print(config, json.dumps(summary[config]), flush=True)
    if any(s.get('error') or s.get('errors') or s.get('empty') or s.get('truncated') for s in summary.values()):
        raise SystemExit(1)


if __name__ == '__main__':
    main()
