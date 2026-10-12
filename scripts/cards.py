# /// script
# requires-python = ">=3.13"
# dependencies = ["pillow>=11"]
# ///
"""Render a social card for every blog post into assets/cards/<slug>.png.

Run before `zine` or `zine release`:

    uv run scripts/cards.py
"""

import re
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
POSTS = ROOT / "content" / "blog"
OUT = ROOT / "assets" / "cards"
FONTS = Path(__file__).resolve().parent / "fonts"
LOGO = ROOT / "assets" / "favicon.svg"

WIDTH, HEIGHT = 1200, 630
MARGIN = 80
BACKGROUND = "#111318"
ACCENT = "#4f46e5"
ACCENT_SOFT = "#a5b4fc"
TEXT = "#f3f4f6"
MUTED = "#a6abb4"

TITLE_SIZES = (72, 64, 56)
TITLE_MAX_LINES = 3
TITLE_WIDTH = 920
LOGO_SCALE = 8


def font(weight: str, size: int) -> ImageFont.FreeTypeFont:
    return ImageFont.truetype(FONTS / f"Inter-{weight}.ttf", size)


def front_matter(path: Path) -> dict[str, str]:
    text = path.read_text()
    header = text.split("---", 2)[1]
    return dict(re.findall(r'^\.(\w+)\s*=\s*"((?:[^"\\]|\\.)*)"', header, re.M))


def wrap(draw: ImageDraw.ImageDraw, text: str, face: ImageFont.FreeTypeFont) -> list[str]:
    lines: list[str] = []
    for word in text.split():
        candidate = f"{lines[-1]} {word}" if lines else word
        if lines and draw.textlength(candidate, font=face) <= TITLE_WIDTH:
            lines[-1] = candidate
        else:
            lines.append(word)
    return lines


def draw_logo(draw: ImageDraw.ImageDraw) -> None:
    """Redraw the pixel-art BO'M mark from the favicon at card scale."""
    svg = LOGO.read_text()
    glyphs = svg[svg.index('<g fill="#a5b4fc">') :]
    for x, y in re.findall(r'<rect x="(\d+)" y="(\d+)"', glyphs):
        left = MARGIN + (int(x) - 1) * LOGO_SCALE
        top = 60 + (int(y) - 5) * LOGO_SCALE
        draw.rectangle((left, top, left + LOGO_SCALE - 1, top + LOGO_SCALE - 1), fill=ACCENT_SOFT)


def render(title: str) -> Image.Image:
    image = Image.new("RGB", (WIDTH, HEIGHT), BACKGROUND)
    draw = ImageDraw.Draw(image)
    draw.rectangle((0, 0, WIDTH, 9), fill=ACCENT)
    draw_logo(draw)

    for size in TITLE_SIZES:
        face = font("SemiBold", size)
        lines = wrap(draw, title, face)
        if len(lines) <= TITLE_MAX_LINES:
            break
    line_height = round(size * 1.25)
    top = 315 - line_height * len(lines) // 2
    for i, line in enumerate(lines):
        draw.text((MARGIN, top + i * line_height), line, font=face, fill=TEXT)

    draw.text(
        (MARGIN, 552), "Ben O'Mahony", font=font("SemiBold", 26), fill=ACCENT_SOFT, anchor="lm"
    )
    draw.text(
        (WIDTH - MARGIN, 552), "benomahony.com", font=font("Regular", 26), fill=MUTED, anchor="rm"
    )
    return image


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    for post in sorted(POSTS.glob("*.smd")):
        meta = front_matter(post)
        if meta.get("layout") != "post.shtml":
            continue
        render(meta["title"]).save(OUT / f"{post.stem}.png", optimize=True)
        print(f"assets/cards/{post.stem}.png")


if __name__ == "__main__":
    main()
