"""evaluate_run — the bilingual question-set scorecard is the quality gate.

The patched app answers New Horizons' question set (docs/question-set.yaml, 13 EN +
13 AR) through the same graph the Chat page uses, on the evaluation model; a
question passes when its language, every figure and its citation are right.
verdict = pass when pass_rate >= the threshold.

What the gate judges BY comes from the baked baseline, never from the patch:
the model and threshold (`evaluation:` in shared/rules/rules.yaml, read by the
server's own import), the question set and the grader script. The patch is
what is being judged — PYTHONPATH points the grader at its code.

The LLM review is a signal for the approver, never a gate.
"""

from __future__ import annotations

import json
import os

from new_horizons.shared.rules.rbac import rules

from .workspace import BASELINE, BUILD_OUT, PYTHON, code_env, run

QUESTION_SET = BASELINE / "docs" / "question-set.yaml"
GRADER = BASELINE / "scripts" / "question-bank.py"
TIMEOUT = int(os.environ.get("EVALUATE_TIMEOUT_S", "1800"))


def gate() -> tuple[str, float]:
    ev = rules().get("evaluation") or {}
    return str(ev.get("model", "llama3.1:8b")), float(ev.get("min_pass_rate", 0.75))


def scorecard(model: str) -> tuple[dict | None, str]:
    out = BUILD_OUT / f"question-set-results-{model.replace(':', '_')}.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.unlink(missing_ok=True)
    code, log = run([PYTHON, str(GRADER), "--set", str(QUESTION_SET), "--model", model,
                     "--out", str(out)], env=code_env(database=True), timeout=TIMEOUT)
    if code != 0 or not out.exists():
        return None, log
    return json.loads(out.read_text(encoding="utf-8")), log


def _misses(results: dict) -> list[str]:
    return [r["id"] for r in results.get("results", [])
            if not (r.get("lang_ok") and r.get("figures_ok") and r.get("citation_ok"))]


def _llm_review(summary: str, rate: float, threshold: float, misses: list[str]) -> str:
    try:
        from new_horizons.shared.llm.client import chat_model
        resp = chat_model().invoke(
            "You are a terse release reviewer for a farm analytics app. Change summary: "
            f"{summary}\nQuestion-set pass rate {rate:.0%} (gate {threshold:.0%}); "
            f"missed: {', '.join(misses) or 'none'}.\n"
            "Reply with 2 sentences max: risk assessment + ship/hold call.")
        return (resp.content or "").strip()[:500]
    except Exception as exc:
        return f"(llm review unavailable: {exc})"


def evaluate_run(summary: str = "") -> dict:
    model, threshold = gate()
    results, log = scorecard(model)
    if results is None:
        return {"verdict": "fail", "model": model, "threshold": threshold,
                "error": "the scorecard did not complete", "tail": log[-1500:]}
    rate = float(results.get("pass_rate", 0.0))
    misses = _misses(results)
    return {
        "verdict": "pass" if rate >= threshold else "fail",
        "model": model, "threshold": threshold, "pass_rate": rate,
        "passed": results.get("passed"), "questions": len(results.get("results", [])),
        "misses": misses,
        "llm_review": _llm_review(summary, rate, threshold, misses),
    }
