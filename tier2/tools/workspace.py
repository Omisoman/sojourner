"""The checkout tier-2 works on, and how its code is run.

PROJECT_DIR is tier-2's own clone of new-horizons, reset to the baked
baseline (`sojourner-base`) and then carrying tier-1's replayed patch. Every
tool runs that code with PYTHONPATH pointing at its `src/`, on the image's one
environment (/opt/venv, built from New Horizons' lock) — the server itself imports
the BAKED baseline, so a patch can change the app but never the gate.

BASELINE is that baked checkout (read-only). Anything the gate judges BY —
the access rules and their evaluation threshold, the question set, the grader —
is read from there, never from the patched tree.
"""

from __future__ import annotations

import os
import re
import subprocess
from pathlib import Path

PROJECT = Path(os.environ.get("PROJECT_DIR", "/workspace/project"))
BASELINE = Path(os.environ.get("BASELINE_DIR", "/opt/sojourner/horizons"))
BUILD_OUT = Path(os.environ.get("BUILD_OUT", "/tmp/sojourner-build"))
BASE_REF = os.environ.get("SOJOURNER_BASE_REF", "sojourner-base")
PYTHON = os.environ.get("TIER_PYTHON", "/opt/venv/bin/python")

# A database route nothing answers on: the suite's database tests skip, so the
# build runs the same hermetic tests tier-1 ran in its sandbox.
NO_DB = "postgresql://nobody@127.0.0.1:1/none"

_ANSI = re.compile(r"\x1b\[[0-9;]*m")


def code_env(*, database: bool = False, **extra: str) -> dict[str, str]:
    env = {**os.environ, "PYTHONPATH": str(PROJECT / "src"), "PYTHONDONTWRITEBYTECODE": "1"}
    if not database:
        env["DATABASE_URL"] = env["DATABASE_URL_RO"] = NO_DB
    env.update(extra)
    return env


def run(cmd: list[str], *, env: dict | None = None, cwd: Path | None = None,
        timeout: int = 900, tail: int = 3000) -> tuple[int, str]:
    p = subprocess.run(cmd, cwd=cwd or PROJECT, env=env or code_env(), capture_output=True,
                       text=True, timeout=timeout)
    return p.returncode, _ANSI.sub("", p.stdout + p.stderr)[-tail:]


def head() -> str:
    p = subprocess.run(["git", "rev-parse", "HEAD"], cwd=PROJECT, capture_output=True,
                       text=True, timeout=30)
    return p.stdout.strip() if p.returncode == 0 else ""


def changed_files(base: str = BASE_REF) -> list[str]:
    p = subprocess.run(["git", "diff", "--name-only", f"{base}..HEAD"], cwd=PROJECT,
                       capture_output=True, text=True, timeout=60)
    return [f for f in p.stdout.splitlines() if f.strip()] if p.returncode == 0 else []
