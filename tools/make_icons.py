"""Draws the app icons: a rising price line on a dark tile."""
from PIL import Image, ImageDraw


def icon(size, inset=0.0):
    s = size * 4
    im = Image.new("RGB", (s, s), "#0F1115")
    d = ImageDraw.Draw(im)
    m = s * (0.2 + inset)
    pts = [(m, s - m * 1.15), (s * 0.40, s * 0.52), (s * 0.56, s * 0.64), (s - m, m * 1.15)]
    d.line(pts, fill="#FFFFFF", width=int(s * 0.075), joint="curve")
    r = s * 0.06
    for x, y in (pts[0], pts[-1]):
        d.ellipse([x - r, y - r, x + r, y + r], fill="#FFFFFF")
    x, y = pts[-1]
    r2 = s * 0.034
    d.ellipse([x - r2, y - r2, x + r2, y + r2], fill="#2F6BFF")
    return im.resize((size, size), Image.LANCZOS)


icon(192).save("web/icons/icon-192.png")
icon(512, 0.06).save("web/icons/icon-512.png")
icon(180).save("web/icons/apple-touch-icon.png")
print("icons written")
