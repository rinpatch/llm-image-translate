#!/usr/bin/env python3
# /// script
# dependencies = ["pillow"]
# ///
"""Draws the pages tools/bench-readers.ts scores readers against.

Drawn rather than found, because the point is knowing where every line really
is: each draw call records the box it filled, so the truth beside the PNG is
the generator's own arithmetic and not somebody's tracing.

Two pages. `clean` is nine lines of ordinary comic lettering, which every
reader worth trying should get. `noisy` is the thirteen that separate them — a
lean, grey on a grey gradient, small print in two languages, a vertical
column, and a line at the edge of visible.

Both stay under 1280 on the long side, the smallest `maxDim` of any adapter,
so no reader has to scale them down and the boxes stay in the pixels the truth
is written in.

    uv run tools/make-truth.py
"""

from __future__ import annotations

import json
import math
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

# Songti's face 0 is Songti SC Black, a display weight whose glyph set has
# holes — 聞, 語, 間 and a dozen more come out blank. Face 1 is the complete one.
JAPANESE = ('/System/Library/Fonts/ヒラギノ角ゴシック W3.ttc', 0)
CHINESE = ('/System/Library/Fonts/Supplemental/Songti.ttc', 1)
LATIN = ('/System/Library/Fonts/Supplemental/Arial Unicode.ttf', 0)
OUT = Path(__file__).resolve().parent.parent / 'test/fixtures/truth'


class Page:
    """A canvas that remembers where it put each line."""

    def __init__(self, width: int, height: int, background=(255, 255, 255)):
        self.img = Image.new('RGB', (width, height), background)
        self.draw = ImageDraw.Draw(self.img)
        self.lines: list[dict] = []

    def font(self, size: int, face=None) -> ImageFont.FreeTypeFont:
        path, index = face or JAPANESE
        return ImageFont.truetype(path, size, index=index)

    def text(self, xy, text, size, fill=(20, 20, 20), face=None) -> None:
        font = self.font(size, face)
        self.draw.text(xy, text, font=font, fill=fill)
        self.record(text, self.draw.textbbox(xy, text, font=font))

    def tilted(self, xy, text, size, degrees, fill=(20, 20, 20), face=None) -> None:
        """Drawn on its own tile and rotated in, so the box is the turned one."""
        font = self.font(size, face)
        pad = size
        w, h = self.draw.textbbox((0, 0), text, font=font)[2:]
        tile = Image.new('RGBA', (w + pad * 2, h + pad * 2), (0, 0, 0, 0))
        ImageDraw.Draw(tile).text((pad, pad), text, font=font, fill=(*fill, 255))
        turned = tile.rotate(degrees, resample=Image.BICUBIC, expand=True)
        self.img.paste(turned, xy, turned)
        # The glyphs' four corners, turned about the tile's centre, then moved
        # by however much expand=True grew the tile.
        rad = math.radians(degrees)
        cx, cy = tile.width / 2, tile.height / 2
        dx, dy = (turned.width - tile.width) / 2, (turned.height - tile.height) / 2
        corners = [(pad, pad), (pad + w, pad), (pad, pad + h), (pad + w, pad + h)]
        turned_corners = [
            (xy[0] + dx + cx + (x - cx) * math.cos(rad) + (y - cy) * math.sin(rad),
             xy[1] + dy + cy - (x - cx) * math.sin(rad) + (y - cy) * math.cos(rad))
            for x, y in corners]
        xs = [p[0] for p in turned_corners]
        ys = [p[1] for p in turned_corners]
        self.record(text, (min(xs), min(ys), max(xs), max(ys)))

    def column(self, xy, text, size, fill=(20, 20, 20), face=None) -> None:
        """A vertical CJK column. PIL sets no such thing, so one glyph at a time."""
        font = self.font(size, face)
        x, y = xy
        boxes = []
        for glyph in text:
            self.draw.text((x, y), glyph, font=font, fill=fill)
            boxes.append(self.draw.textbbox((x, y), glyph, font=font))
            y += size
        self.record(text, (min(b[0] for b in boxes), min(b[1] for b in boxes),
                           max(b[2] for b in boxes), max(b[3] for b in boxes)))

    def record(self, text: str, box) -> None:
        self.lines.append({'text': text, 'box': [round(v) for v in box]})

    def save(self, name: str) -> None:
        OUT.mkdir(parents=True, exist_ok=True)
        self.img.save(OUT / f'{name}.png')
        # An adapter that asks for JPEG gets the same page at the same size, at
        # the quality the pipeline encodes with, rather than a PNG mislabelled.
        self.img.save(OUT / f'{name}.jpg', quality=90)
        (OUT / f'{name}.json').write_text(json.dumps(
            {'width': self.img.width, 'height': self.img.height, 'lines': self.lines},
            ensure_ascii=False, indent=1) + '\n', encoding='utf-8')
        print(OUT / f'{name}.png', f'({len(self.lines)} lines)')


def clean() -> None:
    page = Page(880, 1180)
    bubbles = [(60, 60, 500, 190), (380, 250, 820, 380), (60, 800, 560, 930)]
    for box in bubbles:
        page.draw.rounded_rectangle(box, radius=28, fill=(255, 255, 255),
                                    outline=(30, 30, 30), width=3)
    page.draw.rectangle((60, 440, 820, 720), fill=(232, 232, 236))
    page.draw.rectangle((580, 980, 820, 1120), fill=(40, 40, 48))

    page.text((92, 92), 'これは静かな朝だった', 34)
    page.text((92, 134), 'だれもいない', 34)
    page.text((412, 282), '町のはずれで', 34)
    page.text((412, 324), '彼は立ち止まった', 34)
    page.text((96, 486), '何かが聞こえる', 40)
    page.text((96, 560), 'ふりむくと', 40)
    page.text((96, 634), 'そこには誰もいなかった', 40)
    page.text((92, 832), '風が吹いていた', 34)
    page.text((606, 1010), '物語はここから', 28, fill=(240, 240, 240))
    page.save('clean')


def noisy() -> None:
    page = Page(980, 1060, (248, 248, 250))
    # A grey gradient for the grey line to sit on: the pair that a detector
    # thresholding the page outright loses.
    for y in range(240, 420):
        shade = 196 - (y - 240) // 6
        page.draw.line((0, y, 980, y), fill=(shade, shade, shade))

    page.tilted((70, 60), '本日は臨時休業です', 40, 7)
    page.text((520, 96), 'Closed for the day', 30, face=LATIN)

    page.text((60, 268), '営業時間のお知らせ', 36, fill=(150, 150, 150))
    page.text((60, 336), '午前九時から午後六時まで', 30, fill=(140, 140, 142))

    small = [
        ('注意事項をよくお読みください', JAPANESE),
        ('Please read all of the notes before use', LATIN),
        ('保管は直射日光を避けてください', JAPANESE),
        ('Keep away from direct sunlight and heat', LATIN),
    ]
    y = 470
    for text, face in small:
        page.text((60, y), text, 15, fill=(60, 60, 60), face=face)
        y += 26

    page.column((880, 620), '夜の街を歩く', 34)

    page.text((60, 640), '請勿觸摸展品', 34, fill=(30, 30, 30), face=CHINESE)
    page.text((60, 720), 'うすい文字', 34, fill=(238, 238, 240))

    page.draw.rectangle((60, 840, 700, 1000), fill=(28, 30, 40))
    page.text((90, 870), '夜間は照明を消します', 32, fill=(228, 228, 232))
    page.text((90, 930), 'Lights out after ten', 26, fill=(200, 200, 206), face=LATIN)
    page.save('noisy')


if __name__ == '__main__':
    clean()
    noisy()
