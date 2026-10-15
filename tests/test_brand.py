"""Brand sources of truth for the terminal agent: every generated file matches a
fresh render from new-horizons' Agentization Core design system (tokens +
the generated AC marks), and the marks keep the cell-TUI contracts."""

import importlib.util
import json
import re
from pathlib import Path

ROOT = Path(__file__).parents[1]
TUI_BRAND = ROOT / "infra" / "tui" / "brand"

_spec = importlib.util.spec_from_file_location("brand_sync", ROOT / "scripts" / "brand-sync.py")
brand_sync = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(brand_sync)


def _json(name: str) -> dict:
    return json.loads((TUI_BRAND / name).read_text(encoding="utf-8"))


# ---- generated targets ---------------------------------------------------------

def test_generated_files_match_a_fresh_render():
    """Hand-editing a generated file (or the AC sources without `make brand`) fails here."""
    for path, text in brand_sync.targets().items():
        assert path.exists(), f"{path.relative_to(ROOT)} missing — run make brand"
        assert path.read_text(encoding="utf-8") == text, f"{path.relative_to(ROOT)} drifted — run make brand"


def test_both_tiers_wear_the_same_theme():
    first, second = (p.read_text(encoding="utf-8") for p in brand_sync.THEMES)
    assert first == second


def test_theme_is_black_in_both_modes():
    """No {dark, light} pair anywhere: OpenCode picks its mode from the terminal's
    background, and a light terminal must still get the black console."""
    theme = json.loads(brand_sync.THEMES[0].read_text(encoding="utf-8"))
    assert set(theme["theme"]) == set(brand_sync.CONSOLE_ROLES)
    for role, ref in theme["theme"].items():
        assert isinstance(ref, str) and ref in theme["defs"], role
    assert all(k.startswith("black_") for k in theme["defs"]), "a light variant crept back in"
    assert all(re.fullmatch(r"#[0-9a-f]{6}", v) for v in theme["defs"].values())


def test_theme_is_the_ac_design_system():
    """Monochrome primary (white on black), the AC chevron gray as the second
    accent, status colours straight from the tokens."""
    defs = json.loads(brand_sync.THEMES[0].read_text(encoding="utf-8"))["defs"]
    c = brand_sync.ac_tokens()["themes"]["black"]["colors"]
    assert defs["black_bg"] == c["bg"] and defs["black_accent"] == c["fg"]
    assert (defs["black_good"], defs["black_warn"], defs["black_bad"]) == (c["green"], c["amber"], c["red"])
    assert defs["black_accent2"] == defs["black_logo1"] == brand_sync.CHEVRON


def test_tui_palette_is_the_role_set_palette_ts_reads():
    tok = _json("tokens.json")
    assert list(tok["colors"]) == brand_sync.TUI_ROLES
    assert tok["wordmark"] == {"en": "agentization-core"}
    src = (ROOT / "infra" / "tui" / "lib" / "palette.ts").read_text(encoding="utf-8")
    for role in ("accent", "accentBright", "text", "muted", "brand", "bgPanel", "bgElement"):
        assert f't["{role}"]' in src, role


# ---- marks ---------------------------------------------------------------------

def test_marks_meet_the_cell_tui_contract():
    doc = _json("mark.json")
    assert brand_sync.validate_mark(doc) == []
    assert doc["palette"] == {"chevron": brand_sync.CHEVRON, "ink": brand_sync.INK["black"]}
    for name in ("compact", "full"):
        rows = doc[name]["rows"]
        assert len(rows) == 2, name                 # the 8 glyph rows of the AC grid, as braille
        assert {run[0] for row in rows for run in row if run[0]} == {"chevron", "ink"}, name
    assert doc["compact"]["cols"] <= 28 < doc["full"]["cols"]


def test_chips_are_the_ac_mark_at_three_scales():
    doc = _json("chips.json")
    assert brand_sync.validate_chips(doc) == []
    sizes = doc["sizes"]
    assert [(s["size"], s["rows"]) for s in sizes] == [("S", 4), ("M", 6), ("L", 8)]  # smallest first
    assert sizes[0]["cols"] < sizes[1]["cols"] < sizes[2]["cols"]
    for s in sizes:
        colours = {run[0] for line in s["lines"] for run in line if run[0]}
        assert colours == {brand_sync.CHEVRON, brand_sync.INK["black"]}, s["size"]


def test_sampler_maps_one_grid_cell_to_one_dot(tmp_path):
    """The first letter cell of the AC grid (x 53, x-height row 2) is dot (2, 12) at 1x
    and a 2x2 block at 2x: the sampler aligns to the grid, it does not trace."""
    svg = tmp_path / "cell.svg"
    svg.write_text('<svg viewBox="0 0 70 42"><path d="M53 11.25h4.625v4.625h-4.625Z" fill="#f5f5f5"/></svg>')
    lit = lambda g: [(j, i) for j, row in enumerate(g) for i, c in enumerate(row) if c]
    one = brand_sync.sample(svg, 1)
    assert lit(one) == [(2, 12)]
    assert lit(brand_sync.sample(svg, 2)) == [(4, 24), (4, 25), (5, 24), (5, 25)]
    [cell] = [run for run in brand_sync.braille_rows(one)[0] if run[0]]
    assert cell == ["#f5f5f5", chr(0x2800 | 0x04)]   # cell column 6, dot (0, 2)


def test_validator_rejects_what_breaks_a_cell_tui():
    doc = brand_sync.mark_doc()
    doc["full"]["rows"][0] = [[None, "المزرعة"]]
    doc["compact"]["rows"][0].append(["notARole", "x"])
    problems = " ".join(brand_sync.validate_mark(doc))
    assert "RTL" in problems and "roles from palette" in problems
    assert brand_sync.validate_mark({"version": 2})
    assert brand_sync.validate_mark([]) == ["document must be a JSON object"]


def test_nothing_is_traced_from_a_raster():
    assert not [p for p in TUI_BRAND.iterdir() if p.suffix in (".png", ".jpg", ".bits")]
    src = (ROOT / "scripts" / "brand-sync.py").read_text(encoding="utf-8")
    assert ".png" not in src and "PIL" not in src
