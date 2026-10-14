"""build_run — the deployable is the checkout itself: the lock, then the suite.

1. `uv lock --check`: pyproject and uv.lock still agree.
2. `uv sync --frozen --dry-run` against the image's environment: every locked
   package is already installed. A patch that adds a dependency fails here —
   the sandbox has no network, so nothing new can arrive unreviewed.
3. `pytest -m "not model"` on the patched code, database route removed: the
   same hermetic suite tier-1 ran (`uv run pytest -q`).
"""

from __future__ import annotations

import os

from .workspace import BUILD_OUT, PROJECT, code_env, head, run

UV = os.environ.get("UV_BIN", "uv")


def pending_changes(dry_run: str) -> list[str]:
    """Package changes a frozen sync would still make. A same-version
    reinstall (`- x==1` + `+ x==1`, uv re-linking one wheel) is not a
    dependency change; a new package or a new version is."""
    plus = {line.strip()[2:] for line in dry_run.splitlines() if line.strip().startswith("+ ")}
    minus = {line.strip()[2:] for line in dry_run.splitlines() if line.strip().startswith("- ")}
    return sorted(f"+ {spec}" for spec in plus - minus)


def build_run() -> dict:
    env = code_env(UV_OFFLINE="1", UV_PROJECT_ENVIRONMENT=os.environ.get("VIRTUAL_ENV", "/opt/venv"))
    l_code, l_log = run([UV, "lock", "--check", "--offline"], env=env, timeout=120)
    s_code, s_log = run([UV, "sync", "--frozen", "--offline", "--dry-run", "--inexact",
                         "--no-install-project", "--all-groups"], env=env, timeout=300)
    pending = pending_changes(s_log)
    lock_ok = l_code == 0
    sync_ok = s_code == 0 and not pending
    t_code, t_log = run([os.environ.get("TIER_PYTHON", "/opt/venv/bin/python"), "-m", "pytest",
                         "-q", "-m", "not model", "-p", "no:cacheprovider"], env=env, timeout=900)
    BUILD_OUT.mkdir(parents=True, exist_ok=True)
    summary = next((line for line in reversed(t_log.splitlines()) if " passed" in line or
                    " failed" in line or " error" in line), "")
    return {
        "mode": "uv", "ok": lock_ok and sync_ok and t_code == 0, "head": head(),
        "lock": {"ok": lock_ok, "tail": l_log[-400:]},
        "sync": {"ok": sync_ok, "pending": pending[:20], "tail": s_log[-400:]},
        "tests": {"ok": t_code == 0, "summary": summary.strip(), "tail": t_log[-1200:]},
        "project": str(PROJECT),
    }
