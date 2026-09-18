#!/usr/bin/env python3
"""Serves the demo page and runs the pipeline behind it."""

import io
import json
import os
import sys
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import pipeline

HERE = os.path.dirname(os.path.abspath(__file__))
MAX_UPLOAD = 24 * 1024 * 1024

# Anything much larger is slow to read and gains nothing: the models work from a
# resized view anyway.
MAX_DIM = 1600


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        sys.stderr.write("  %s\n" % (fmt % args))

    def _send(self, code, body, content_type):
        self.send_response(code)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path = "index.html" if self.path in ("/", "/index.html") else self.path.lstrip("/")
        full = os.path.join(HERE, os.path.basename(path))
        if not os.path.isfile(full):
            self._send(404, b"not found", "text/plain")
            return
        kind = "text/html; charset=utf-8" if full.endswith(".html") else "application/octet-stream"
        with open(full, "rb") as handle:
            self._send(200, handle.read(), kind)

    def do_POST(self):
        if self.path != "/translate":
            self._send(404, b"not found", "text/plain")
            return
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0 or length > MAX_UPLOAD:
            self._send(413, b'{"error":"image too large"}', "application/json")
            return

        raw = self.rfile.read(length)
        target = self.headers.get("X-Target-Language") or "English"
        erase = (self.headers.get("X-Erase") or "off").lower()
        shapes = (self.headers.get("X-Shapes") or "on").lower() == "on"
        try:
            image = Image.open(io.BytesIO(raw))
            image.load()
            if max(image.size) > MAX_DIM:
                scale = MAX_DIM / max(image.size)
                image = image.resize((int(image.width * scale), int(image.height * scale)),
                                     Image.LANCZOS)
            translated, report, timings = pipeline.run(image, target=target, erase=erase, shapes=shapes)
            payload = {
                "image": pipeline.as_data_uri(translated),
                "original": pipeline.as_data_uri(image.convert("RGB")),
                "blocks": report,
                "timings": timings,
                "size": [image.width, image.height],
            }
            self._send(200, json.dumps(payload).encode(), "application/json")
        except pipeline.PipelineError as e:
            self._send(503, json.dumps({"error": str(e)}).encode(), "application/json")
        except Exception as e:
            traceback.print_exc()
            self._send(500, json.dumps({"error": "%s: %s" % (type(e).__name__, e)}).encode(),
                       "application/json")


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    print("demo on http://127.0.0.1:%d" % port)
    print("  reader     %s" % pipeline.OCR_SERVER)
    print("  translator %s" % pipeline.MT_SERVER)
    ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()


if __name__ == "__main__":
    main()
