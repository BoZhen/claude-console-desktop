"""Draws the app icon: a C drawn in square pixels and a text cursor, as 3D blocks in
matte clay on a light tile, turned a little so their tops and sides show. The C is an
orange pixel letter 8 x 9 pixels, the cursor a dark block standing in front of it.
Both are rendered by ray marching signed distance functions: a key light from the upper left and a weak fill, soft shadows, ambient
occlusion, and the shadow they cast on the tile. The tile follows the macOS grid (an
824 px rounded square on 1024, radius 185) with a gradient, a light top edge and a
shadow below.

Writes assets/icon.png (1024 px: the window icon, and the source of the Linux sizes)
and assets/icon.icns (macOS).

    python3 scripts/make-icons.py      (with numpy and Pillow installed; about 15 s)

Your own builds can carry another icon: assets/local/icon.png and icon.icns, which git
ignores, are used by the build and install scripts unless they build with --public.
"""
import math
import os

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(HERE, "assets")
SIZE, S = 1024, 2048          # the icon, and the size it is rendered at before scaling down
TILE, RADIUS = 824, 185       # macOS grid
INSET = (SIZE - TILE) // 2


def lin(hexcolour):
    """sRGB "#rrggbb" to linear RGB, the space light is added in."""
    return (np.array([int(hexcolour[i:i + 2], 16) for i in (1, 3, 5)], np.float32) / 255) ** 2.2


# ------------------------------------------------------------------ the 3D scene
# World units: 1 = 100 px of the 1024 px icon, origin at its centre, y up, the
# viewer on +z looking straight down -z (orthographic).

PIXEL, LEFT, TOP = 0.56, -2.24, 2.52        # one pixel of the letter; the grid's top left corner


def block(c0, c1, r0, r1, z=0.0, half_depth=0.28, rounding=0.012):
    """A box over pixel columns c0..c1 and rows r0..r1: (centre, half sizes, rounding)."""
    centre = np.array([LEFT + (c0 + c1 + 1) / 2 * PIXEL, TOP - (r0 + r1 + 1) / 2 * PIXEL, z], np.float32)
    return centre, ((c1 - c0 + 1) * PIXEL / 2, (r1 - r0 + 1) * PIXEL / 2, half_depth), rounding


# The C: each bar one block, so no seam runs along it, and the pixel steps at its
# corners as small blocks beside it. Little rounding: neighbouring blocks must meet
# without a groove.
C_BLOCKS = [block(2, 7, 0, 1), block(1, 1, 1, 1), block(0, 1, 2, 6), block(1, 1, 7, 7), block(2, 7, 7, 8)]
CURSOR_BLOCK = block(4, 5, 3, 5, z=0.30, half_depth=0.2, rounding=0.06)    # in front of the C
TILT = (12, -22)              # degrees about x, then y: shows the tops and sides of the blocks
MATERIALS = [
    dict(colour=lin("#DC7B5A"), ks=0.12, p=12, rim=0.12, amb=0.32),     # the C: matte clay
    dict(colour=lin("#2A2523"), ks=0.45, p=50, rim=0.20, amb=0.50),     # the cursor: dark, a little gloss
]
KEY, FILL = np.array([-0.55, 0.65, 0.75], np.float32), np.array([0.6, -0.25, 0.55], np.float32)
KEY /= np.linalg.norm(KEY)
FILL /= np.linalg.norm(FILL)


def rotation(ax, ay):
    a, b = math.radians(ax), math.radians(ay)
    rx = np.array([[1, 0, 0], [0, math.cos(a), -math.sin(a)], [0, math.sin(a), math.cos(a)]], np.float32)
    ry = np.array([[math.cos(b), 0, math.sin(b)], [0, 1, 0], [-math.sin(b), 0, math.cos(b)]], np.float32)
    return rx @ ry


ROT = rotation(*TILT)


def sd_box(p, centre, half, rounding):
    """Distance to a rounded box."""
    q = np.abs(p - centre) - (np.array(half, np.float32) - rounding)
    return np.linalg.norm(np.maximum(q, 0), axis=1) + np.minimum(q.max(axis=1), 0) - rounding


def sd_c(p):
    return np.min(np.stack([sd_box(p, *b) for b in C_BLOCKS], axis=1), axis=1)


def sd_cursor(p):
    return sd_box(p, *CURSOR_BLOCK)


def parts(p):
    q = p @ ROT                     # world to object space
    return np.stack([sd_c(q), sd_cursor(q)], axis=1)


def sdf(p):
    return parts(p).min(axis=1)


def render_object():
    """RGBA, S x S: the C and the cursor, shaded, on transparency."""
    ys, xs = np.mgrid[0:S, 0:S].astype(np.float32)
    x = ((xs.ravel() + 0.5) / S * SIZE - SIZE / 2) / 100
    y = -((ys.ravel() + 0.5) / S * SIZE - SIZE / 2) / 100
    rays = np.nonzero(x ** 2 + y ** 2 < 3.6 ** 2)[0]        # only those that can meet the object
    origin = np.stack([x[rays], y[rays], np.full(len(rays), 6, np.float32)], axis=1)
    down = np.array([0, 0, -1], np.float32)
    t = np.zeros(len(rays), np.float32)
    live, hit = np.ones(len(rays), bool), np.zeros(len(rays), bool)
    for _ in range(160):
        a = np.nonzero(live)[0]
        if not len(a):
            break
        d = sdf(origin[a] + down * t[a, None])
        t[a] += d
        h = d < 5e-4
        hit[a[h]], live[a[h]] = True, False
        live[a[t[a] > 12]] = False
    p = origin[hit] + down * t[hit, None]
    e = 1e-3
    n = np.stack([sdf(p + [e, 0, 0]) - sdf(p - [e, 0, 0]),
                  sdf(p + [0, e, 0]) - sdf(p - [0, e, 0]),
                  sdf(p + [0, 0, e]) - sdf(p - [0, 0, e])], axis=1)
    n /= np.linalg.norm(n, axis=1, keepdims=True)
    which = parts(p).argmin(axis=1)
    ao = np.ones(len(p), np.float32)              # ambient occlusion along the normal
    for i, h in enumerate((0.04, 0.10, 0.18, 0.28, 0.40)):
        ao -= (h - sdf(p + n * h)) * (0.75 ** i) * 1.6
    ao = np.clip(ao, 0, 1)
    shadow, ts = np.ones(len(p), np.float32), np.full(len(p), 0.02, np.float32)
    for _ in range(48):                           # soft shadow toward the key light
        d = sdf(p + n * 0.004 + KEY * ts[:, None])
        shadow = np.minimum(shadow, 10 * d / ts)
        ts += np.clip(d, 0.02, 0.25)
    shadow = np.clip(shadow, 0, 1)
    view = np.array([0, 0, 1], np.float32)
    half = (KEY + view) / np.linalg.norm(KEY + view)
    colour = np.zeros((len(p), 3), np.float32)
    for m, mat in enumerate(MATERIALS):
        k = which == m
        nk = n[k]
        diffuse = np.clip(nk @ KEY, 0, 1) * shadow[k] + 0.28 * np.clip(nk @ FILL, 0, 1)
        spec = mat["ks"] * np.clip(nk @ half, 0, 1) ** mat["p"] * shadow[k]
        rim = (1 - np.clip(nk @ view, 0, 1)) ** 3 * mat["rim"]
        colour[k] = (mat["colour"] * (mat["amb"] * ao[k] + 0.95 * diffuse)[:, None] + spec[:, None]
                     + (rim * ao[k])[:, None] * mat["colour"] * 1.4)
    img = np.zeros((S * S, 4), np.float32)
    img[rays[hit], :3] = np.clip(colour, 0, 1) ** (1 / 2.2)
    img[rays[hit], 3] = 1
    return Image.fromarray((img.reshape(S, S, 4) * 255).astype(np.uint8))


# ------------------------------------------------------------------ the tile

def rounded_mask(size, box, radius, width=0):
    m = Image.new("L", (size, size), 0)
    ImageDraw.Draw(m).rounded_rectangle(box, radius=radius, fill=None if width else 255,
                                        outline=255 if width else None, width=width)
    return m


def tile():
    """RGBA, S x S: the light tile with its gradient, top edge and shadow below."""
    k = S / SIZE
    box = [INSET * k, INSET * k, (SIZE - INSET) * k, (SIZE - INSET) * k]
    canvas = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    # shadow below the tile (macOS draws none; the icon carries its own)
    shade = rounded_mask(S, [box[0], box[1] + 14 * k, box[2], box[3] + 14 * k], RADIUS * k)
    shade = shade.filter(ImageFilter.GaussianBlur(16 * k)).point(lambda v: int(v * 0.32))
    canvas.paste((0, 0, 0, 255), (0, 0), shade)
    # the tile: a vertical gradient
    top, bottom = np.array([0xFB, 0xF9, 0xF4], np.float32), np.array([0xE3, 0xDE, 0xD2], np.float32)
    f = np.linspace(0, 1, S, dtype=np.float32)[:, None, None]
    grad = Image.fromarray((top + (bottom - top) * f).repeat(S, axis=1).astype(np.uint8))
    canvas.paste(grad, (0, 0), rounded_mask(S, box, RADIUS * k))
    # a light edge along the top and a faint dark one along the bottom
    edge = np.asarray(rounded_mask(S, [b + (2 * k if i < 2 else -2 * k) for i, b in enumerate(box)],
                                   (RADIUS - 2) * k, width=int(5 * k))).astype(np.float32) / 255
    rows = np.linspace(0, 1, S, dtype=np.float32)
    light = np.clip(1 - rows / 0.10, 0, 1) * 0.9
    dark = np.clip((rows - 0.88) / 0.12, 0, 1) * 0.10
    arr = np.asarray(canvas).astype(np.float32)
    a = (edge * light[:, None])[..., None]
    arr[..., :3] = arr[..., :3] * (1 - a) + 255 * a
    arr[..., :3] *= 1 - (edge * dark[:, None])[..., None]
    return Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8))


def icon():
    obj = render_object()
    base = tile()
    k = S / SIZE
    # the shadow the object casts on the tile: its silhouette, moved down right, blurred
    sil = Image.new("L", (S, S), 0)
    sil.paste(obj.split()[3], (int(26 * k), int(44 * k)))
    sil = sil.filter(ImageFilter.GaussianBlur(22 * k))
    arr = np.asarray(base).astype(np.float32)
    arr[..., :3] *= 1 - 0.30 * np.asarray(sil).astype(np.float32)[..., None] / 255
    base = Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8))
    base.alpha_composite(obj)
    return base.resize((SIZE, SIZE), Image.Resampling.LANCZOS)


if __name__ == "__main__":
    os.makedirs(OUT, exist_ok=True)
    im = icon()
    im.save(os.path.join(OUT, "icon.png"))
    im.save(os.path.join(OUT, "icon.icns"), sizes=[(16, 16), (32, 32), (64, 64), (128, 128), (256, 256), (512, 512), (1024, 1024)])
    print("wrote assets/icon.png, assets/icon.icns")
