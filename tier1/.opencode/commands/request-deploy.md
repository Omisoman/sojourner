---
description: Request an approval-gated staging deploy via tier-2
summary: "Run the tests and /arch-check, commit, then send the patch of commits since sojourner-base to tier-2 with a2a_delegate. The task parks at input-required until an operator approves; afterwards it reports the PR, the scorecard, the staging URL and the deploy's audit event."
---

Deploy your committed work in /workspace/project to staging via the tier-2 ops
agent. You have no deploy or Gitea credentials — the a2a_delegate tool is the
only path, and deploys block on human approval by the access rules.

Do every step below YOURSELF, NOW, in this turn — never hand a step back to the
operator and never ask for confirmation. If the work is already committed, skip
the commit and go straight to the a2a_delegate call.

1. Preflight locally: `uv run pytest -q` and `uv run lint-imports`. Abort on
   failure — do not delegate broken code.
2. COMMIT the change. `a2a_delegate` builds the patch from commits since
   `sojourner-base`, so uncommitted work is refused and nothing would be
   deployed:
   - `git add -A && git commit -m "<conventional-commit subject>"`
   - one imperative subject line, ≤ 72 chars, no AI attribution.
3. Call the `a2a_delegate` tool with:
   `{"skill": "deploy", "summary": "<that commit subject>", "detail": $ARGUMENTS}`
   The tool attaches the patch, its sha256 and the diffstat — report the
   diffstat it prints so the operator sees exactly what is crossing over.
4. Stream the task states as they arrive (submitted → working →
   input-required). When it reaches `input-required`, tell the operator:
   "approval required — approve in the tier-2 console (ALERTS → Approvals &
   Requests), or run: docker exec sojourner-tier2 /opt/venv/bin/python
   /opt/sojourner/tier2/approve.py <task_id>".
5. After completion, report: PR link, build and validation result, the
   question-set pass rate against its threshold, the staging URL
   (http://localhost:8080) and the audit hash of the deploy event — the same
   deploy the app's Changes page now lists.
