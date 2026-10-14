---
description: Show Sojourner commands and how deploy approval works
summary: "Print the Sojourner command sheet: /arch-check, /request-deploy, /approve, the commit-first rule, the approval command, the staging URL and the Changes page. Calls no tools."
---

Reply with exactly the text between the two marker lines, as one fenced code
block. Do not call tools, do not add a preamble or anything after it.

-----8<-----
/arch-check      import contracts (shared ⟂ app, views ⟂ views)
/request-deploy  commit -> patch -> build -> validate -> evaluate -> deploy (gated)
/approve         operator: approve a waiting task

Commit first: the patch sent to ops is built from commits since
sojourner-base, and a dirty work tree is refused.

Deploys stop at input-required until an operator runs:
  docker exec sojourner-tier2 /opt/venv/bin/python /opt/sojourner/tier2/approve.py <task_id>

Approved deploys serve at http://localhost:8080 — the Farm app, its
database and the same audit chain; the deploy shows on its Changes page.
-----8<-----
