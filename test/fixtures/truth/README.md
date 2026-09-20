# Truth

Pages whose true boxes are known, because they were drawn rather than found:
`tools/make-truth.py` records the box each draw call filled, so the JSON beside
each image is the generator's own arithmetic. `tools/bench-readers.ts` scores
readers against them — see CLAUDE.md.

Both are inside every adapter's `maxDim`, so nothing is scaled on the way to a
model and the boxes that come back are in the same pixels as the truth. Each is
written as both a PNG and a JPEG; the adapter's `encode` picks.

| page | what it is | what it asks of a reader |
| --- | --- | --- |
| `clean.png` | nine lines of comic lettering, bubbles and panels, 880x1180 | Nothing hard. A reader that drops a line here is not worth benching further. |
| `noisy.png` | thirteen lines, 980x1060 | A 7-degree lean; grey text on a grey gradient; four lines of 15px small print alternating Japanese and English; a vertical column set glyph by glyph; Traditional Chinese; light on a dark panel; and `うすい文字` at 238 against 248, which only a reader with real sensitivity finds. |

HunyuanOCR takes both 22/22 at mean IoU 0.91, and PP-OCRv6 small takes 21/22 at
0.90 — it is the faint line it loses. So these pages catch a regression but no
longer separate two good readers on counts; mean IoU is what does that. A third
page belongs here the next time something gets through.
