"""Image in, the same image with its text translated, out.

Two models, because neither does both jobs well. HunyuanOCR reads and locates
text superbly but barely translates out of Chinese -- the direction is absent
from its benchmarks and it shows. A general instruct model translates well and
cannot see. So one reads, the other translates.
"""

import base64
import io
import json
import os
from collections import deque
import re
import time
import urllib.error
import urllib.request

from PIL import Image, ImageDraw, ImageFont

# start.sh sets these; the defaults match what it starts.
OCR_SERVER = os.environ.get("OCR_SERVER", "http://127.0.0.1:8090")
MT_SERVER = os.environ.get("MT_SERVER", "http://127.0.0.1:8091")

# "chat" is a general instruct model over /v1/chat/completions. "gemma" is
# TranslateGemma, which is trained on one fixed prompt and refuses anything
# else -- its own chat template will not even render a plain string -- so the
# prompt is built by hand and sent to /completion.
MT_STYLE = os.environ.get("MT_STYLE", "chat")

# The JSON variant of this task is a prompt the model largely ignores; this is
# the format it was trained to emit, and it comes back clean.
SPOTTING = "检测并识别图片中的文字，将文本坐标格式化输出。"

# TEXT(x0,y0),(x1,y1) run together with no separators, normalised to 0-1000.
SPOT_RE = re.compile(r"(.+?)\((\d+),(\d+)\),\((\d+),(\d+)\)", re.S)

# Naming the target twice is not redundancy. Handed all-hiragana Japanese, a
# small model will happily "translate" it into ordinary Japanese orthography
# unless told that rewriting in the source language is the wrong answer.
TRANSLATE_SYSTEM = (
    "{origin}You translate into {target}. Every line of your reply must be written in "
    "{target} and nothing else. Rewriting the text in its original language is "
    "wrong, even when the original is unusual, informal or written in an odd "
    "script for its language.\n"
    "The text comes from one image, so the lines are context for each other: "
    "button labels, captions, chat messages, fragments. Translate each line as "
    "the same kind of thing it already is. A label stays a label, a fragment "
    "stays a fragment, and you add nothing that is not there.\n"
    "Personal and place names are read in the source language and written the "
    "way that language romanises them.\n"
    "The input is a numbered list. Reply with the same numbers in the same "
    "order, one translation per line, and nothing else."
)

RETRY_SYSTEM = (
    "Translate the text below into {target}. Reply with the {target} translation "
    "only -- no notes, no original text, no transliteration of the original."
)

# Scripts a target legitimately writes in. Latin-script targets are the default
# and need no entry; the point of the table is knowing when CJK in the output is
# correct rather than a sign nothing was translated.
TARGET_SCRIPT = {
    "chinese": re.compile(r"[\u4e00-\u9fff]"),
    "japanese": re.compile(r"[\u3040-\u30ff\u4e00-\u9fff]"),
    "korean": re.compile(r"[\uac00-\ud7af]"),
    "russian": re.compile(r"[\u0400-\u04ff]"),
    "ukrainian": re.compile(r"[\u0400-\u04ff]"),
}

NON_LATIN = re.compile(r"[\u0400-\u04ff\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af]")


def untranslated(source, result, target):
    """Why this line should be left alone, or None if it looks translated."""
    if not result:
        return "no translation came back"
    if result.strip() == source.strip():
        return "came back unchanged"
    if target.strip().lower() in TARGET_SCRIPT:
        return None
    # A Latin-script target: leftover CJK or Cyrillic means the model rewrote
    # rather than translated, and drawing it in a Latin font renders as boxes.
    letters = [c for c in result if c.isalpha()]
    if letters and sum(1 for c in letters if NON_LATIN.match(c)) / len(letters) > 0.2:
        return "reply is not in " + target
    return None

CJK = re.compile(r"[\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]")

# Kana and hangul are decisive; Han alone is not, since Japanese written without
# kana and Chinese look identical. Guessing wrong turns a Japanese name into
# pinyin, so the ambiguous case says nothing rather than something false.
SCRIPTS = (
    ("Japanese", re.compile(r"[\u3040-\u30ff]")),
    ("Korean", re.compile(r"[\uac00-\ud7af]")),
    ("Russian", re.compile(r"[\u0400-\u04ff]")),
    ("Arabic", re.compile(r"[\u0600-\u06ff]")),
    ("Thai", re.compile(r"[\u0e00-\u0e7f]")),
    ("Hindi", re.compile(r"[\u0900-\u097f]")),
    ("Chinese", re.compile(r"[\u3400-\u4dbf\u4e00-\u9fff]")),
)


# TranslateGemma wants the language named and coded, both from its own table.
LANG_CODES = {
    "english": "en", "chinese": "zh", "japanese": "ja", "korean": "ko",
    "russian": "ru", "ukrainian": "uk", "spanish": "es", "french": "fr",
    "german": "de", "portuguese": "pt", "italian": "it", "dutch": "nl",
    "polish": "pl", "turkish": "tr", "arabic": "ar", "hindi": "hi",
    "thai": "th", "vietnamese": "vi", "indonesian": "id",
}


def lang_code(name):
    return LANG_CODES.get((name or "").strip().lower(), "en")


def source_language(texts):
    joined = "".join(texts)
    for name, pattern in SCRIPTS:
        if pattern.search(joined):
            return name
    return None

# Lines that were one sentence before the renderer wrapped them belong together.
LINE_GAP = 0.7
MIN_OVERLAP = 0.3

# A line this much taller than it is wide is a column of vertical CJK, whose
# neighbours sit beside it rather than under it.
VERTICAL_RATIO = 1.5
COLUMN_GAP = 1.5
COLUMN_OVERLAP = 0.4

# Finding the shape a block sits in. The window has to be generous: a speech
# bubble is many times the size of the column of text inside it.
SHAPE_WINDOW = 7.0
SHAPE_TOL = 26
SHAPE_SEARCH_PX = 220
SHAPE_MAX_W = 8.0
SHAPE_MAX_H = 2.5
# A fill covering this much of the window found the page, not a container.
# Manga pages are mostly white, so the bar has to be low.
SHAPE_FLOOD_LIMIT = 0.55

# Growth is bought with text. A one-glyph sound effect needs almost none, and
# letting it fill a whole balloon turns it into a billboard.
def growth_allowance(text):
    chars = len(text.strip())
    if chars <= 3:
        return 1.6
    if chars <= 12:
        return 2.4
    return SHAPE_MAX_W

FONTS = [
    "/System/Library/Fonts/Supplemental/Arial.ttf",
    "/System/Library/Fonts/Helvetica.ttc",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "C:/Windows/Fonts/arial.ttf",
]


class PipelineError(RuntimeError):
    pass


def ask(server, messages, max_tokens=2048):
    body = json.dumps({"messages": messages, "temperature": 0.0,
                       "max_tokens": max_tokens}).encode()
    request = urllib.request.Request(
        server.rstrip("/") + "/v1/chat/completions",
        data=body, headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(request, timeout=600) as response:
            return json.load(response)["choices"][0]["message"]["content"].strip()
    except urllib.error.URLError as e:
        raise PipelineError("cannot reach %s (%s)" % (server, e))


def as_data_uri(image):
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    return "data:image/png;base64," + base64.b64encode(buffer.getvalue()).decode()


def spot(image, server=OCR_SERVER):
    reply = ask(server, [{
        "role": "user",
        "content": [{"type": "image_url", "image_url": {"url": as_data_uri(image)}},
                    {"type": "text", "text": SPOTTING}],
    }])
    lines = []
    for match in SPOT_RE.finditer(reply):
        text = match.group(1).strip()
        x0, y0, x1, y1 = (int(match.group(i)) for i in (2, 3, 4, 5))
        if text and x1 > x0 and y1 > y0:
            lines.append({"text": text,
                          "box": [round(x0 / 1000 * image.width),
                                  round(y0 / 1000 * image.height),
                                  round(x1 / 1000 * image.width),
                                  round(y1 / 1000 * image.height)]})
    return lines


def is_vertical(box):
    x0, y0, x1, y1 = box
    return (y1 - y0) > (x1 - x0) * VERTICAL_RATIO


def group_rows(lines):
    """Wrapped horizontal lines: neighbours sit underneath."""
    blocks = []
    for line in sorted(lines, key=lambda l: (l["box"][1], l["box"][0])):
        x0, y0, x1, y1 = line["box"]
        joined = False
        for block in reversed(blocks):
            bx0, by0, bx1, by1 = block["box"]
            gap = y0 - by1
            overlap = min(bx1, x1) - max(bx0, x0)
            if -block["line_h"] < gap <= block["line_h"] * LINE_GAP and \
               overlap > MIN_OVERLAP * min(bx1 - bx0, x1 - x0):
                block["box"] = [min(bx0, x0), min(by0, y0), max(bx1, x1), max(by1, y1)]
                block["lines"].append(line["text"])
                block["line_h"] = y1 - y0
                joined = True
                break
        if not joined:
            blocks.append({"box": [x0, y0, x1, y1], "lines": [line["text"]],
                           "line_h": y1 - y0, "vertical": False})
    return blocks


def group_columns(lines):
    """Vertical CJK: each column is read top to bottom, columns right to left."""
    blocks = []
    for line in sorted(lines, key=lambda l: (-l["box"][2], l["box"][1])):
        x0, y0, x1, y1 = line["box"]
        width = x1 - x0
        joined = False
        for block in reversed(blocks):
            bx0, by0, bx1, by1 = block["box"]
            gap = bx0 - x1          # this column sits to the left of the block
            overlap = min(by1, y1) - max(by0, y0)
            if -width < gap <= block["line_w"] * COLUMN_GAP and \
               overlap > COLUMN_OVERLAP * min(by1 - by0, y1 - y0):
                block["box"] = [min(bx0, x0), min(by0, y0), max(bx1, x1), max(by1, y1)]
                block["lines"].append(line["text"])
                block["line_w"] = width
                joined = True
                break
        if not joined:
            blocks.append({"box": [x0, y0, x1, y1], "lines": [line["text"]],
                           "line_w": width, "vertical": True})
    return blocks


def group(lines):
    columns = [l for l in lines if is_vertical(l["box"])]
    rows = [l for l in lines if not is_vertical(l["box"])]
    return group_rows(rows) + group_columns(columns)


def container_box(image, box, fill):
    """The shape a block sits in -- a bubble, a pill, a panel -- or None.

    Vertical Japanese leaves a column barely wider than one glyph, which no
    amount of font fitting will make hold a line of English. The bubble around
    it has the room; this looks for its edges.
    """
    x0, y0, x1, y1 = box
    w, h = x1 - x0, y1 - y0
    cx, cy = (x0 + x1) // 2, (y0 + y1) // 2
    half_w = max(w, int(w * SHAPE_WINDOW)) // 2
    half_h = max(h, int(h * SHAPE_WINDOW)) // 2
    wx0, wy0 = max(0, cx - half_w), max(0, cy - half_h)
    wx1, wy1 = min(image.width, cx + half_w), min(image.height, cy + half_h)
    if wx1 - wx0 < 8 or wy1 - wy0 < 8:
        return None

    window = image.crop((wx0, wy0, wx1, wy1))
    scale = min(1.0, SHAPE_SEARCH_PX / max(window.width, window.height))
    sw, sh = max(4, int(window.width * scale)), max(4, int(window.height * scale))
    pixels = window.resize((sw, sh), Image.BILINEAR).load()

    def alike(p):
        return abs(p[0] - fill[0]) + abs(p[1] - fill[1]) + abs(p[2] - fill[2]) <= SHAPE_TOL * 3

    seeds = []
    for px, py in ((x0, y0), (x1 - 1, y0), (x0, y1 - 1), (x1 - 1, y1 - 1), (cx, y0), (cx, y1 - 1)):
        sx, sy = int((px - wx0) * scale), int((py - wy0) * scale)
        if 0 <= sx < sw and 0 <= sy < sh and alike(pixels[sx, sy][:3]):
            seeds.append((sx, sy))
    if not seeds:
        return None

    seen = set(seeds)
    queue = deque(seeds)
    min_x, min_y, max_x, max_y = sw, sh, 0, 0
    while queue:
        x, y = queue.popleft()
        min_x, max_x = min(min_x, x), max(max_x, x)
        min_y, max_y = min(min_y, y), max(max_y, y)
        for nx, ny in ((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)):
            if 0 <= nx < sw and 0 <= ny < sh and (nx, ny) not in seen and alike(pixels[nx, ny][:3]):
                seen.add((nx, ny))
                queue.append((nx, ny))

    # Spilling across the window is the page background, not an enclosure.
    if len(seen) > sw * sh * SHAPE_FLOOD_LIMIT:
        return None

    found = (wx0 + int(min_x / scale), wy0 + int(min_y / scale),
             wx0 + int((max_x + 1) / scale), wy0 + int((max_y + 1) / scale))
    found = (min(found[0], x0), min(found[1], y0), max(found[2], x1), max(found[3], y1))
    if (found[2] - found[0]) > w * SHAPE_MAX_W or (found[3] - found[1]) > h * SHAPE_MAX_H:
        return None
    # Only worth taking if it actually gained room to set type in.
    if (found[2] - found[0]) < w * 1.3:
        return None
    return found


def blend(text_box, container, t):
    """Somewhere between the text's own bounds and the shape holding it."""
    return tuple(int(round(a + (b - a) * t)) for a, b in zip(text_box, container))


def overlaps(a, b):
    return a[0] < b[2] and b[0] < a[2] and a[1] < b[3] and b[1] < a[3]


def negotiate(proposals):
    """Shrink neighbouring containers back until none of them intersect.

    Two bubbles can each claim the same pixels, and whichever is drawn last
    wins -- so the loser's text is painted over. Backing both off a little is
    better than letting one erase the other.
    """
    boxes = [container or text for text, container in proposals]
    weight = [1.0 if container else 0.0 for _, container in proposals]

    for _ in range(14):
        clashes = set()
        for i in range(len(boxes)):
            for j in range(i + 1, len(boxes)):
                if overlaps(boxes[i], boxes[j]):
                    clashes.add(i)
                    clashes.add(j)
        if not clashes:
            break
        for i in clashes:
            if weight[i] <= 0:
                continue
            weight[i] = max(0.0, weight[i] - 0.2)
            text, container = proposals[i]
            boxes[i] = blend(text, container, weight[i]) if container else text
    return boxes


def join(lines):
    """CJK had no spaces before the renderer wrapped it; everything else did."""
    out = ""
    for line in lines:
        if out and CJK.search(out[-1]) and CJK.search(line[0]):
            out += line
        else:
            out = (out + " " + line).strip()
    return out


def gemma_prompt(text, source, target):
    """The exact prompt TranslateGemma's chat template builds, by hand."""
    src, tgt = source, target
    # No <bos> here: llama.cpp adds the model's own, and two of them makes the
    # server warn and the model start from a prefix it never saw in training.
    return (
        "<start_of_turn>user\n"
        "You are a professional %s (%s) to %s (%s) translator. Your goal is to "
        "accurately convey the meaning and nuances of the original %s text while "
        "adhering to %s grammar, vocabulary, and cultural sensitivities.\n"
        "Produce only the %s translation, without any additional explanations or "
        "commentary. Please translate the following %s text into %s:\n\n\n%s"
        "<end_of_turn>\n<start_of_turn>model\n"
        % (src, lang_code(src), tgt, lang_code(tgt), src, tgt, tgt, src, tgt, text.strip())
    )


def complete(server, prompt, max_tokens=1024):
    body = json.dumps({"prompt": prompt, "n_predict": max_tokens, "temperature": 0.0,
                       "stop": ["<end_of_turn>"]}).encode()
    request = urllib.request.Request(server.rstrip("/") + "/completion", data=body,
                                     headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(request, timeout=600) as response:
            return json.load(response)["content"].strip()
    except urllib.error.URLError as e:
        raise PipelineError("cannot reach %s (%s)" % (server, e))


def translate_gemma(texts, target, server):
    source = source_language(texts) or "English"
    # The whole page in one request: the lines are context for each other, and
    # it is the only way the model sees a scene rather than a pile of fragments.
    joined = complete(server, gemma_prompt("\n".join(texts), source, target))

    # Keep blank replies in place -- a block that translates to nothing still
    # occupies a line, and dropping it shifts every line after it.
    lines = joined.splitlines()
    while lines and not lines[-1].strip():
        lines.pop()
    out = [line.strip() for line in lines]

    # A line the model merged or split shifts everything after it, and there is
    # no way to tell which one moved, so the page is redone line by line.
    if len(out) != len(texts):
        out = [complete(server, gemma_prompt(text, source, target), 256) for text in texts]
    return out


def translate(texts, target="English", server=MT_SERVER):
    if not texts:
        return []
    numbered = "\n".join("%d. %s" % (i + 1, t) for i, t in enumerate(texts))
    if MT_STYLE == "gemma":
        return translate_gemma(texts, target, server)

    origin = source_language(texts)
    preamble = "The text is in %s. " % origin if origin else ""
    reply = ask(server, [
        {"role": "system", "content": TRANSLATE_SYSTEM.format(target=target, origin=preamble)},
        {"role": "user", "content": numbered},
    ])
    out = [None] * len(texts)
    for line in reply.splitlines():
        m = re.match(r"\s*(\d+)\s*[.):]\s*(.+)$", line)
        if m:
            at = int(m.group(1)) - 1
            if 0 <= at < len(texts):
                out[at] = m.group(2).strip()

    # A line on its own, with a blunter instruction, often lands where the batch
    # drifted. One extra pass is cheap; looping on it would not be.
    for i, text in enumerate(texts):
        if untranslated(text, out[i], target) is None:
            continue
        retry = ask(server, [
            {"role": "system", "content": preamble + RETRY_SYSTEM.format(target=target)},
            {"role": "user", "content": text},
        ], max_tokens=512)
        retry = retry.strip().strip('"')
        if untranslated(text, retry, target) is None:
            out[i] = retry
    return out


def dominant(image, box):
    """The colour the text sits on, sampled from a ring just outside the box."""
    x0, y0, x1, y1 = box
    pad = max(2, (y1 - y0) // 4)
    left, top = max(0, x0 - pad), max(0, y0 - pad)
    outer = image.crop((left, top, min(image.width, x1 + pad), min(image.height, y1 + pad)))
    inner = (x0 - left, y0 - top, x1 - left, y1 - top)

    counts = {}
    pixels = outer.load()
    for x in range(outer.width):
        for y in range(outer.height):
            if inner[0] <= x < inner[2] and inner[1] <= y < inner[3]:
                continue
            r, g, b = pixels[x, y][:3]
            key = (r >> 4, g >> 4, b >> 4)
            counts[key] = counts.get(key, 0) + 1
    if not counts:
        return (255, 255, 255)
    r, g, b = max(counts, key=counts.get)
    return (r * 17, g * 17, b * 17)


def ink_for(fill):
    luminance = (0.299 * fill[0] + 0.587 * fill[1] + 0.114 * fill[2]) / 255
    return (17, 17, 17) if luminance > 0.55 else (245, 245, 245)


def load_font(size):
    for path in FONTS:
        try:
            return ImageFont.truetype(path, size)
        except OSError:
            continue
    return ImageFont.load_default()


def wrap(draw, text, font, width):
    lines, current = [], ""
    for word in text.split():
        trial = (current + " " + word).strip()
        if not current or draw.textlength(trial, font=font) <= width:
            current = trial
        else:
            lines.append(current)
            current = word
    if current:
        lines.append(current)
    return lines


def draw_block(draw, box, text, fill, ink, outline=None):
    x0, y0, x1, y1 = box
    width, height = x1 - x0, y1 - y0
    # No fill when the region was inpainted: the background is already restored
    # and a flat rectangle would undo the work.
    if fill is not None:
        draw.rectangle(box, fill=fill)
    if not text.strip():
        return

    # Largest size that still fits, found by halving rather than stepping.
    low, high, best = 6, max(7, height), None
    while low <= high:
        mid = (low + high) // 2
        font = load_font(mid)
        lines = wrap(draw, text, font, width)
        if len(lines) * (mid + 2) <= height and \
           all(draw.textlength(l, font=font) <= width for l in lines):
            best, low = (font, lines, mid), mid + 1
        else:
            high = mid - 1
    if best is None:
        font = load_font(6)
        best = (font, wrap(draw, text, font, width), 6)

    font, lines, size = best
    # Over restored background there is no flat panel behind the words, so they
    # get a thin rim of the opposite colour to stay readable on anything.
    stroke = max(1, size // 12) if outline else 0
    y = y0 + max(0, (height - len(lines) * (size + 2)) // 2)
    for line in lines:
        offset = max(0, (width - draw.textlength(line, font=font)) // 2)
        draw.text((x0 + offset, y), line, font=font, fill=ink,
                  stroke_width=stroke, stroke_fill=outline)
        y += size + 2


def run(image, target="English", ocr_server=OCR_SERVER, mt_server=MT_SERVER, pad=2,
        erase="off", shapes=True):
    """Returns the translated image and a record of what happened to each block."""
    image = image.convert("RGB")
    source = image.copy()
    timings = {}

    started = time.time()
    lines = spot(image, ocr_server)
    timings["read_ms"] = int((time.time() - started) * 1000)

    blocks = group(lines)
    originals = [join(b["lines"]) for b in blocks]

    started = time.time()
    translations = translate(originals, target, mt_server)
    timings["translate_ms"] = int((time.time() - started) * 1000)

    # Decide per block how the original gets removed. A flat fill is free and
    # indistinguishable on a plain background; only textured ones are worth the
    # model, which costs a second or so each.
    keep = []
    for block, original, translated in zip(blocks, originals, translations):
        if not untranslated(original, translated, target):
            keep.append(block)

    busy = []
    if erase != "off" and keep:
        try:
            import inpaint
            if inpaint.available():
                busy = [tuple(b["box"]) for b in keep
                        if inpaint.busyness(source, b["box"]) >= inpaint.BUSY_STD]
                if busy:
                    started = time.time()
                    image = inpaint.erase(image, busy)
                    timings["erase_ms"] = int((time.time() - started) * 1000)
        except ImportError:
            pass
    timings["erased"] = len(busy)
    busy_set = set(busy)

    # Every block's final box is settled before anything is drawn, so that
    # containers can be negotiated against each other rather than first-come.
    proposals = []
    for block, original, translated in zip(blocks, originals, translations):
        x0, y0, x1, y1 = block["box"]
        # A hair of padding: the fill has to cover the glyphs' anti-aliased edges
        # or they survive as a grey outline around the replacement.
        padded = (max(0, x0 - pad), max(0, y0 - pad),
                  min(image.width, x1 + pad), min(image.height, y1 + pad))
        container = None
        if shapes and translated and not untranslated(original, translated, target):
            found = container_box(source, block["box"], dominant(source, block["box"]))
            if found:
                allowance = growth_allowance(translated)
                if (found[2] - found[0]) <= (x1 - x0) * allowance:
                    container = found
        proposals.append((padded, container))
    layout = negotiate(proposals)

    started = time.time()
    draw = ImageDraw.Draw(image)
    report = []
    for index, (block, original, translated) in enumerate(zip(blocks, originals, translations)):
        box = layout[index]

        # Painting a box over the original to show text that was never
        # translated is strictly worse than leaving the original visible.
        skipped = untranslated(original, translated, target)
        if skipped:
            report.append({"box": list(box), "src": original, "en": translated or "",
                           "skipped": skipped, "inpainted": False,
                           "vertical": bool(block.get("vertical"))})
            continue

        fill = dominant(source, block["box"])
        inpainted = tuple(block["box"]) in busy_set
        ink = ink_for(fill)
        draw_block(draw, box, translated, None if inpainted else fill, ink,
                   outline=fill if inpainted else None)
        report.append({"box": list(box), "src": original, "en": translated,
                       "skipped": None, "inpainted": inpainted,
                       "vertical": bool(block.get("vertical"))})
    timings["render_ms"] = int((time.time() - started) * 1000)
    timings["lines"] = len(lines)

    return image, report, timings
