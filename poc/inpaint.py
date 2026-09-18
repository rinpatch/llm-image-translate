"""Erase text from an image before the translation is drawn over it.

A flat fill is indistinguishable from real inpainting on a plain background and
free, so it stays the default. LaMa is for the regions where the background has
something to reconstruct -- texture, a photograph, a gradient.
"""

import os

import numpy as np
from PIL import Image, ImageFilter

MODEL = os.path.join(os.path.dirname(os.path.abspath(__file__)), "models", "lama_fp32.onnx")
SIDE = 512

# Above this much variation in the pixels ringing a block, a flat fill would
# read as a patch and the region is worth handing to the model.
BUSY_STD = 16.0

# Glyph edges are anti-aliased and often carry a shadow, so the mask is grown
# past what thresholding finds or a grey outline survives the erase.
DILATE = 3

_session = None


def available():
    return os.path.isfile(MODEL)


def session():
    global _session
    if _session is None:
        import onnxruntime as ort
        providers = [p for p in ("CoreMLExecutionProvider", "CPUExecutionProvider")
                     if p in ort.get_available_providers()]
        _session = ort.InferenceSession(MODEL, providers=providers)
    return _session


def busyness(image, box):
    """Spread of the pixels just outside a block, as a stand-in for texture."""
    x0, y0, x1, y1 = box
    pad = max(3, (y1 - y0) // 3)
    outer = np.asarray(image.crop((max(0, x0 - pad), max(0, y0 - pad),
                                   min(image.width, x1 + pad),
                                   min(image.height, y1 + pad))).convert("L"), dtype=np.float32)
    if outer.size == 0:
        return 0.0
    inner_y0, inner_x0 = min(pad, outer.shape[0]), min(pad, outer.shape[1])
    ring = outer.copy()
    ring[inner_y0:outer.shape[0] - pad, inner_x0:outer.shape[1] - pad] = np.nan
    values = ring[~np.isnan(ring)]
    return float(values.std()) if values.size else 0.0


def glyph_mask(image, boxes):
    """White where text is, black elsewhere, across the whole image.

    Thresholding inside each box rather than filling the box wholesale keeps the
    real background between the characters, so the model has less to invent.
    """
    mask = Image.new("L", image.size, 0)
    for x0, y0, x1, y1 in boxes:
        region = np.asarray(image.crop((x0, y0, x1, y1)).convert("L"))
        if region.size == 0:
            continue
        counts = np.bincount(region.ravel(), minlength=256).astype(np.float64)
        total = counts.sum()
        weights = np.arange(256)
        omega = np.cumsum(counts) / total
        mu = np.cumsum(counts * weights) / total
        mu_t = mu[-1]
        denom = omega * (1 - omega)
        denom[denom == 0] = 1e-9
        between = (mu_t * omega - mu) ** 2 / denom
        threshold = int(np.argmax(between))

        dark = region <= threshold
        # Text is the minority of a text block; whichever class is smaller is it.
        glyphs = dark if dark.mean() < 0.5 else ~dark
        patch = Image.fromarray((glyphs * 255).astype(np.uint8))
        mask.paste(patch, (x0, y0))
    return mask.filter(ImageFilter.MaxFilter(DILATE * 2 + 1))


def windows(boxes, size, pad_ratio=0.6):
    """Merge boxes whose padded neighbourhoods touch, so each is inpainted once."""
    width, height = size
    rects = []
    for x0, y0, x1, y1 in boxes:
        pad = max(8, int((y1 - y0) * pad_ratio))
        rects.append([max(0, x0 - pad), max(0, y0 - pad),
                      min(width, x1 + pad), min(height, y1 + pad)])
    merged = True
    while merged:
        merged = False
        for i in range(len(rects)):
            for j in range(i + 1, len(rects)):
                a, b = rects[i], rects[j]
                if a[0] < b[2] and b[0] < a[2] and a[1] < b[3] and b[1] < a[3]:
                    rects[i] = [min(a[0], b[0]), min(a[1], b[1]),
                                max(a[2], b[2]), max(a[3], b[3])]
                    rects.pop(j)
                    merged = True
                    break
            if merged:
                break
    return [tuple(r) for r in rects]


def erase(image, boxes):
    """Return a copy of the image with the text in `boxes` painted out."""
    if not boxes:
        return image
    run = session()
    result = image.convert("RGB").copy()
    mask = glyph_mask(image, boxes)

    for window in windows(boxes, image.size):
        crop = result.crop(window).convert("RGB")
        crop_mask = mask.crop(window)
        if not crop_mask.getbbox():
            continue

        small = crop.resize((SIDE, SIDE), Image.BICUBIC)
        small_mask = crop_mask.resize((SIDE, SIDE), Image.BILINEAR)

        rgb = np.asarray(small, dtype=np.float32).transpose(2, 0, 1)[None] / 255.0
        m = (np.asarray(small_mask, dtype=np.float32)[None, None] > 127).astype(np.float32)
        # The hole is punched out before the model sees it. Left in, LaMa has a
        # perfectly good picture of the text and simply hands it back.
        rgb = rgb * (1.0 - m)
        out = run.run(None, {"image": rgb, "mask": m})[0]

        # The model takes 0..1 and hands back 0..255 already; scaling the
        # output again saturates every pixel to white.
        painted = Image.fromarray(
            np.clip(out[0].transpose(1, 2, 0), 0, 255).astype(np.uint8)
        ).resize(crop.size, Image.BICUBIC)

        # Only masked pixels are taken, softened at the rim so the patch does
        # not show its own outline where it meets untouched pixels.
        alpha = crop_mask.filter(ImageFilter.GaussianBlur(2))
        result.paste(Image.composite(painted, crop, alpha), window[:2])
    return result
