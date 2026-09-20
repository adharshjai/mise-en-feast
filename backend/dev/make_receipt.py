"""Render a synthetic grocery receipt to dev/receipt.png so POST /scan can be
tried without a real photo.

    .venv/bin/python dev/make_receipt.py

Pillow only. 900x1400 PNG: white paper on a grey table, monospace thermal print,
a little sensor noise, a touch of blur, uneven light and a one-degree tilt.
"""

from __future__ import annotations

import random
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw, ImageFilter, ImageFont

OUT = Path(__file__).with_name("receipt.png")
W, H = 900, 1400
TABLE = (168, 162, 154)
PAPER = (252, 251, 247)
INK = (28, 26, 24)

FONT_CANDIDATES = [
    "/System/Library/Fonts/Supplemental/Courier New Bold.ttf",  # macOS
    "/System/Library/Fonts/Supplemental/Courier New.ttf",
    "/System/Library/Fonts/Menlo.ttc",
    "/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf",  # Debian/Ubuntu
    "/usr/share/fonts/truetype/liberation/LiberationMono-Bold.ttf",
    "C:/Windows/Fonts/courbd.ttf",  # Windows
]

STORE = "WHOLE FOODS MARKET"
HEADER = [
    "1265 SANTA MONICA BLVD",
    "LOS ANGELES CA 90404",
    "(310) 555-0142",
    "",
    "09/18/2026  06:42 PM   REG 4  CSHR 117",
    "",
]
ITEMS = [
    ("ORG SPINACH 5OZ", "3.49"),
    ("GV MLK 1GAL", "3.98"),
    ("EGGS LG DZ", "4.29"),
    ("CHKN THIGH 1.4LB", "8.12"),
    ("GARLIC", "0.89"),
    ("SPAGHETTI 1LB", "1.99"),
    ("ROMA TOM 6", "3.24"),
    ("BASIL BNCH", "2.49"),
    ("JASMINE RICE 2LB", "4.99"),
    ("PARM REG 8OZ", "6.99"),
    ("CUCUMBER 2", "1.58"),
    ("SPRNG MX ORG 5OZ", "4.49"),
    ("PAPER TWL 6PK", "9.99"),
    ("AA BATT 8PK", "7.65"),
]
TOTAL = "64.18"  # the 14 lines above really do sum to this
FOOTER = [
    "ITEMS SOLD 14",
    "",
    "VISA  ************4471",
    "APPROVED  AUTH 052117",
    "",
    "THANK YOU FOR SHOPPING WITH US",
    "WHOLEFOODSMARKET.COM",
]


def load_font(size: int):
    for path in FONT_CANDIDATES:
        try:
            return ImageFont.truetype(path, size)
        except OSError:
            continue
    return ImageFont.load_default(size)  # Pillow >= 10.1 ships a scalable fallback


def main() -> None:
    random.seed(20260918)  # same picture every run
    img = Image.new("RGB", (W, H), TABLE)
    draw = ImageDraw.Draw(img)

    # Paper with a soft shadow and torn top/bottom edges.
    left, top, right, bottom = 84, 36, 816, 1364
    draw.rectangle((left + 6, top + 8, right + 6, bottom + 8), fill=(132, 127, 120))
    draw.rectangle((left, top, right, bottom), fill=PAPER)
    for x in range(left, right, 12):
        draw.polygon([(x, top), (x + 6, top - 5), (x + 12, top)], fill=PAPER)
        draw.polygon([(x, bottom), (x + 6, bottom + 5), (x + 12, bottom)], fill=PAPER)

    font = load_font(26)
    big = load_font(38)
    x0, y = left + 44, top + 44

    def put(text: str, f=font, center: bool = False, bold: bool = False) -> None:
        nonlocal y
        jitter = random.randint(-1, 1)
        shade = random.randint(0, 40)  # thermal print is never perfectly even
        color = tuple(c + shade for c in INK)
        x = (left + right - draw.textlength(text, font=f)) / 2 + jitter if center else x0 + jitter
        draw.text((x, y), text, font=f, fill=color)
        if bold:
            draw.text((x + 1, y), text, font=f, fill=color)
        y += int(f.size * 1.35)

    put(STORE, big, center=True, bold=True)
    for line in HEADER:
        put(line, center=True)
    put("-" * 40)
    for name, price in ITEMS:
        put(f"{name:<32}{price:>8}")  # 40-column receipt: name left, line total right
    put("-" * 40)
    put(f"{'SUBTOTAL':<32}{TOTAL:>8}")
    put(f"{'TAX':<32}{'0.00':>8}")
    put(f"{'TOTAL':<32}{TOTAL:>8}", bold=True)
    put("")
    for line in FOOTER:
        put(line, center=True)

    # A barcode-ish strip at the bottom.
    y += 8
    bx = left + 120
    while bx < right - 120:
        bw = random.choice((2, 2, 3, 4, 6))
        draw.rectangle((bx, y, bx + bw, y + 54), fill=INK)
        bx += bw + random.choice((2, 3, 4, 6))

    # Camera: one-degree tilt, slight softness, uneven light, sensor noise.
    img = img.rotate(1.0, resample=Image.BICUBIC, fillcolor=TABLE)
    img = img.filter(ImageFilter.GaussianBlur(0.6))
    vignette = Image.radial_gradient("L").resize((W, H)).point(lambda v: 255 - v * 60 // 255).convert("RGB")
    img = ImageChops.multiply(img, vignette)
    noise = Image.effect_noise((W, H), 9).convert("RGB")  # gaussian noise centred on 128
    img = ImageChops.add(img, noise, scale=1.0, offset=-128)

    # 32-colour palette: the grain works as dither so nothing visible changes,
    # and the PNG (and so the base64 request body) is about a third of the size.
    img = img.quantize(32, method=Image.Quantize.MEDIANCUT)
    img.save(OUT, format="PNG", optimize=True)
    print(f"wrote {OUT} ({img.width}x{img.height}, {OUT.stat().st_size / 1024:.0f} KB)")


if __name__ == "__main__":
    main()
