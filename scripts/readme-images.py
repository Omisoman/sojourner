"""Compose the README's lead images from real captures (nothing is drawn):

    uv run python scripts/tui-shots.py      # with the stack up
    uv run python scripts/readme-images.py

  docs/shots/two-terminals.png  tier-1's Requests beside tier-2's Approvals
  docs/shots/loop.png           staging's Patterns page beside New Horizons' Changes page
"""

from __future__ import annotations

from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
SHOTS = ROOT / "docs" / "shots"
HORIZONS_SHOTS = ROOT.parent / "new-horizons" / "docs" / "shots"
GAP, BG = 16, (12, 12, 13)


def side_by_side(left: Path, right: Path, out: Path, height: int | None = None) -> None:
    a, b = Image.open(left).convert("RGB"), Image.open(right).convert("RGB")
    h = height or min(a.height, b.height)
    a = a.resize((round(a.width * h / a.height), h), Image.LANCZOS)
    b = b.resize((round(b.width * h / b.height), h), Image.LANCZOS)
    sheet = Image.new("RGB", (a.width + b.width + 3 * GAP, h + 2 * GAP), BG)
    sheet.paste(a, (GAP, GAP))
    sheet.paste(b, (a.width + 2 * GAP, GAP))
    sheet.save(out, optimize=True)
    print(f"  {out.relative_to(ROOT)}  {sheet.width}x{sheet.height}")


def main() -> None:
    side_by_side(SHOTS / "tui" / "tier1-requests.png", SHOTS / "tui" / "tier2-settings-approvals.png",
                 SHOTS / "two-terminals.png")
    side_by_side(SHOTS / "staging" / "patterns.png", HORIZONS_SHOTS / "changes.png",
                 SHOTS / "loop.png", height=600)


if __name__ == "__main__":
    main()
