"""Sojourner's lock = new-horizons' pins + the A2A server's
packages. The tier image installs this lock, and tier-2's build gate checks
the PATCHED new-horizons lock against that environment — so the two must agree on
every shared package, or a clean patch would fail as "needs a new dependency"."""

from __future__ import annotations

import tomllib
from pathlib import Path

import pytest

ROOT = Path(__file__).parents[1]
HORIZONS_LOCK = ROOT.parent / "new-horizons" / "uv.lock"


def pins(path: Path) -> dict[str, str]:
    return {p["name"]: p.get("version") for p in tomllib.loads(path.read_text())["package"]}


@pytest.mark.skipif(not HORIZONS_LOCK.exists(), reason="sibling new-horizons checkout not present")
def test_shared_packages_carry_horizons_s_exact_pins():
    mine, theirs = pins(ROOT / "uv.lock"), pins(HORIZONS_LOCK)
    drift = {k: (theirs[k], mine[k]) for k in set(mine) & set(theirs) if mine[k] != theirs[k]}
    assert not drift, f"re-lock from New Horizons' lock: cp ../new-horizons/uv.lock uv.lock && uv lock — {drift}"


def test_the_server_packages_are_locked():
    assert {"a2a-sdk", "uvicorn", "new-horizons"} <= set(pins(ROOT / "uv.lock"))
