"""Regenerate every brand consumer of the terminal agent (stdlib only).

    uv run python scripts/brand-sync.py           # write targets
    uv run python scripts/brand-sync.py --check   # exit 1 if any target drifted

Sources — owned by new-horizons, the Agentization Core design system it
ships; nothing here is drawn or traced:

    app/design/tokens.json       the AC design tokens (the black theme)
    app/static/ac-mark.svg       "> a-c", generated on the AC pixel grid
    app/static/ac-wordmark.svg   "> agentization-core", same grid

Targets (fully generated — edit the sources or the maps below, never these):

    tier{1,2}/.opencode/themes/sojourner.json   OpenCode theme: the role map of
        the Agentization Core tui-themes' `console` theme (the OpenCode idiom),
        coloured with the AC black theme — ONE variant, no dark/light pair, so
        a light terminal (or a light macOS appearance) cannot flip the console
    infra/tui/brand/tokens.json                 the TUI palette, by role (dark)
    infra/tui/brand/mark.json                   the "> a-c" and "> agentization-core"
                                                lockups as braille, 2 rows each
    infra/tui/brand/chips.json                  the a-c mark at 2x, 3x, 4x (home logo)

The marks are SAMPLED from the vector paths: one braille cell is 2x4 dots, and
at 1x one dot is one cell of the AC pixel grid (4.625 px), so the eight glyph
rows (ascender pair, x-height, descender) are exactly two text rows. A dot
lights when at least half of its area is covered (4x4 supersampling, even-odd
fill), and takes the colour of the shape that covers it. tests/test_brand.py
re-renders and diffs, so drift fails CI.
"""

from __future__ import annotations

import importlib.util
import json
import math
import re
import sys
import unicodedata
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
THEMES = [ROOT / "tier1" / ".opencode" / "themes" / "sojourner.json",
          ROOT / "tier2" / ".opencode" / "themes" / "sojourner.json"]
TUI_BRAND = ROOT / "infra" / "tui" / "brand"

# The AC mark's two inks on a dark surface (New Horizons' scripts/brand-marks.py:
# GRAY chevron, WHITE letters). The terminal agent is black only.
CHEVRON = "#878787"
INK = {"black": "#f5f5f5"}
# The AC tokens carry no blue; links and info keep the console theme's.
INFO = {"black": "#6fa8ff"}

# tui-themes/themes/console/opencode-theme.json: OpenCode role -> variant slot
# (the theme writes `black_<slot>`), copied verbatim.
CONSOLE_ROLES = {
    "primary": "accent", "secondary": "muted", "accent": "accent2", "error": "bad",
    "warning": "warn", "success": "good", "info": "info", "text": "text", "textMuted": "muted",
    "background": "bg", "backgroundPanel": "panel", "backgroundElement": "element",
    "border": "border", "borderActive": "accent", "borderSubtle": "rule",
    "diffAdded": "good", "diffRemoved": "bad", "diffContext": "muted", "diffHunkHeader": "muted",
    "diffHighlightAdded": "good", "diffHighlightRemoved": "bad", "diffAddedBg": "panel",
    "diffRemovedBg": "panel", "diffContextBg": "bg", "diffLineNumber": "dim",
    "diffAddedLineNumberBg": "panel", "diffRemovedLineNumberBg": "panel",
    "markdownText": "text", "markdownHeading": "accent", "markdownLink": "info",
    "markdownLinkText": "info", "markdownCode": "accent2", "markdownBlockQuote": "muted",
    "markdownEmph": "text", "markdownStrong": "strong", "markdownHorizontalRule": "border",
    "markdownListItem": "text", "markdownListEnumeration": "muted", "markdownImage": "info",
    "markdownImageText": "muted", "markdownCodeBlock": "text", "syntaxComment": "dim",
    "syntaxKeyword": "accent", "syntaxFunction": "info", "syntaxVariable": "text",
    "syntaxString": "good", "syntaxNumber": "warn", "syntaxType": "accent2",
    "syntaxOperator": "muted", "syntaxPunctuation": "muted",
}
SLOTS = ["bg", "panel", "element", "border", "rule", "text", "muted", "dim", "strong", "sel",
         "good", "warn", "bad", "info", "accent", "accent2", "accentText", "logo1", "logo2", "trace"]

# The TUI palette (lib/palette.ts reads these names).
TUI_ROLES = ["accent", "accentBright", "text", "muted", "brand", "white", "bg", "bgPanel",
             "bgElement", "border", "red", "green", "blue", "yellow"]

U = 4.625                      # one cell of the AC pixel grid
GLYPH_TOP = 2.0                # top of glyph row 0 (11.25 - 2 cells)
GLYPH_LEFT = 53.0              # left edge of the first letter
X_ORIGIN = GLYPH_LEFT % U - U  # dot columns start here, so every letter cell is whole dots
GLYPH_ROWS = 8                 # ascender pair, x-height (5), descender
SUPER = 4                      # supersamples per dot side
COVER = 0.5                    # covered share that lights a dot
# dot (dx, dy, bit), Unicode braille order
DOTS = [(0, 0, 0x01), (0, 1, 0x02), (0, 2, 0x04), (1, 0, 0x08),
        (1, 1, 0x10), (1, 2, 0x20), (0, 3, 0x40), (1, 3, 0x80)]
CHIP_SCALES = {"S": 2, "M": 3, "L": 4}
BUDGET = {"full": (2, 80), "compact": (2, 28)}


# ---- sources ---------------------------------------------------------------------

def horizons_app() -> Path:
    """new-horizons' app package: the installed dependency, else the sibling checkout."""
    spec = importlib.util.find_spec("new_horizons")
    if spec and spec.origin:
        return Path(spec.origin).parent / "app"
    sibling = ROOT.parent / "new-horizons" / "src" / "new_horizons" / "app"
    if sibling.exists():
        return sibling
    raise SystemExit("new-horizons not found — `uv sync`, or clone it beside this repo")


def ac_tokens() -> dict:
    return json.loads((horizons_app() / "design" / "tokens.json").read_text(encoding="utf-8"))


def svg_shapes(path: Path) -> tuple[float, list[tuple[str, list[list[tuple[float, float]]]]]]:
    """(width, [(fill, polygons)]) of an SVG drawn with M/H/V/h/v/Z paths only."""
    text = path.read_text(encoding="utf-8")
    width = float(re.search(r'viewBox="0 0 ([\d.]+) [\d.]+"', text).group(1))
    shapes = []
    for d, fill in re.findall(r'<path d="([^"]+)" fill="([^"]+)"', text):
        polys, cur, x, y = [], [], 0.0, 0.0
        for cmd, args in re.findall(r"([MHVZmhvz])([^MHVZmhvz]*)", d):
            n = [float(v) for v in re.findall(r"-?[\d.]+", args)]
            if cmd == "M":
                if cur:
                    polys.append(cur)
                x, y = n[0], n[1]
                cur = [(x, y)]
            elif cmd in "Hh":
                x = n[0] if cmd == "H" else x + n[0]
                cur.append((x, y))
            elif cmd in "Vv":
                y = n[0] if cmd == "V" else y + n[0]
                cur.append((x, y))
            elif cmd in "Zz":
                polys.append(cur)
                cur = []
            else:
                raise SystemExit(f"{path.name}: unsupported path command {cmd!r}")
        if cur:
            polys.append(cur)
        shapes.append((fill, polys))
    return width, shapes


def _inside(px: float, py: float, polys) -> bool:
    hit = False
    for p in polys:
        for (x1, y1), (x2, y2) in zip(p, p[1:] + p[:1]):
            if (y1 > py) != (y2 > py) and px < x1 + (py - y1) * (x2 - x1) / (y2 - y1):
                hit = not hit
    return hit


def sample(svg: Path, scale: int) -> list[list[str | None]]:
    """Dot grid (rows x cols) of the mark at `scale` dots per pixel cell; each dot
    is None or the colour of the shape covering most of it."""
    width, shapes = svg_shapes(svg)
    colours = [CHEVRON if fill.lower() == CHEVRON else INK["black"] for fill, _ in shapes]
    pitch = U / scale
    w = math.ceil(round((width - X_ORIGIN) / pitch, 6))
    w += w % 2                                 # whole braille cells
    h = GLYPH_ROWS * scale
    grid = []
    for j in range(h):
        row = []
        for i in range(w):
            hits = [0] * len(shapes)
            for sy in range(SUPER):
                for sx in range(SUPER):
                    px = X_ORIGIN + (i + (sx + 0.5) / SUPER) * pitch
                    py = GLYPH_TOP + (j + (sy + 0.5) / SUPER) * pitch
                    for k, (_, polys) in enumerate(shapes):
                        if _inside(px, py, polys):
                            hits[k] += 1
                            break
            best = max(range(len(shapes)), key=lambda k: hits[k])
            row.append(colours[best] if hits[best] >= COVER * SUPER * SUPER else None)
        grid.append(row)
    return grid


def braille_rows(grid: list[list[str | None]], role_of=lambda c: c) -> list[list[list]]:
    """Dot grid -> rows of [colour-or-role | None, text] runs, empty edge columns kept."""
    rows = []
    for cy in range(len(grid) // 4):
        cells = []
        for cx in range(len(grid[0]) // 2):
            code, votes = 0, {}
            for dx, dy, bit in DOTS:
                c = grid[cy * 4 + dy][cx * 2 + dx]
                if c:
                    code |= bit
                    votes[c] = votes.get(c, 0) + 1
            if code:
                cells.append((role_of(max(votes, key=lambda c: (votes[c], c))), chr(0x2800 + code)))
            else:
                cells.append((None, " "))
        runs: list[list] = []
        for colour, ch in cells:
            if runs and runs[-1][0] == colour:
                runs[-1][1] += ch
            else:
                runs.append([colour, ch])
        rows.append(runs)
    return rows


# ---- renderers ---------------------------------------------------------------------

def _black(tok: dict) -> dict[str, str]:
    c = tok["themes"]["black"]["colors"]
    return {
        "bg": c["bg"], "panel": c["card"], "element": c["muted"], "border": c["borderStrong"],
        "rule": c["border"], "text": c["fgMuted"], "muted": c["fgSubtle"],
        "dim": c["locked"], "strong": c["fg"], "sel": c["border"],
        "good": c["green"], "warn": c["amber"], "bad": c["red"], "info": INFO["black"],
        "accent": c["fg"], "accent2": CHEVRON, "accentText": c["fg"],
        "logo1": CHEVRON, "logo2": INK["black"], "trace": c["locked"],
    }


def render_opencode_theme(tok: dict) -> str:
    # Black, whatever the terminal says: a role given as a plain def name (not a
    # {dark, light} pair) resolves the same in both of OpenCode's modes.
    v = _black(tok)
    defs = {f"black_{slot}": v[slot] for slot in SLOTS}
    theme = {role: f"black_{slot}" for role, slot in CONSOLE_ROLES.items()}
    return json.dumps({"$schema": "https://opencode.ai/theme.json", "defs": defs, "theme": theme},
                      indent=2, ensure_ascii=False) + "\n"


def tui_tokens(tok: dict) -> dict:
    c = tok["themes"]["black"]["colors"]
    colors = {"accent": c["fg"], "accentBright": INK["black"], "text": c["fgMuted"], "muted": c["fgSubtle"],
              "brand": CHEVRON, "white": c["fg"], "bg": c["bg"], "bgPanel": c["card"],
              "bgElement": c["muted"], "border": c["borderStrong"], "red": c["red"], "green": c["green"],
              "blue": INFO["black"], "yellow": c["amber"]}
    return {"colors": {k: colors[k] for k in TUI_ROLES},
            "fonts": {"ui": "sans serif", "mono": "monospace"},
            "wordmark": {"en": "agentization-core"}}


def render_tui_tokens(tok: dict) -> str:
    return json.dumps(tui_tokens(tok), indent=2, ensure_ascii=False) + "\n"


def mark_doc() -> dict:
    static = horizons_app() / "static"
    roles = {CHEVRON: "chevron", INK["black"]: "ink"}

    def lockup(svg: str) -> dict:
        rows = braille_rows(sample(static / svg, 1), roles.get)
        return {"cols": sum(len(t) for _, t in rows[0]), "rows": rows}

    def ascii_(word: str) -> dict:
        rows = [[["chevron", ">"], [None, " "], ["ink", word]], [[None, " " * (len(word) + 2)]]]
        return {"cols": len(word) + 2, "rows": rows}

    return {"version": 1, "source": "ac-mark.svg · ac-wordmark.svg",
            "palette": {"chevron": CHEVRON, "ink": INK["black"]},
            "full": lockup("ac-wordmark.svg"), "compact": lockup("ac-mark.svg"),
            "ascii": {"full": ascii_("agentization-core"), "compact": ascii_("a-c")}}


def chips_doc() -> dict:
    svg = horizons_app() / "static" / "ac-mark.svg"
    sizes = []
    for size, scale in CHIP_SCALES.items():
        lines = braille_rows(sample(svg, scale))
        sizes.append({"size": size, "cols": sum(len(t) for _, t in lines[0]), "rows": len(lines), "lines": lines})
    return {"version": 1, "source": "ac-mark.svg", "cover": COVER, "sizes": sizes}


# ---- validation + layout of the committed files ------------------------------------

def display_width(text: str) -> int:
    return sum(2 if unicodedata.east_asian_width(ch) in ("W", "F") else 1 for ch in text)


def validate_mark(doc: object) -> list[str]:
    """Problems with a mark.json document (empty list = valid)."""
    if not isinstance(doc, dict):
        return ["document must be a JSON object"]
    errs = []
    if doc.get("version") != 1:
        errs.append("version must be 1")
    pal = doc.get("palette")
    if not (isinstance(pal, dict) and pal and all(
            isinstance(v, str) and re.fullmatch(r"#[0-9a-fA-F]{6}", v) for v in pal.values())):
        errs.append("palette must map role -> '#rrggbb'")
        pal = pal if isinstance(pal, dict) else {}

    def check(path: str, var: object, max_rows: int, max_cols: int, seven_bit: bool) -> None:
        if not (isinstance(var, dict) and isinstance(var.get("cols"), int)
                and isinstance(var.get("rows"), list) and var["rows"]):
            errs.append(f"{path}: needs {{cols: int, rows: [...]}}")
            return
        rows, cols = var["rows"], var["cols"]
        if len(rows) > max_rows or cols > max_cols:
            errs.append(f"{path}: {len(rows)}x{cols} exceeds budget {max_rows}x{max_cols}")
        for i, row in enumerate(rows):
            if not (isinstance(row, list) and all(
                    isinstance(run, list) and len(run) == 2 and isinstance(run[1], str)
                    and (run[0] is None or run[0] in pal) for run in row)):
                errs.append(f"{path}[{i}]: runs must be [role|null, text], roles from palette")
                continue
            text = "".join(run[1] for run in row)
            if display_width(text) != cols:
                errs.append(f"{path}[{i}]: width {display_width(text)} != cols {cols}")
            bad = sorted({ch for ch in text
                          if unicodedata.east_asian_width(ch) in ("W", "F")
                          or unicodedata.bidirectional(ch) in ("AL", "R")
                          or unicodedata.category(ch).startswith("C")})
            if bad:
                errs.append(f"{path}[{i}]: wide, RTL or control characters {bad!r}")
            if seven_bit and not all(32 <= ord(ch) < 127 for ch in text):
                errs.append(f"{path}[{i}]: ascii variant must be printable 7-bit")

    for name, (max_rows, max_cols) in BUDGET.items():
        check(name, doc.get(name), max_rows, max_cols, False)
        if "ascii" in doc:
            asc = doc["ascii"] if isinstance(doc["ascii"], dict) else {}
            check(f"ascii.{name}", asc.get(name), max_rows, max_cols, True)
    return errs


def validate_chips(doc: object) -> list[str]:
    """Problems with a braille chips document (empty list = valid)."""
    if not isinstance(doc, dict) or doc.get("version") != 1:
        return ["document must be {version: 1, sizes: [...]}"]
    sizes = doc.get("sizes")
    if not isinstance(sizes, list) or not sizes:
        return ["sizes must be a non-empty list"]
    errs = []
    for s in sizes:
        name, lines = s.get("size", "?"), s.get("lines", [])
        if len(lines) != s.get("rows"):
            errs.append(f"{name}: {len(lines)} lines != rows {s.get('rows')}")
        for i, runs in enumerate(lines):
            text = "".join(r[1] for r in runs)
            if len(text) != s.get("cols"):
                errs.append(f"{name}[{i}]: width {len(text)} != cols {s.get('cols')}")
            if any(not (ch == " " or 0x2800 < ord(ch) <= 0x28FF) for ch in text):
                errs.append(f"{name}[{i}]: only spaces and braille allowed")
            for colour, _ in runs:
                if colour is not None and not (isinstance(colour, str) and re.fullmatch(r"#[0-9a-f]{6}", colour)):
                    errs.append(f"{name}[{i}]: colour {colour!r} is not #rrggbb")
    return errs


def dump_mark(doc: dict) -> str:
    """Standard JSON, one row per line so diffs stay readable."""
    def variant(v: dict) -> str:
        rows = ",\n".join("    " + json.dumps(r, ensure_ascii=False) for r in v["rows"])
        return f'{{"cols": {v["cols"]}, "rows": [\n{rows}\n  ]}}'
    parts = [f'"version": {doc["version"]}', f'"source": {json.dumps(doc["source"])}',
             f'"palette": {json.dumps(doc["palette"])}',
             f'"full": {variant(doc["full"])}', f'"compact": {variant(doc["compact"])}',
             f'"ascii": {{"full": {variant(doc["ascii"]["full"])}, '
             f'"compact": {variant(doc["ascii"]["compact"])}}}']
    return "{\n  " + ",\n  ".join(parts) + "\n}\n"


def dump_chips(doc: dict) -> str:
    """One line per braille row keeps diffs readable (like mark.json)."""
    head = {k: v for k, v in doc.items() if k != "sizes"}
    parts = []
    for s in doc["sizes"]:
        lines = ",\n".join("        " + json.dumps(r, ensure_ascii=False) for r in s["lines"])
        meta = ", ".join(f'"{k}": {json.dumps(s[k])}' for k in ("size", "cols", "rows"))
        parts.append("    {%s, \"lines\": [\n%s\n    ]}" % (meta, lines))
    body = ",\n".join(f"  {json.dumps(k)}: {json.dumps(v)}" for k, v in head.items())
    return "{\n" + body + ',\n  "sizes": [\n' + ",\n".join(parts) + "\n  ]\n}\n"


def render_mark_json() -> str:
    doc = mark_doc()
    problems = validate_mark(doc)
    if problems:
        raise SystemExit("mark.json is invalid:\n  " + "\n  ".join(problems))
    return dump_mark(doc)


def render_chips_json() -> str:
    doc = chips_doc()
    problems = validate_chips(doc)
    if problems:
        raise SystemExit("braille chips are invalid:\n  " + "\n  ".join(problems))
    return dump_chips(doc)


def targets() -> dict[Path, str]:
    tok = ac_tokens()
    theme = render_opencode_theme(tok)
    return {
        **{path: theme for path in THEMES},          # each tier's .opencode finds its own copy
        TUI_BRAND / "tokens.json": render_tui_tokens(tok),
        TUI_BRAND / "mark.json": render_mark_json(),
        TUI_BRAND / "chips.json": render_chips_json(),
    }


def preview(doc: dict) -> str:
    """Truecolour ANSI of every chip, for `cat` checks."""
    out = []
    for s in doc["sizes"]:
        out.append(f"== {s['size']} {s['cols']}x{s['rows']}")
        for runs in s["lines"]:
            line = ""
            for colour, text in runs:
                if colour:
                    r, g, b = (int(colour[i:i + 2], 16) for i in (1, 3, 5))
                    line += f"\x1b[38;2;{r};{g};{b}m{text}\x1b[0m"
                else:
                    line += text
            out.append(line)
    return "\n".join(out)


def main(argv: list[str]) -> int:
    if "--preview" in argv:
        print(preview(chips_doc()))
        return 0
    check = "--check" in argv
    drifted = []
    for path, text in targets().items():
        current = path.read_text(encoding="utf-8") if path.exists() else None
        if current == text:
            continue
        drifted.append(path.relative_to(ROOT))
        if not check:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(text, encoding="utf-8")
    verb = "drifted" if check else "written"
    for p in drifted:
        print(f"{verb}: {p}")
    if not drifted:
        print("brand: all targets up to date")
    return 1 if (check and drifted) else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
