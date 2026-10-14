---
title: Release playbook
subtitle: new-horizons
summary: "Tier-1 cannot deploy: commit, /request-deploy, and tier-2 replays the patch, opens the PR, builds, validates and scores the question set, then stops for a human approval before the staging deploy. The approved deploy is one audit event — it appears on the app's Changes page."
owner: platform
version: "1.0"
---

# Release playbook — new-horizons

## Path to staging (the only path)

Tier-1 cannot deploy. The pipeline is tier-2's, over A2A, rules-gated:

```
commit your work        (the patch is built from commits, never a dirty tree)
/request-deploy
  → a2a_delegate        attaches `git format-patch sojourner-base..HEAD` + sha256
  → tier-2: replay      reset to sojourner-base, `git am` the patch (in code,
                        not by the model); a mismatched sha256 is refused
  → tier-2: gitea_pr    branch + PR carrying the real changed files
  → tier-2: build_run   `uv sync --frozen` + `pytest`
  → tier-2: validate_run import-linter + knowledge-base dry run +
                        tests/test_validation.py + tests/test_views.py
                        (every page, EN + AR, on the farm database)
  → tier-2: evaluate_run the question set (docs/question-set.yaml) on
                        llama3.1:8b; pass rate ≥ evaluation.min_pass_rate
  → BLOCKS: input-required  (human approval — the tier-2 console, or
                             approve.py <task_id>)
  → tier-2: deploy_staging  the app to the staging Streamlit, then ONE audit
                            event: source sojourner, kind deploy
  → tier-2: notify          (ntfy topic sojourner-ops)
```

The deployed app is at `http://localhost:8080` on the demo machine; the same
deploy is listed on its Changes page.

## Rules

- Commit before delegating. `a2a_delegate` refuses a dirty work tree, and an
  empty commit range has nothing to send.
- A failed build, validation or evaluation aborts the task — fix, commit,
  re-request. Tier-2 resets to `sojourner-base` each time, so a retry never
  stacks on the failed attempt.
- The approval gate is a human decision by design. Do not automate it, do not
  retry into it.
- Every transition is in the audit chain, including `patch_applied` with the
  patch sha256 and the files it touched. Quote task id + audit hash in the
  release note.

## The evaluation gate

The question set is 26 questions (13 English, 13 Arabic). Each passes when
its language, its figures and its citation are right. A change that breaks a
known question's resolver, an intent's paraphrases or a citation key fails
here even when every unit test is green — run the affected questions locally
with `uv run python scripts/question-bank.py --set docs/question-set.yaml
--only S04` where the model is reachable.

## Rollback

Staging keeps the previous app tree. Rollback = ops restores it — request it
via `a2a_delegate` with skill `deploy` and summary `rollback: <reason>`. A
request with no patch redeploys the baseline tree.

## Data changes

The farm database is shared with the host app and the audit chain is append
only. A change to the generator, `profile.yaml` or the schema regenerates
every expected figure: say so in the PR body and flag it for the reviewer —
the deploy itself never rewrites the database.

## Smoke checklist

Before approval, validate has already rendered every page in English and
Arabic on the shared database (tests/test_views.py). After it, deploy_staging
waits until staging serves the NEW deploy stamp and answers its health check;
then the Changes page lists the deploy that was just approved — that last
check is what proves the deploy carried the new code and wrote its audit event.
