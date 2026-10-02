"""Draws the app icons (an original lens-and-shell mark) with Pillow."""
from PIL import Image, ImageDraw

def icon(size, pad_ratio=0.0):
    s = size * 4
    im = Image.new("RGB", (s, s), "#D61F2C")
    d = ImageDraw.Draw(im)
    # lower band and notch line
    d.polygon([(0, s * .74), (s * .46, s * .74), (s * .60, s * .62), (s, s * .62), (s, s), (0, s)], fill="#9E1220")
    d.line([(0, s * .74), (s * .46, s * .74), (s * .60, s * .62), (s, s * .62)], fill="black", width=int(s * .03))
    # lens
    cx, cy, r = s * .40, s * .38, s * .25 * (1 - pad_ratio)
    d.ellipse([cx - r - s * .035, cy - r - s * .035, cx + r + s * .035, cy + r + s * .035], fill="black")
    d.ellipse([cx - r, cy - r, cx + r, cy + r], fill="white")
    r2 = r * .80
    d.ellipse([cx - r2, cy - r2, cx + r2, cy + r2], fill="#37C8F4")
    r3 = r * .28
    d.ellipse([cx - r * .45 - r3, cy - r * .45 - r3, cx - r * .45 + r3, cy - r * .45 + r3], fill="#D9F6FF")
    # LEDs
    for i, col in enumerate(["#FF5A5F", "#FFD400", "#4BD66B"]):
        x, y, lr = s * (.72 + i * .085), s * .2, s * .03
        d.ellipse([x - lr - s * .008, y - lr - s * .008, x + lr + s * .008, y + lr + s * .008], fill="black")
        d.ellipse([x - lr, y - lr, x + lr, y + lr], fill=col)
    return im.resize((size, size), Image.LANCZOS)

icon(192).save("web/icons/icon-192.png")
icon(512, 0.12).save("web/icons/icon-512.png")
icon(180).save("web/icons/apple-touch-icon.png")
print("icons written")
