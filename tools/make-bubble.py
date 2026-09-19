#!/usr/bin/env python3
"""Draws test/fixtures/pages/bubble-tilted.png.

The one case that reaches a grown layout and a real lean together, which no
photograph in pages/ happens to do. Both halves of that are fussy, so the
numbers here are load-bearing:

  * the bubble has to stay under 2.5x the line's box height or containerBox
    throws it away (SHAPE_MAX_H), which is why it is a letterbox and not a
    speech balloon;
  * the translation has to run past 12 characters before allowance() grants
    more than 2.4x, and the bubble is wider than that;
  * the text is one line, not two, because the reader splits tilted synthetic
    Songti into separate horizontal spots and they never group.

    poc/.venv/bin/python tools/make-bubble.py
"""

from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

FONT = '/System/Library/Fonts/Supplemental/Songti.ttc'
OUT = Path(__file__).resolve().parent.parent / 'test/fixtures/pages/bubble-tilted.png'


def main() -> None:
    img = Image.new('RGB', (760, 500), (238, 198, 198))
    ImageDraw.Draw(img).rounded_rectangle((150, 215, 600, 315), radius=24, fill=(255, 255, 255))
    tile = Image.new('RGBA', (380, 80), (0, 0, 0, 0))
    ImageDraw.Draw(tile).text(
        (8, 14), '本日は臨時休業です', font=ImageFont.truetype(FONT, 34), fill=(20, 20, 20, 255))
    img.paste(tile := tile.rotate(6, resample=Image.BICUBIC, expand=True), (195, 215), tile)
    img.save(OUT)
    print(OUT)


if __name__ == '__main__':
    main()
