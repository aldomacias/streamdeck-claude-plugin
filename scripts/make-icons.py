"""Genera los iconos del plugin (PNG) con Pillow. Diseño propio: sin logos de terceros."""
from pathlib import Path
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent / "com.aldomacias.claude-deck.sdPlugin" / "imgs"
BG = (30, 30, 34, 255)
PURPLE = (182, 173, 255, 255)
GREEN = (52, 211, 153, 255)
AMBER = (251, 191, 36, 255)
TRACK = (70, 70, 78, 255)


def canvas(size, bg=BG, radius=None):
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    r = radius if radius is not None else size // 6
    d.rounded_rectangle((0, 0, size - 1, size - 1), radius=r, fill=bg)
    return img, d


def session_icon(size, with_bg=True):
    img, d = canvas(size) if with_bg else (Image.new("RGBA", (size, size), (0, 0, 0, 0)), None)
    d = ImageDraw.Draw(img)
    r = max(2, size // 9)
    cy = size // 2
    xs = [size * 0.28, size * 0.5, size * 0.72]
    cols = [PURPLE, PURPLE, (120, 112, 200, 255)]
    for x, c in zip(xs, cols):
        d.ellipse((x - r, cy - r, x + r, cy + r), fill=c)
    return img


def usage_icon(size, with_bg=True):
    img, d = canvas(size) if with_bg else (Image.new("RGBA", (size, size), (0, 0, 0, 0)), None)
    d = ImageDraw.Draw(img)
    w = max(2, size // 10)
    pad = size * 0.2
    box = (pad, pad, size - pad, size - pad)
    d.arc(box, 0, 360, fill=TRACK, width=w)
    d.arc(box, -90, 160, fill=GREEN, width=w)
    return img


def category_icon(size):
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    w = max(2, size // 9)
    pad = size * 0.12
    d.arc((pad, pad, size - pad, size - pad), -90, 200, fill=(235, 235, 240, 255), width=w)
    r = max(2, size // 8)
    d.ellipse((size / 2 - r, size / 2 - r, size / 2 + r, size / 2 + r), fill=(235, 235, 240, 255))
    return img


def save(img, path):
    path.parent.mkdir(parents=True, exist_ok=True)
    img.save(path)


for name, fn in (("session", session_icon), ("usage", usage_icon)):
    save(fn(20), ROOT / "actions" / name / "icon.png")
    save(fn(40), ROOT / "actions" / name / "icon@2x.png")
    save(fn(72), ROOT / "actions" / name / "key.png")
    save(fn(144), ROOT / "actions" / name / "key@2x.png")

save(category_icon(28), ROOT / "plugin" / "category-icon.png")
save(category_icon(56), ROOT / "plugin" / "category-icon@2x.png")
mk, _ = canvas(288, radius=56)
mk.alpha_composite(usage_icon(288, with_bg=False))
save(mk, ROOT / "plugin" / "marketplace.png")
mk2, _ = canvas(576, radius=112)
mk2.alpha_composite(usage_icon(576, with_bg=False))
save(mk2, ROOT / "plugin" / "marketplace@2x.png")
print("iconos generados en", ROOT)
