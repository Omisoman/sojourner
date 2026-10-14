"""Book covers for the SETTINGS shelf — braille art, the same trick as the chip logo.

    uv run python scripts/book-covers.py            # write covers/<name>.json
    uv run python scripts/book-covers.py --check    # exit 1 if a cover drifted
    uv run python scripts/book-covers.py NAME ...   # covers for these names too

For every book in tier1/docs/books/*.md (and every NAME given), writes
tier1/docs/books/covers/<name>.json with two sizes in the Run shape of
chips.json (so ui/logo.tsx's <Runs> draws them unchanged):

    spine  14 x 6   the shelf tile
    cover  28 x 14  the cover card of the selected book

The cover is a deterministic dot matrix in the chip logo's language. Seed =
sha256(name). A dot (x, y) lights when byte(x // 2, y // 2) / 255 <
threshold(y), a fade from 0.62 at the top dot row to 0.10 at the bottom; a lit
dot is `accent` when byte(x, y) % 7 == 0, else `brand`. The middle third
carries a band of `muted` dots (0.9 density, 0.55 under the letters) behind the
book's initials in block capitals (▀ ▄ █, `accentBright`): the 3x5 glyphs of
infra/tui/brand/font3x5.json, two bit-rows per cell row, 3 cells x 3 rows a
letter — two on the cover, one on the spine. byte(a, b) = sha256(seed || a ||
b)[0], a and b as 2-byte big-endian. Same name, same cover, every run. The
colours are the TUI palette (infra/tui/brand/tokens.json, scripts/brand-sync.py).

A book published at runtime (the ops catalog) has no committed cover: the TUI
draws the generated one with the same algorithm (infra/tui/lib/covers.ts);
tests/test_tui.py checks the two produce identical output.

No image protocol (kitty / iTerm2 / sixel): it does not survive tmux +
`docker exec -it`, and OpenTUI 1.18.30 has no image node. Braille is the render.
"""

from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BOOKS = ROOT / "tier1" / "docs" / "books"
COVERS = BOOKS / "covers"
TOKENS = ROOT / "infra" / "tui" / "brand" / "tokens.json"
FONT = ROOT / "infra" / "tui" / "brand" / "font3x5.json"
# the shelf the tier-1 record ships with; covers exist before the books are written
SHELF = ("architecture", "coding-standards", "release-playbook")

SIZES = {"spine": (14, 6), "cover": (28, 14)}
TOP, BOTTOM = 0.62, 0.10      # lit-dot threshold at the top / bottom dot row
BAND_DENSITY = 0.9
BAND_THIN = 0.55           # the band under the letters, so they read
BLOCKS = "▀▄█"      # ▀ ▄ █ — the initials
# dot (dx, dy, bit), Unicode braille order (scripts/brand-sync.py DOTS)
DOTS = [(0, 0, 0x01), (0, 1, 0x02), (0, 2, 0x04), (1, 0, 0x08),
        (1, 1, 0x10), (1, 2, 0x20), (0, 3, 0x40), (1, 3, 0x80)]


def tokens() -> dict[str, str]:
    return json.loads(TOKENS.read_text(encoding="utf-8"))["colors"]


def font() -> dict[str, list[str]]:
    return json.loads(FONT.read_text(encoding="utf-8"))["glyphs"]


def _lum(h: str) -> float:
    r, g, b = (int(h[i:i + 2], 16) for i in (1, 3, 5))
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def initials(name: str) -> str:
    glyphs = font()
    parts = [p for p in name.replace("_", "-").split("-") if p]
    return "".join(p[0].upper() for p in parts if p[0].upper() in glyphs)[:3]


def _byte(seed: bytes, a: int, b: int) -> int:
    return hashlib.sha256(seed + a.to_bytes(2, "big") + b.to_bytes(2, "big")).digest()[0]


def letters_for(cols: int) -> int:
    """Two initials on the cover (28 cols), one on the spine (14)."""
    return 2 if cols >= 28 else 1


def generated(name: str, cols: int, rows: int, colors: dict[str, str],
              letters: int | None = None) -> list[list[list]]:
    seed = hashlib.sha256(name.encode("utf-8")).digest()
    h = rows * 4
    glyphs = font()
    text = initials(name)[:letters or letters_for(cols)]
    # the letters: 3 cells wide x 3 rows tall each, 1 cell apart, centred
    gy0 = rows // 2 - 1
    glyph_w = 4 * len(text) - 1 if text else 0
    gx0 = (cols - glyph_w) // 2
    # the band hugs the letters, two dots above and below; thinned under them
    by0, by1 = gy0 * 4 - 2, (gy0 + 3) * 4 + 2
    lx0, lx1 = gx0 * 2, (gx0 + glyph_w) * 2

    def dot(x: int, y: int) -> str | None:
        if by0 <= y < by1:
            density = BAND_THIN if lx0 <= x < lx1 else BAND_DENSITY
            return "muted" if _byte(seed, x, y) < density * 256 else None
        threshold = TOP - (TOP - BOTTOM) * y / (h - 1)
        if _byte(seed, x // 2, y // 2) >= threshold * 256:
            return None
        return "accent" if _byte(seed, x, y) % 7 == 0 else "brand"

    lum = {k: _lum(colors.get(k, "#808080")) for k in ("accent", "brand", "muted")}
    grid: list[list[tuple[str | None, str]]] = []
    for cy in range(rows):
        line = []
        for cx in range(cols):
            code, votes = 0, {}
            for dx, dy, bit in DOTS:
                role = dot(cx * 2 + dx, cy * 4 + dy)
                if role:
                    code |= bit
                    votes[role] = votes.get(role, 0) + 1
            if code:
                role = max(votes, key=lambda r: (votes[r], lum[r]))
                line.append((colors.get(role), chr(0x2800 + code)))
            else:
                line.append((None, " "))
        grid.append(line)

    # block capitals OVER the texture: two glyph bit-rows per cell row (bit row
    # 5 is 000), a cell never mixes braille and blocks; the counter clears it
    for i, ch in enumerate(text):
        bits = glyphs[ch] + ["..."]
        for r in range(3):
            top, bottom = bits[2 * r], bits[2 * r + 1]
            for k in range(3):
                t, b = top[k] == "#", bottom[k] == "#"
                block = "█" if t and b else "▀" if t else "▄" if b else " "
                grid[gy0 + r][gx0 + 4 * i + k] = (colors.get("accentBright") if block != " " else None, block)

    out = []
    for line in grid:
        runs: list[list] = []
        for colour, ch in line:
            if runs and runs[-1][0] == colour:
                runs[-1][1] += ch
            else:
                runs.append([colour, ch])
        out.append(runs)
    return out


def cover_doc(name: str) -> dict:
    colors = tokens()
    doc = {"book": name, "source": "generated",
           "seed": hashlib.sha256(name.encode("utf-8")).hexdigest()[:12]}
    for key, (cols, rows) in SIZES.items():
        doc[key] = {"cols": cols, "rows": rows, "lines": generated(name, cols, rows, colors)}
    return doc


def dump(doc: dict) -> str:
    """One braille row per line, like chips.json — readable diffs."""
    parts = [f'  "book": {json.dumps(doc["book"])}', f'  "source": {json.dumps(doc["source"])}',
             f'  "seed": {json.dumps(doc["seed"])}']
    for key in SIZES:
        s = doc[key]
        rows = ",\n".join("      " + json.dumps(r, ensure_ascii=False) for r in s["lines"])
        parts.append(f'  "{key}": {{"cols": {s["cols"]}, "rows": {s["rows"]}, "lines": [\n{rows}\n  ]}}')
    return "{\n" + ",\n".join(parts) + "\n}\n"


def validate(doc: dict) -> list[str]:
    errs = []
    for key, (cols, rows) in SIZES.items():
        s = doc.get(key, {})
        if (s.get("cols"), s.get("rows")) != (cols, rows) or len(s.get("lines", [])) != rows:
            errs.append(f"{key}: expected {cols}x{rows}")
            continue
        for i, runs in enumerate(s["lines"]):
            text = "".join(r[1] for r in runs)
            if len(text) != cols:
                errs.append(f"{key}[{i}]: width {len(text)} != {cols}")
            if any(not (ch == " " or 0x2800 < ord(ch) <= 0x28FF or ch in BLOCKS) for ch in text):
                errs.append(f"{key}[{i}]: only spaces, braille and ▀ ▄ █ allowed")
    return errs


def names(extra: list[str] = ()) -> list[str]:
    return sorted({*SHELF, *(p.stem for p in BOOKS.glob("*.md")), *extra})


def targets(extra: list[str] = ()) -> list[tuple[Path, str]]:
    out = []
    for name in names(extra):
        doc = cover_doc(name)
        problems = validate(doc)
        if problems:
            raise SystemExit(f"{name}: {'; '.join(problems)}")
        out.append((COVERS / f"{name}.json", dump(doc)))
    return out


def main(argv: list[str]) -> int:
    check = "--check" in argv
    extra = [a for a in argv if not a.startswith("-")]
    drift = 0
    COVERS.mkdir(parents=True, exist_ok=True)
    for path, text in targets(extra):
        rel = path.relative_to(ROOT)
        if path.exists() and path.read_text(encoding="utf-8") == text:
            print(f"  ok       {rel}")
            continue
        drift += 1
        if check:
            print(f"  DRIFT    {rel}  (run: make books)")
        else:
            path.write_text(text, encoding="utf-8")
            print(f"  wrote    {rel}")
    return 1 if check and drift else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
