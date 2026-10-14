"""Tier-2 ops toolset — rules-gated, audited. Registered into the shared
LangGraph harness as toolset "ops".

Every tool runs under the service role `ops`; a denial returns an access-error
dict (never a silent skip) and is audited.
"""

from __future__ import annotations

import time

from new_horizons.shared.audit.audit import audit
from new_horizons.shared.rules.rbac import AccessDenied, check

from .build import build_run
from .deploy import deploy_staging
from .evaluate import evaluate_run
from .github_adapter import gitea_pr
from .notify import notify
from .validate import validate_run

REGISTRY: dict[str, dict] = {
    "gitea_pr": {
        "fn": gitea_pr,
        "description": "Create a branch + pull request on the internal Gitea "
                       "(GitHub-shaped adapter — production GitHub is a token swap).",
        "args": {"summary": "string (conventional-commit line)",
                 "detail": "string (optional body)"},
    },
    "build_run": {
        "fn": build_run,
        "description": "Build: the lock still agrees and is fully installed (no new "
                       "dependency without a network), then the hermetic test suite.",
        "args": {},
    },
    "validate_run": {
        "fn": validate_run,
        "description": "Validate: import contracts, knowledge-base dry run, and the "
                       "business-truth tests against the shared database.",
        "args": {},
    },
    "evaluate_run": {
        "fn": evaluate_run,
        "description": "Quality gate: the bilingual question-set scorecard on the "
                       "evaluation model. verdict: pass|fail.",
        "args": {"summary": "string (what changed, for the review)"},
    },
    "deploy_staging": {
        "fn": deploy_staging,
        "description": "Publish the approved checkout to the staging app. "
                       "APPROVAL-GATED by the access rules.",
        "args": {},
    },
    "notify": {
        "fn": notify,
        "description": "Notify the ops channel (ntfy topic sojourner-ops).",
        "args": {"message": "string"},
    },
}

ROLE = "ops"

# Task-scoped capture of full tool results (the executor reads these to build
# artifacts and gate on the evaluation verdict; reset per phase).
RESULTS: list[tuple[str, dict]] = []


def run_tool(name: str, args: dict) -> dict:
    if name not in REGISTRY:
        return {"error": f"unknown tool '{name}'. Available: {list(REGISTRY)}"}
    try:
        check(ROLE, name)
    except AccessDenied as exc:
        audit("ops-agent", "access_denied", {"tool": name, "role": ROLE,
                                             "reason": str(exc)})
        return {"error": f"access error: {exc}"}
    t0 = time.time()
    try:
        result = REGISTRY[name]["fn"](**args)
    except TypeError as exc:
        return {"error": f"bad args for {name}: {exc}"}
    except Exception as exc:
        result = {"error": f"{type(exc).__name__}: {exc}"}
    audit("ops-agent", "tool_call",
          {"tool": name, "args": args, "ok": "error" not in result,
           "ms": int((time.time() - t0) * 1000)})
    RESULTS.append((name, result))
    return result
