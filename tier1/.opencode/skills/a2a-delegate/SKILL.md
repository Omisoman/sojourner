---
name: a2a-delegate
description: Hand committed work to the tier-2 ops agent over A2A (build, validate, evaluate, deploy)
summary: "Preflight, commit, then call a2a_delegate with a skill (build, validate, evaluate, deploy, notify), a summary and optional detail. A deploy always parks at input-required for a human; an access-denied result is reported verbatim, never retried around."
---

# a2a-delegate

Delegating to tier-2 (the only path to Gitea, the database, staging and
notifications — tier-1 holds none of those credentials or routes).

1. Preflight FIRST: `uv run pytest -q` and `uv run lint-imports`. Never
   delegate red code.
2. COMMIT your work. The tool sends a git patch of the commits since
   `sojourner-base`; a dirty work tree is refused and an empty range has
   nothing to send. What crosses the tier boundary is that patch and its
   sha256 — no shared volume, no git remote, no credentials.
3. Call the `a2a_delegate` tool:
   - `skill`: `build` | `validate` | `evaluate` | `deploy` | `notify`
     - `build` — `uv sync --frozen` + `pytest` on a clean copy
     - `validate` — import-linter, knowledge-base dry run, and
       `tests/test_validation.py` + `tests/test_views.py` against the farm database
     - `evaluate` — the question-set scorecard on `llama3.1:8b`
     - `deploy` — all of the above, then a human approval, then staging
   - `summary`: one conventional-commit line describing the change
   - `detail`: optional context the ops agent needs
4. States stream back: `submitted → working → …`. A `deploy` ALWAYS parks at
   `input-required` — that is the human approval gate, not an error. Tell the
   operator the exact approval command the tool returns.
5. After `completed`, report PR link, build/validation results, the
   question-set pass rate, the staging URL and the audit ids from the
   artifacts.
6. An access-denied result (`rules: role … denied tool …`) means the role is
   not allowed that tool — report it verbatim; never retry around the rules.

Tier-2 resets its tree to `sojourner-base` and replays the patch on every
request, so re-requesting after a fix is safe: it never stacks on a previous
attempt.
