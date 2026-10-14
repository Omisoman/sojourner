"""validate_run — four deterministic checks on the patched code.

* import-linter: New Horizons' contracts (`shared` never imports `app`/`host`; views
  never import each other) — what `/arch-check` runs in tier-1.
* the knowledge-base dry run: the corpus chunks and every citation key the
  analytics and the intake alert cite still resolves (no model, no writes).
* tests/test_validation.py against the shared database: the business truth
  the generator pinned still holds on the patched code.
* tests/test_views.py against the shared database: every page renders in
  English and Arabic (Streamlit AppTest). The build's suite runs without a
  database, so this is where a broken view is caught — before the approver.
"""

from __future__ import annotations

from pathlib import Path

from .workspace import PYTHON, code_env, run

LINT_IMPORTS = str(Path(PYTHON).parent / "lint-imports")


def _pytest(path: str) -> dict:
    code, log = run([PYTHON, "-m", "pytest", "-q", "-p", "no:cacheprovider", path],
                    env=code_env(database=True), timeout=600)
    last = (log.strip().splitlines() or [""])[-1]
    # a skipped module (no database, no data) proves nothing: it must have run
    ran = " passed" in last or " failed" in last
    return {"ok": code == 0 and ran, "summary": last, "tail": log[-800:]}


def validate_run() -> dict:
    lint_code, lint_log = run([LINT_IMPORTS], env=code_env(), timeout=300)
    kb_code, kb_log = run([PYTHON, "-m", "new_horizons.app.ingest.run", "--dry-run"],
                          env=code_env(), timeout=300)
    checks = {
        "import_contracts": {"ok": lint_code == 0, "tail": lint_log[-600:]},
        "kb_dry_run": {"ok": kb_code == 0, "tail": kb_log[-600:]},
        "business_truth": _pytest("tests/test_validation.py"),
        "pages": _pytest("tests/test_views.py"),
    }
    return {"ok": all(c["ok"] for c in checks.values()), **checks}
