"""Hand-drawn pixel art (character maps) for sizes where automatic downscaling of AI art
is not crisp: mark in 32x32 and 16x16 ("hinting" of the AI drawing, with the same
palette) and the "Habblaud" sign and og-image text with a proportional bitmap font (5x7, with accents).

Reference drawing is the selected take of `logo-mark` (front-facing building, teal roof,
wood bands, lit yellow windows and two blue screens, glass door with awning).
"""

from __future__ import annotations

import numpy as np
from PIL import Image

# Palette sampled from native AI art (logo-mark, already quantized): one shade per material.
PALETTE: dict[str, str] = {
    "O": "#111931",  # navy outline
    "J": "#0e4060",  # roof outline
    "L": "#d2efec",  # light roof rim / glass shine
    "R": "#3e8da0",  # roof
    "U": "#61bac5",  # roof (highlight) / awning
    "F": "#c9bab2",  # facade
    "H": "#eadacb",  # facade (highlight)
    "f": "#8f7b7f",  # facade (shadow)
    "K": "#3e526f",  # window frame
    "Y": "#fee074",  # lit window
    "y": "#fab63f",  # lit window (shadow)
    "S": "#20b6fd",  # blue screen
    "s": "#0b6bf0",  # blue screen (shadow)
    "W": "#db954f",  # wood / pot
    "w": "#ecb761",  # wood (highlight)
    "b": "#7c4116",  # wood (shadow)
    "u": "#b05b39",  # pot (shadow) / door frame
    "p": "#692a18",  # pot (outline)
    "G": "#67c53d",  # leaf
    "g": "#198834",  # leaf (mid-tone)
    "q": "#033e1f",  # leaf (outline)
    "D": "#a3d4e5",  # door glass
}

# Mark 32x32: flat roof with light rim, pot on right corner, wood bands, 6x5 windows
# with frame (two blue screens on 2nd floor, left and center) and glass door with awning.
MARK_32 = [
    "....................qGq.qGq.....",
    "...................qGgGqGgGq....",
    "...................qgpWWWpgq....",
    "..JJJJJJJJJJJJJJJJJJJpWWupJJJJ..",
    ".JLRRRRRRRRRRRRRRRRRRRpppRRRRLJ.",
    "JLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLJ",
    "JURRRRRRRRRRRRRRRRRRRRRRRRRRRRUJ",
    "JJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJ",
    "..OffffffffffffffffffffffffffO..",
    "..OHFKKKKKKFFKKKKKKFFKKKKKKFHO..",
    "..OHFKYYYYKFFKYYYYKFFKYYYYKFHO..",
    "..OHFKYYYYKFFKYYYYKFFKYYYYKFHO..",
    "..OHFKyyyyKFFKyyyyKFFKyyyyKFHO..",
    "..OHFKKKKKKFFKKKKKKFFKKKKKKFHO..",
    "..OHFffffffFFffffffFFffffffFHO..",
    ".bwwwwwwwwwwwwwwwwwwwwwwwwwwwwb.",
    ".bbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.",
    "..OffffffffffffffffffffffffffO..",
    "..OHFKKKKKKFFKKKKKKFFKKKKKKFHO..",
    "..OHFKSSSSKFFKSSSSKFFKYYYYKFHO..",
    "..OHFKSSSSKFFKSSSSKFFKYYYYKFHO..",
    "..OHFKssssKFFKssssKFFKyyyyKFHO..",
    "..OHFKKKKKKFFKKKKKKFFKKKKKKFHO..",
    "..OHFffffffFFffffffFFffffffFHO..",
    ".bwwwwwwwwwJJJJJJJJJJwwwwwwwwwb.",
    ".bbbbbbbbbbJUUUUUUUUJbbbbbbbbbb.",
    "..OHFKKKKKKJJJJJJJJJJKKKKKKFHO..",
    "..OHFKYYYYKFuDLDDLDuFKYYYYKFHO..",
    "..OHFKYYYYKFuLDKKDLuFKYYYYKFHO..",
    "..OHFKyyyyKFuDDKKDDuFKyyyyKFHO..",
    "..OHFKKKKKKFuDDKKDDuFKKKKKKFHO..",
    "..OOOOOOOOOOOOOOOOOOOOOOOOOOOO..",
]

# Mark 16x16 (favicon): same color masses, 2x2 frameless windows.
MARK_16 = [
    ".........qGgGq..",
    "..........pWWp..",
    "..JJJJJJJJJJJJ..",
    ".JLLLLLLLLLLLLJ.",
    "JRRRRRRRRRRRRRRJ",
    "JJJJJJJJJJJJJJJJ",
    ".OffffffffffffO.",
    ".OHYYFFYYFFYYHO.",
    ".OHyyFFyyFFyyHO.",
    "bwwwwwwwwwwwwwwb",
    ".OHSSFFSSFFYYHO.",
    ".OHssFFssFFyyHO.",
    "bwwwwJUUUUJwwwwb",
    ".OHYYFuDLuFYYHO.",
    ".OHyyFuLDuFyyHO.",
    ".OOOOOOOOOOOOOO.",
]

# Proportional bitmap font (5x7 uppercase). 9-row cell: uppercase and ascenders on
# rows 0-6, 5-row x-height (2-6), descenders on rows 7-8, and lowercase accents
# on rows 0-1. 7-row glyphs have no descender. Letter spacing: 1px.
_GLYPHS: dict[str, list[str]] = {
    "A": [".###.", "#...#", "#...#", "#####", "#...#", "#...#", "#...#"],
    "B": ["####.", "#...#", "#...#", "####.", "#...#", "#...#", "####."],
    "C": [".###.", "#...#", "#....", "#....", "#....", "#...#", ".###."],
    "D": ["####.", "#...#", "#...#", "#...#", "#...#", "#...#", "####."],
    "E": ["#####", "#....", "#....", "####.", "#....", "#....", "#####"],
    "F": ["#####", "#....", "#....", "####.", "#....", "#....", "#...."],
    "G": [".###.", "#...#", "#....", "#.###", "#...#", "#...#", ".####"],
    "H": ["#...#", "#...#", "#...#", "#####", "#...#", "#...#", "#...#"],
    "I": ["###", ".#.", ".#.", ".#.", ".#.", ".#.", "###"],
    "J": ["..###", "...#.", "...#.", "...#.", "#..#.", "#..#.", ".##.."],
    "K": ["#...#", "#..#.", "#.#..", "##...", "#.#..", "#..#.", "#...#"],
    "L": ["#....", "#....", "#....", "#....", "#....", "#....", "#####"],
    "M": ["#...#", "##.##", "#.#.#", "#.#.#", "#...#", "#...#", "#...#"],
    "N": ["#...#", "##..#", "#.#.#", "#..##", "#...#", "#...#", "#...#"],
    "O": [".###.", "#...#", "#...#", "#...#", "#...#", "#...#", ".###."],
    "P": ["####.", "#...#", "#...#", "####.", "#....", "#....", "#...."],
    "Q": [".###.", "#...#", "#...#", "#...#", "#.#.#", "#..#.", ".##.#"],
    "R": ["####.", "#...#", "#...#", "####.", "#.#..", "#..#.", "#...#"],
    "S": [".####", "#....", "#....", ".###.", "....#", "....#", "####."],
    "T": ["#####", "..#..", "..#..", "..#..", "..#..", "..#..", "..#.."],
    "U": ["#...#", "#...#", "#...#", "#...#", "#...#", "#...#", ".###."],
    "V": ["#...#", "#...#", "#...#", "#...#", "#...#", ".#.#.", "..#.."],
    "W": ["#...#", "#...#", "#...#", "#.#.#", "#.#.#", "#.#.#", ".#.#."],
    "X": ["#...#", "#...#", ".#.#.", "..#..", ".#.#.", "#...#", "#...#"],
    "Y": ["#...#", "#...#", ".#.#.", "..#..", "..#..", "..#..", "..#.."],
    "Z": ["#####", "....#", "...#.", "..#..", ".#...", "#....", "#####"],
    "a": [".....", ".....", ".###.", "....#", ".####", "#...#", ".####"],
    "b": ["#....", "#....", "####.", "#...#", "#...#", "#...#", "####."],
    "c": ["....", "....", ".###", "#...", "#...", "#...", ".###"],
    "d": ["....#", "....#", ".####", "#...#", "#...#", "#...#", ".####"],
    "e": [".....", ".....", ".###.", "#...#", "#####", "#....", ".###."],
    "f": ["..##", ".#..", ".#..", "###.", ".#..", ".#..", ".#.."],
    "g": [".....", ".....", ".####", "#...#", "#...#", "#...#", ".####", "....#", ".###."],
    "h": ["#....", "#....", "####.", "#...#", "#...#", "#...#", "#...#"],
    "i": [".#.", "...", "##.", ".#.", ".#.", ".#.", "###"],
    "j": ["...#", "....", "..##", "...#", "...#", "...#", "...#", "#..#", ".##."],
    "k": ["#...", "#...", "#..#", "#.#.", "##..", "#.#.", "#..#"],
    "l": ["##.", ".#.", ".#.", ".#.", ".#.", ".#.", "###"],
    "m": [".....", ".....", "##.#.", "#.#.#", "#.#.#", "#.#.#", "#.#.#"],
    "n": [".....", ".....", "####.", "#...#", "#...#", "#...#", "#...#"],
    "o": [".....", ".....", ".###.", "#...#", "#...#", "#...#", ".###."],
    "p": [".....", ".....", "####.", "#...#", "#...#", "#...#", "####.", "#....", "#...."],
    "q": [".....", ".....", ".####", "#...#", "#...#", "#...#", ".####", "....#", "....#"],
    "r": ["....", "....", "#.##", "##..", "#...", "#...", "#..."],
    "s": [".....", ".....", ".####", "#....", ".###.", "....#", "####."],
    "t": [".#..", ".#..", "###.", ".#..", ".#..", ".#..", "..##"],
    "u": [".....", ".....", "#...#", "#...#", "#...#", "#...#", ".####"],
    "v": [".....", ".....", "#...#", "#...#", "#...#", ".#.#.", "..#.."],
    "w": [".....", ".....", "#...#", "#...#", "#.#.#", "#.#.#", ".#.#."],
    "x": [".....", ".....", "#...#", ".#.#.", "..#..", ".#.#.", "#...#"],
    "y": [".....", ".....", "#...#", "#...#", "#...#", "#...#", ".####", "....#", ".###."],
    "z": [".....", ".....", "#####", "...#.", "..#..", ".#...", "#####"],
    "0": [".###.", "#...#", "#..##", "#.#.#", "##..#", "#...#", ".###."],
    "1": ["..#..", ".##..", "..#..", "..#..", "..#..", "..#..", ".###."],
    "2": [".###.", "#...#", "....#", "...#.", "..#..", ".#...", "#####"],
    "3": ["####.", "....#", "....#", ".###.", "....#", "....#", "####."],
    "4": ["...#.", "..##.", ".#.#.", "#..#.", "#####", "...#.", "...#."],
    "5": ["#####", "#....", "####.", "....#", "....#", "#...#", ".###."],
    "6": [".###.", "#....", "#....", "####.", "#...#", "#...#", ".###."],
    "7": ["#####", "....#", "...#.", "..#..", ".#...", ".#...", ".#..."],
    "8": [".###.", "#...#", "#...#", ".###.", "#...#", "#...#", ".###."],
    "9": [".###.", "#...#", "#...#", ".####", "....#", "....#", ".###."],
    " ": ["...", "...", "...", "...", "...", "...", "..."],
    ".": [".", ".", ".", ".", ".", ".", "#"],
    ",": ["..", "..", "..", "..", "..", "..", ".#", "#."],
    "!": ["#", "#", "#", "#", "#", ".", "#"],
    "?": [".###.", "#...#", "....#", "...#.", "..#..", ".....", "..#.."],
    ":": [".", ".", "#", ".", ".", ".", "#"],
    "-": ["....", "....", "....", "####", "....", "....", "...."],
    "'": ["#", "#", ".", ".", ".", ".", "."],
    "/": ["....#", "....#", "...#.", "..#..", ".#...", "#....", "#...."],
    "%": ["##..#", "##..#", "...#.", "..#..", ".#...", "#..##", "#..##"],
}

# Lowercase accents (rows 0-1), aligned right/center based on glyph width.
_ACCENTS: dict[str, tuple[str, str]] = {
    "acute": ("...#.", "..#.."),
    "grave": (".#...", "..#.."),
    "circ": ("..#..", ".#.#."),
    "tilde": (".##.#", "#..#."),
}
_ACCENTED: dict[str, tuple[str, str]] = {
    "á": ("a", "acute"), "à": ("a", "grave"), "â": ("a", "circ"), "ã": ("a", "tilde"),
    "é": ("e", "acute"), "ê": ("e", "circ"), "ó": ("o", "acute"), "ô": ("o", "circ"),
    "õ": ("o", "tilde"), "ú": ("u", "acute"), "í": ("i", "acute"),
}


def _build_font() -> dict[str, list[str]]:
    font = {ch: rows + ["." * len(rows[0])] * (9 - len(rows)) for ch, rows in _GLYPHS.items()}
    for ch, (base, accent) in _ACCENTED.items():
        rows = list(font[base])
        width = len(rows[0])
        top, bottom = _ACCENTS[accent]
        if width < 5:  # narrow glyphs (i): 3-column centered accent
            top, bottom = top[1:4], bottom[1:4]
        rows[0], rows[1] = top, bottom
        font[ch] = rows
    c = list(font["c"])
    c[7], c[8] = ".#..", "##.."
    font["ç"] = c
    return font


FONT: dict[str, list[str]] = _build_font()
CELL_HEIGHT = 9
CAP_HEIGHT = 7


def hex_rgba(value: str) -> tuple[int, int, int, int]:
    value = value.lstrip("#")
    return int(value[0:2], 16), int(value[2:4], 16), int(value[4:6], 16), 255


def render_map(rows: list[str], palette: dict[str, str] = PALETTE) -> Image.Image:
    """Converts a character map to an RGBA image ('.' = transparent)."""
    width = len(rows[0])
    if any(len(r) != width for r in rows):
        raise ValueError("map with mismatched row widths")
    img = np.zeros((len(rows), width, 4), dtype=np.uint8)
    for y, row in enumerate(rows):
        for x, ch in enumerate(row):
            if ch != ".":
                img[y, x] = hex_rgba(palette[ch])
    return Image.fromarray(img, "RGBA")


def _glyph(ch: str) -> list[str]:
    if ch not in FONT:
        raise KeyError(f"bitmap font lacks character {ch!r}")
    return FONT[ch]


def text_width(text: str) -> int:
    return sum(len(_glyph(ch)[0]) + 1 for ch in text) - 1 if text else 0


def draw_text(img: Image.Image, x: int, y: int, text: str, color: str) -> None:
    """Writes `text` with bitmap font; (x, y) = top-left corner of cell (row 0)."""
    px = img.load()
    rgba = hex_rgba(color)
    for ch in text:
        glyph = _glyph(ch)
        for gy, row in enumerate(glyph):
            for gx, bit in enumerate(row):
                if bit == "#":
                    px[x + gx, y + gy] = rgba
        x += len(glyph[0]) + 1


def text_image(text: str, color: str, scale: int = 1, shadow: str | None = None) -> Image.Image:
    """Text as RGBA image (height = 9-row cell), with optional 1px shadow, scaled by integer."""
    w, h = text_width(text) + (1 if shadow else 0), CELL_HEIGHT + (1 if shadow else 0)
    img = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    if shadow:
        draw_text(img, 1, 1, text, shadow)
    draw_text(img, 0, 0, text, color)
    return img.resize((w * scale, h * scale), Image.NEAREST) if scale > 1 else img


def signage() -> Image.Image:
    """Reception sign, 64x16: navy plate with bevel, screws and "Habblaud"."""
    w, h = 64, 16
    img = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    px = img.load()
    outline, top, face, bottom = hex_rgba("#1c2541"), hex_rgba("#3a4a70"), hex_rgba("#2a3656"), hex_rgba("#222b47")
    for y in range(h):
        for x in range(w):
            if x in (0, w - 1) and y in (0, h - 1):
                continue  # rounded corners
            if x in (0, w - 1) or y in (0, h - 1):
                px[x, y] = outline
            elif y == 1:
                px[x, y] = top
            elif y == h - 2:
                px[x, y] = bottom
            else:
                px[x, y] = face
    for sx in (3, w - 4):  # screws
        px[sx, 7] = hex_rgba("#c9d3e3")
        px[sx, 8] = hex_rgba("#7d8aa3")
    # centered text with 1px shadow; light "Hab" and "blaud" in lit-window color
    tx, ty = (w - text_width("Habblaud")) // 2, 4
    blaud_x = tx + text_width("Hab") + 1
    draw_text(img, tx, ty + 1, "Hab", "#151c33")
    draw_text(img, blaud_x, ty + 1, "blaud", "#151c33")
    draw_text(img, tx, ty, "Hab", "#f4f1ea")
    draw_text(img, blaud_x, ty, "blaud", "#fac665")
    return img


def mark(size: int) -> Image.Image:
    if size == 32:
        return render_map(MARK_32)
    if size == 16:
        return render_map(MARK_16)
    raise ValueError(f"hand-drawn mark only exists in 16 and 32 px (requested: {size})")
